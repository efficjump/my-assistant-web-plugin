import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { access, chmod, mkdtemp, readFile, readdir, rm, writeFile, cp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createCompanionServer } from "../bridge/server.mjs";

class CdpClient {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new CdpClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id || !this.pending.has(message.id)) {
        return;
      }
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        reject(new Error(`${message.error.message}: ${message.error.data || ""}`));
      } else {
        resolve(message.result || {});
      }
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) {
      message.sessionId = sessionId;
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(message));
    });
  }

  close() {
    this.socket.close();
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chromePath = await resolveChromePath();
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "my-assistant-extension-e2e-"));
const extensionRoot = path.join(temporaryRoot, "extension");
const profileRoot = path.join(temporaryRoot, "profile");
let browserProcess;
let server;
let frameServer;
let companion;
let mcpClient;
let visualAiCallCounts = { intent: 0, locator: 0, verifier: 0, imageInputs: 0 };

const silentLogger = Object.freeze({
  debug() {},
  error() {},
  info() {},
  log() {},
  warn() {},
});

try {
  const extensionId = await prepareTestExtension();
  const origin = await startFixtureServer();
  browserProcess = spawn(chromePath, [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    `--user-data-dir=${profileRoot}`,
    `--disable-extensions-except=${extensionRoot}`,
    `--load-extension=${extensionRoot}`,
    "--remote-debugging-port=0",
    "about:blank"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const debugPort = await readDebugPort(profileRoot);
  const version = await waitForJson(`http://127.0.0.1:${debugPort}/json/version`);
  const cdp = await CdpClient.connect(version.webSocketDebuggerUrl);

  try {
    const firstTargetId = await createPage(cdp, `${origin}/page-a`);
    const panelTargetId = await createPage(cdp, `chrome-extension://${extensionId}/panel.html`);
    const panelSessionId = await attach(cdp, panelTargetId);
    await waitForReady(cdp, panelSessionId);
    await waitForTarget(cdp, (target) => (
      target.type === "service_worker" && target.url === `chrome-extension://${extensionId}/background.js`
    ));
    const firstTabId = await queryTabId(cdp, panelSessionId, `${origin}/page-a`);

    const panelTabContract = await evaluate(cdp, panelSessionId, `(async () => {
      const panelTab = await chrome.tabs.getCurrent();
      const targetTab = await chrome.tabs.get(${JSON.stringify(firstTabId)});
      const url = new URL(location.href);
      url.searchParams.set("targetTabId", String(targetTab.id));
      url.searchParams.set("windowId", String(targetTab.windowId));
      history.replaceState(null, "", url.toString());
      const stored = await chrome.storage.local.get("settings");
      await chrome.storage.local.set({
        settings: { ...(stored.settings || {}), panelOpenMode: "tab" }
      });
      return { panelTabId: panelTab.id, panelUrl: url.toString(), originalSettings: stored.settings || {} };
    })()`);
    const tabPresentation = await poll(
      async () => extensionMessage(cdp, panelSessionId, { type: "GET_PANEL_PRESENTATION" }),
      (response) => response?.ok && response.data.openMode === "tab",
      5_000
    );
    assert.equal(tabPresentation.data.tabSupported, true);
    const reusedPanelTab = await extensionMessage(cdp, panelSessionId, {
      type: "OPEN_PANEL_TAB",
      targetTabId: firstTabId
    });
    assert.equal(reusedPanelTab.ok, true);
    assert.equal(reusedPanelTab.data.id, panelTabContract.panelTabId);
    const openPanelTabs = await evaluate(cdp, panelSessionId, `(async () => {
      const tabs = await chrome.tabs.query({});
      return tabs.filter((tab) => String(tab.url || tab.pendingUrl || "").startsWith(chrome.runtime.getURL("panel.html"))).length;
    })()`);
    assert.equal(openPanelTabs, 1, "tab mode should reuse one panel tab in the browser window");
    await evaluate(cdp, panelSessionId, `chrome.storage.local.set({
      settings: { ...${JSON.stringify(panelTabContract.originalSettings)}, panelOpenMode: "side-panel" }
    })`);
    const sidePresentation = await poll(
      async () => extensionMessage(cdp, panelSessionId, { type: "GET_PANEL_PRESENTATION" }),
      (response) => response?.ok && response.data.openMode === "side-panel",
      5_000
    );
    assert.equal(sidePresentation.data.sidePanelSupported, true);

    const aiResponse = await extensionMessage(cdp, panelSessionId, {
      type: "CALL_AI",
      settings: {
        apiProfile: "openai-responses",
        apiEndpoint: `${origin}/mock-ai`,
        model: "e2e-model",
        maxApiRetries: 0
      },
      request: {
        requestId: "e2e-ai-success",
        taskType: "e2e-audit",
        system: "Return a short confirmation.",
        user: "Confirm the audit path.",
        screenshotDataUrl: ""
      }
    });
    assert.equal(aiResponse.ok, true);
    assert.equal(aiResponse.data.text, "Audit path works.");
    assert.equal(aiResponse.data.audit.outcome, "success");
    assert.equal(aiResponse.data.audit.usage.totalTokens, 16);
    assert.equal(aiResponse.data.audit.responseId, "resp-e2e");

    const emptyAiResponse = await extensionMessage(cdp, panelSessionId, {
      type: "CALL_AI",
      settings: {
        apiProfile: "openai-responses",
        apiEndpoint: `${origin}/mock-empty-ai`,
        model: "e2e-model",
        maxApiRetries: 0
      },
      request: {
        requestId: "e2e-ai-empty",
        taskType: "e2e-empty-audit",
        system: "Return a short confirmation.",
        user: "Return output.",
        screenshotDataUrl: ""
      }
    });
    assert.equal(emptyAiResponse.ok, false);
    assert.equal(emptyAiResponse.error.name, "EmptyAiResponseError");
    assert.equal(emptyAiResponse.error.audit.outcome, "empty_response");
    assert.equal(emptyAiResponse.error.audit.emptyOutput, true);
    const exportedAudit = await evaluate(cdp, panelSessionId, `(() => {
      appendAiRequestAudit(${JSON.stringify(aiResponse.data.audit)}, { purpose: "e2e-success" });
      const emptyError = new Error("raw provider detail must not be stored");
      emptyError.name = "EmptyAiResponseError";
      appendAiRequestAudit(${JSON.stringify(emptyAiResponse.error.audit)}, {
        purpose: "e2e-empty",
        error: emptyError
      });
      const bundle = buildExportBundle();
      return {
        usage: bundle.aiUsage,
        markdown: buildMarkdownExport(bundle),
        lastAudit: bundle.evaluationLogs.at(-1)
      };
    })()`);
    assert.equal(exportedAudit.usage.requestCount, 2);
    assert.equal(exportedAudit.usage.successCount, 1);
    assert.equal(exportedAudit.usage.failureCount, 1);
    assert.equal(exportedAudit.usage.emptyResponseCount, 1);
    assert.equal(exportedAudit.usage.totalTokens, 25);
    assert.match(exportedAudit.markdown, /## AI Usage/);
    assert.doesNotMatch(JSON.stringify(exportedAudit.lastAudit), /raw provider detail/);

    const firstContext = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: { maxTextChars: 8000, maxElements: 40, redactSensitiveData: true }
    });
    assert.equal(firstContext.ok, true);
    assert.match(firstContext.data.documentId, /^[0-9a-z-]{8,}$/i);
    assert.equal(firstContext.data.observationScope.kind, "visual-viewport");
    assert.doesNotMatch(firstContext.data.visibleText, /Hidden DOM fact|Clipped action|Covered action|Offscreen viewport fact/);
    assert.doesNotMatch(
      firstContext.data.visibleText,
      /Hidden cross-frame fact|Hidden cross-frame action|Covered cross-frame fact|Covered cross-frame action/
    );
    assert.match(firstContext.data.visibleText, /Cross frame ready/);
    assert.doesNotMatch(firstContext.data.documentTextExcerpt, /Hidden DOM fact|Offscreen viewport fact/);
    assert.match(firstContext.data.visibleText, /Display contents direct visible fact/);
    assert.equal(firstContext.data.interactiveElementStats.included, firstContext.data.interactiveElements.length);
    assert.ok(firstContext.data.interactiveElementStats.total >= firstContext.data.interactiveElementStats.included);
    assert.equal(
      firstContext.data.interactiveElementStats.truncated,
      firstContext.data.interactiveElementStats.total > firstContext.data.interactiveElementStats.included
    );
    assert.equal(
      firstContext.data.iframes.find((iframe) => iframe.title === "Same-origin frame")?.contentAccess,
      "same-origin"
    );
    assert.equal(
      firstContext.data.iframes.find((iframe) => iframe.title === "Metadata-only frame")?.contentAccess,
      "metadata-only"
    );
    assert.ok(firstContext.data.automationCapabilities.frames.visuallyVerified >= 3);
    assert.equal(
      firstContext.data.interactiveElements.some((element) => /Covered action|Clipped action|Offscreen action/.test(element.label || "")),
      false
    );
    assert.ok(firstContext.data.collectionDiagnostics.wallDurationMs >= 0);
    assert.ok(firstContext.data.collectionDiagnostics.phaseDurationsMs.interactiveElements >= 0);
    assert.ok(firstContext.data.collectionDiagnostics.cacheHits.style > 0);
    const observationProbe = await extensionMessage(cdp, panelSessionId, {
      type: "VERIFY_PAGE_OBSERVATION",
      targetTabId: firstTabId
    });
    assert.equal(observationProbe.ok, true);
    assert.equal(
      observationProbe.data.frames.find((frame) => frame.frameId === 0)?.matchesBaseline,
      true
    );
    const settleStartedAt = performance.now();
    const settledPage = await extensionMessage(cdp, panelSessionId, {
      type: "WAIT_FOR_PAGE_SETTLE",
      targetTabId: firstTabId,
      options: { quietMs: 80, timeoutMs: 1000 }
    });
    const settleElapsedMs = performance.now() - settleStartedAt;
    assert.equal(settledPage.ok, true);
    assert.equal(settledPage.data.settled, true);
    assert.equal(settledPage.data.timedOut, false);
    assert.ok(settledPage.data.stableForMs >= 80);
    assert.ok(
      settledPage.data.contentElapsedMs < 1500,
      `an already-stable page should settle without an unbounded content wait: ${settledPage.data.contentElapsedMs}ms`
    );
    assert.ok(
      settleElapsedMs < 3000,
      `the extension round trip should remain bounded around the settle timeout: ${Math.round(settleElapsedMs)}ms`
    );
    const navigationTargetUrl = `${origin}/page-a?navigation-source=1`;
    const navigationTargetId = await createPage(cdp, navigationTargetUrl);
    try {
      const navigationSessionId = await attach(cdp, navigationTargetId);
      await evaluate(cdp, navigationSessionId, `(() => {
        const button = document.createElement("button");
        button.id = "document-navigation-action";
        button.type = "button";
        button.textContent = "Document navigation action";
        Object.assign(button.style, {
          position: "fixed",
          left: "12px",
          top: "320px",
          zIndex: "2147483000"
        });
        button.addEventListener("click", () => {
          location.assign(${JSON.stringify(`${origin}/page-b?navigation-interrupt=1`)});
        });
        document.body.append(button);
        return true;
      })()`);
      const navigationTabId = await queryTabId(cdp, panelSessionId, navigationTargetUrl);
      const navigationContext = await extensionMessage(cdp, panelSessionId, {
        type: "COLLECT_PAGE_CONTEXT",
        targetTabId: navigationTabId,
        options: {
          maxTextChars: 4000,
          maxElements: 20,
          elementQuery: "Document navigation action",
          redactSensitiveData: true
        }
      });
      const navigationTarget = navigationContext.data.interactiveElements.find(
        (element) => element.label === "Document navigation action"
      );
      assert.ok(navigationTarget?.ref);
      const interruptedNavigation = await extensionMessage(cdp, panelSessionId, {
        type: "EXECUTE_PAGE_ACTIONS",
        targetTabId: navigationTabId,
        actions: [{
          id: "document-navigation",
          type: "click",
          ref: navigationTarget.ref,
          reason: "exercise document replacement before the content response returns"
        }]
      });
      assert.equal(interruptedNavigation.ok, true);
      assert.equal(interruptedNavigation.data.results[0].ok, true);
      if (interruptedNavigation.data.results[0].result.responseInterruptedByNavigation) {
        assert.equal(interruptedNavigation.data.results[0].verification.documentChanged, true);
      }
      const navigationSettled = await extensionMessage(cdp, panelSessionId, {
        type: "WAIT_FOR_PAGE_SETTLE",
        targetTabId: navigationTabId,
        options: { quietMs: 80, timeoutMs: 1200 }
      });
      assert.equal(navigationSettled.ok, true);
      const navigatedContext = await extensionMessage(cdp, panelSessionId, {
        type: "COLLECT_PAGE_CONTEXT",
        targetTabId: navigationTabId,
        options: { maxTextChars: 4000, maxElements: 20, redactSensitiveData: true }
      });
      assert.equal(new URL(navigatedContext.data.url).pathname, "/page-b");
      await evaluate(cdp, navigationSessionId, `(() => {
        const menuItem = document.createElement("li");
        menuItem.setAttribute("role", "menuitem");
        Object.assign(menuItem.style, {
          position: "fixed",
          left: "210px",
          top: "320px",
          zIndex: "2147483000"
        });
        const menuLink = document.createElement("a");
        menuLink.href = ${JSON.stringify(`${origin}/page-a?composite-navigation=1`)};
        menuLink.textContent = "Composite navigation link";
        menuLink.style.pointerEvents = "none";
        menuItem.append(menuLink);
        document.body.append(menuItem);
        return true;
      })()`);
      const compositeContext = await extensionMessage(cdp, panelSessionId, {
        type: "COLLECT_PAGE_CONTEXT",
        targetTabId: navigationTabId,
        options: {
          maxTextChars: 4000,
          maxElements: 20,
          elementQuery: "Composite navigation link",
          redactSensitiveData: true
        }
      });
      const compositeTarget = compositeContext.data.interactiveElements.find(
        (element) => element.label === "Composite navigation link"
      );
      assert.equal(compositeTarget?.tag, "li");
      assert.equal(compositeTarget.activationTag, "a");
      assert.equal(new URL(compositeTarget.href).pathname, "/page-a");
      const compositeNavigation = await extensionMessage(cdp, panelSessionId, {
        type: "EXECUTE_PAGE_ACTIONS",
        targetTabId: navigationTabId,
        actions: [{
          id: "composite-navigation",
          type: "click",
          ref: compositeTarget.ref,
          reason: "exercise a visible semantic menu item with one nested navigation link"
        }]
      });
      assert.equal(compositeNavigation.ok, true);
      assert.equal(compositeNavigation.data.results[0].ok, true);
      assert.equal(compositeNavigation.data.results[0].result.mayNavigate, true);
      const compositeSettled = await extensionMessage(cdp, panelSessionId, {
        type: "WAIT_FOR_PAGE_SETTLE",
        targetTabId: navigationTabId,
        options: { quietMs: 80, timeoutMs: 1200 }
      });
      assert.equal(compositeSettled.ok, true);
      const compositeNavigatedContext = await poll(
        async () => {
          const response = await extensionMessage(cdp, panelSessionId, {
            type: "COLLECT_PAGE_CONTEXT",
            targetTabId: navigationTabId,
            options: { maxTextChars: 4000, maxElements: 20, redactSensitiveData: true }
          });
          return response.data;
        },
        (context) => new URL(context.url).pathname === "/page-a",
        5000
      );
      assert.equal(new URL(compositeNavigatedContext.url).pathname, "/page-a");
    } finally {
      await cdp.send("Target.closeTarget", { targetId: navigationTargetId }).catch(() => {});
    }

    const frameAccessStartedAt = performance.now();
    const frameAccess = await extensionMessage(cdp, panelSessionId, {
      type: "GET_FRAME_ORIGINS",
      targetTabId: firstTabId
    });
    const frameAccessElapsedMs = performance.now() - frameAccessStartedAt;
    assert.equal(frameAccess.ok, true);
    assert.ok(frameAccess.data.visibleFrameCount >= 1);
    assert.ok(
      frameAccessElapsedMs < 3000,
      `frame-origin discovery should stay on the lightweight boundary path: ${Math.round(frameAccessElapsedMs)}ms`
    );

    await evaluate(cdp, panelSessionId, `(async () => {
      await chrome.scripting.executeScript({
        target: { tabId: ${JSON.stringify(firstTabId)} },
        func: () => {
          const fixture = document.createElement("div");
          fixture.id = "large-dom-fixture";
          const action = document.createElement("button");
          action.type = "button";
          action.textContent = "Large DOM action";
          action.style.position = "fixed";
          action.style.left = "12px";
          action.style.top = "170px";
          action.style.zIndex = "10";
          fixture.append(action);
          const fragment = document.createDocumentFragment();
          for (let index = 0; index < 8000; index += 1) {
            const record = document.createElement("div");
            record.textContent = \`Record \${index + 1} Value \${index + 1}\`;
            fragment.append(record);
          }
          fixture.append(fragment);
          document.body.append(fixture);
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
    })()`);
    const largeDomStartedAt = performance.now();
    const largeDomContext = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: { maxTextChars: 8000, maxElements: 40, redactSensitiveData: true }
    });
    const largeDomElapsedMs = performance.now() - largeDomStartedAt;
    assert.equal(largeDomContext.ok, true);
    assert.ok(
      largeDomContext.data.interactiveElements.some((element) => element.label === "Large DOM action"),
      "a control must remain discoverable without scanning rules tailored to the fixture"
    );
    assert.ok(largeDomContext.data.collectionDiagnostics.scannedElementCount >= 8000);
    assert.ok(largeDomContext.data.collectionDiagnostics.cacheHits.rect > 0);
    assert.ok(
      largeDomElapsedMs < 3000,
      `large visible-page observation exceeded the bounded performance budget: ${Math.round(largeDomElapsedMs)}ms`
    );
    process.stdout.write(`Large DOM context collection: ${Math.round(largeDomElapsedMs)}ms\n`);
    await evaluate(cdp, panelSessionId, `(async () => {
      await chrome.scripting.executeScript({
        target: { tabId: ${JSON.stringify(firstTabId)} },
        func: () => document.querySelector("#large-dom-fixture")?.remove()
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
    })()`);

    const panelContracts = await exercisePanelContracts({
      cdp,
      panelSessionId,
      tabId: firstTabId,
      context: firstContext.data
    });
    assert.deepEqual(
      panelContracts.layouts.map(({ width, height }) => ({ width, height })),
      [
        { width: 420, height: 600 },
        { width: 360, height: 640 },
        { width: 300, height: 640 },
        { width: 240, height: 600 }
      ]
    );
    for (const layout of panelContracts.layouts) {
      const viewportLabel = `${layout.width}x${layout.height}`;
      assert.equal(layout.documentOverflow, false, `${viewportLabel} document should not overflow`);
      assert.ok(layout.topbarHeight <= 50, `${viewportLabel} topbar was ${layout.topbarHeight}px tall`);
      assert.ok(layout.composerHeight <= 110, `${viewportLabel} composer was ${layout.composerHeight}px tall`);
      assert.ok(layout.chatHeight >= 120, `${viewportLabel} conversation viewport was only ${layout.chatHeight}px tall`);
      assert.ok(
        layout.activityDockHeight >= 50 && layout.activityDockHeight <= 74,
        `${viewportLabel} task-flow dock was ${layout.activityDockHeight}px tall`
      );
      assert.equal(layout.activityDockCardCount, 1, `${viewportLabel} should render one task-flow dock card`);
      assert.equal(layout.activityDockCollapsed, true, `${viewportLabel} task-flow details should start collapsed`);
      assert.equal(
        layout.activityDockNoHorizontalOverflow,
        true,
        `${viewportLabel} task-flow dock should not overflow horizontally`
      );
      assert.ok(layout.externalApprovalHeight >= 120, `${viewportLabel} approval viewport was only ${layout.externalApprovalHeight}px tall`);
      assert.equal(layout.composerVisible, true, `${viewportLabel} composer should remain available for external approval`);
      assert.equal(layout.composerInputSingleRow, true, `${viewportLabel} composer input and send control should share a row`);
      assert.equal(layout.templatePopoverClosed, true);
      assert.equal(layout.externalPickerHidden, true, "a single external approval does not need a request picker");
      assert.equal(layout.settingsTabsSingleRow, true, `${viewportLabel} settings tabs should stay on one row`);
      assert.equal(layout.settingsTabsScrollable, true, `${viewportLabel} settings tabs should allow horizontal scrolling`);
      assert.equal(layout.generalPanelNoHorizontalOverflow, true, `${viewportLabel} settings overview should not overflow horizontally`);
      assert.equal(layout.settingsSummaryColumnCount, 1, `${viewportLabel} settings summary should use one readable column`);
      assert.equal(layout.settingsGearVisible, true, `${viewportLabel} settings should retain the gear icon`);
      assert.equal(layout.bridgePanelNoHorizontalOverflow, true, `${viewportLabel} Bridge panel should not overflow horizontally`);
      assert.equal(layout.bridgeActionsNoHorizontalOverflow, true, `${viewportLabel} Bridge actions should wrap without horizontal overflow`);
      assert.equal(layout.narrowStress.topbarActionCount, 3, `${viewportLabel} should expose three primary topbar actions`);
      for (const [controlName, measurement] of Object.entries(layout.narrowStress.controls)) {
        assert.equal(
          measurement.inViewport,
          true,
          `${viewportLabel} ${controlName} escaped the viewport: ${JSON.stringify(measurement.rect)}`
        );
      }
      for (const [containerName, measurement] of Object.entries(layout.narrowStress.containers)) {
        assert.equal(
          measurement.noHorizontalOverflow,
          true,
          `${viewportLabel} ${containerName} overflowed horizontally: ${JSON.stringify(measurement)}`
        );
      }
    }
    assert.equal(panelContracts.approvalModes.local.composerHidden, true);
    assert.equal(panelContracts.approvalModes.local.approvalStackVisible, true);
    assert.equal(panelContracts.approvalModes.local.approvalPanelFocused, true);
    assert.equal(panelContracts.approvalModes.local.approvalControlsVisible, true);
    assert.equal(panelContracts.approvalModes.local.annotationHidden, true);
    assert.equal(panelContracts.approvalModes.local.annotationSourcePresent, false);
    assert.equal(panelContracts.approvalModes.local.documentOverflow, false);
    assert.deepEqual(panelContracts.approvalModes.afterReject, {
      chatInputFocused: true,
      draftPreserved: true,
      composerVisible: true
    });
    assert.deepEqual(panelContracts.approvalModes.externalOnly, {
      composerVisible: true,
      pickerHidden: true,
      requestCount: 1
    });
    assert.deepEqual(panelContracts.approvalModes.multipleExternal, {
      pickerVisible: true,
      requestCount: 2,
      selectedActionCount: 1
    });
    assert.match(panelContracts.template.createdTemplateId, /^custom-/);
    assert.equal(panelContracts.template.savedCountAfterCreate, 1);
    assert.equal(panelContracts.template.updatedInPlace, true);
    assert.equal(panelContracts.template.deleteNeedsConfirmation, true);
    assert.equal(panelContracts.template.customDeleted, true);
    assert.equal(panelContracts.template.builtInCustomized, true);
    assert.equal(panelContracts.template.builtInRestoreNeedsConfirmation, true);
    assert.equal(panelContracts.template.builtInRestored, true);
    assert.equal(panelContracts.template.maxLimitPreserved, true);
    assert.equal(panelContracts.template.importedCurrentInput, true);
    assert.equal(panelContracts.template.preservedDraft, true);
    assert.equal(panelContracts.template.insertedPrompt, true);
    assert.equal(panelContracts.template.popoverClosedAfterInsert, true);
    assert.deepEqual(panelContracts.site, {
      target: "https://example.test 사이트별 설정",
      agentMode: "approve",
      includeScreenshot: false,
      mcpEnabled: false,
      agentModeField: "inherit",
      screenshotField: "off",
      mcpField: "inherit"
    });
    assert.deepEqual(panelContracts.locale, {
      english: {
        lang: "en",
        preference: "en",
        storedPreference: "en",
        settingsTitle: "Settings",
        generalTab: "General",
        composerPlaceholder: "What would you like to do?",
        builtInTemplateTitle: "Summarize page",
        builtInTemplatePrompt: "Summarize the key points of the current page in a structured way.",
        personalTemplateTitle: "설정",
        personalTemplatePrompt: "완료",
        personalTemplateOption: "설정",
        runtimeStatus: "Turn 3 · observing page",
        contextStatus: "Reading the current page.",
        timelineTitle: "Task flow",
        timelinePhase: "Page observation",
        timelineDetail: "Turn 3 · observing page",
        timelineTaskPreserved: true,
        timelineDockVisible: true,
        timelineDockCardCount: 1,
        timelineDetachedFromConversation: true,
        timelineCollapsed: true,
        pageTitlePreserved: true,
        userMessage: "이전 대화 1: 승인 화면에서도 확인해야 하는 내용입니다.",
        systemMessage: "Settings saved.",
        composerValuePreserved: true
      },
      korean: {
        lang: "ko",
        settingsTitle: "설정",
        systemMessage: "설정이 저장되었습니다.",
        builtInTemplateTitle: "페이지 요약",
        runtimeStatus: "3번째 턴 · 화면 관찰 중",
        contextStatus: "현재 화면을 읽는 중입니다.",
        timelineTitle: "작업 흐름",
        timelinePhase: "화면 관찰",
        timelineDetail: "3번째 턴 화면 관찰 중"
      }
    });
    assert.deepEqual(panelContracts.markdown, {
      bodyClass: true,
      headings: ["렌더링 상태", "세부 표현"],
      strongText: "굵게",
      emphasisText: "기울임",
      deletedText: "취소선",
      escapedAndDecodedText: true,
      entitySourceHidden: true,
      escapedHtmlVisible: true,
      lineBreaks: 2,
      orderedStart: 3,
      nestedListText: "중첩 목록",
      tableCount: 1,
      tableHeaders: ["항목", "결과"],
      tableCells: ["표", "완료"],
      sourceDelimiterVisible: false,
      listStrongText: "굵은 목록",
      checkedTaskDisabled: true,
      checkedTaskText: "확인 완료",
      checkedTaskLabel: "확인 완료",
      quote: "전체 테두리 인용",
      horizontalRules: 1,
      inlineCode: "inline",
      blockCode: "const value = '<script>unsafe()</script>';",
      blockCodeFocusable: true,
      safeLinkHref: "https://example.test/docs",
      relativeLinkPath: "/relative-docs",
      automaticLinkHref: "https://example.test/auto",
      referenceLinkHref: "https://example.test/reference",
      unsafeLinkAnchors: 0,
      unsafeLinkText: "위험한 링크",
      fetchedImages: 0,
      remoteImageLink: "https://example.test/image.png",
      rawHtmlVisible: true,
      scripts: 0,
      executionProbe: false,
      tableRegionFocusable: true,
      userSourceText: "**사용자 원문은 그대로**",
      userMarkdownElements: 0
    });
    if (process.argv.includes("--capture-docs")) {
      await captureAgentPanelDocs(cdp, panelSessionId);
      await captureSettingsOverviewDocs(cdp, panelSessionId);
      await captureTemplateManagerDocs(cdp, panelSessionId);
    }

    const verificationContracts = await exerciseAgentVerificationContracts({
      cdp,
      panelSessionId,
      tabId: firstTabId,
      context: firstContext.data
    });
    assert.equal(verificationContracts.repairedStatus, "completed");
    assert.equal(verificationContracts.completionVerified, true);
    assert.equal(verificationContracts.terminalGroundingVerified, true);
    assert.equal(verificationContracts.terminalGroundingCombined, true);
    assert.equal(verificationContracts.completionVerifierSawTurnIntent, true);
    assert.equal(verificationContracts.groundingVerifierSawTurnIntent, true);
    assert.equal(verificationContracts.completionEvidenceBound, true);
    assert.equal(verificationContracts.completionEvidenceRepairSkipped, true);
    assert.equal(verificationContracts.completionEvidenceErrorHidden, true);
    assert.equal(verificationContracts.inventedCompletionEvidenceDiscarded, true);
    assert.equal(verificationContracts.promiseReplanOccurred, true);
    assert.equal(verificationContracts.promiseCompletionVerifierCalls, 2);
    assert.equal(verificationContracts.promiseUsedSeparateGroundingVerifier, false);
    assert.equal(verificationContracts.promiseFinalStatus, "completed");
    assert.match(verificationContracts.promiseFinalMessage, /다음과 같습니다/);
    assert.equal(verificationContracts.timelinePreservedEarlierAction, true);
    assert.equal(verificationContracts.timelineDockCardCount, 1);
    assert.equal(verificationContracts.timelineDetachedFromConversation, true);
    assert.equal(verificationContracts.successPayloadHiddenFromChat, true);
    assert.ok(
      verificationContracts.purposes.findIndex((purpose) => purpose === "answer-grounding-repair")
        < verificationContracts.purposes.findIndex((purpose) => purpose.startsWith("verifier-"))
    );
    assert.equal(verificationContracts.allVisualVerificationCallsReceivedScreenshot, true);
    assert.equal(verificationContracts.previousViewportEvidenceStatus, "rejected");
    assert.equal(verificationContracts.currentViewportEvidenceStatus, "verified");
    assert.equal(verificationContracts.previousCompletionEvidenceStatus, "rejected");
    assert.equal(verificationContracts.currentCompletionEvidenceStatus, "verified");
    assert.equal(verificationContracts.earlierEffectEvidenceRetained, true);
    assert.equal(verificationContracts.onlyCurrentViewportRetained, true);
    assert.equal(verificationContracts.staleVisualEvidenceExcluded, true);
    assert.equal(verificationContracts.toolOnlyCompletionVerifiedWithoutUnrelatedPage, true);
    assert.equal(verificationContracts.visualActionVerified, true);
    assert.equal(verificationContracts.visualActionRebound, true);
    assert.equal(verificationContracts.visualVerifierReceivedScreenshot, true);
    assert.equal(verificationContracts.visualActionRejectedClosed, true);

    const internalDiscovery = await exerciseInternalElementDiscoveryContract({
      cdp,
      panelSessionId,
      tabId: firstTabId,
      context: firstContext.data
    });
    assert.equal(internalDiscovery.decisionStatus, "continue");
    assert.equal(internalDiscovery.actionRef, "e1");
    assert.deepEqual(internalDiscovery.requestedCursors, ["", ""]);
    assert.deepEqual(internalDiscovery.requestedSearches, ["", "Dense grid next page"]);
    assert.deepEqual(internalDiscovery.boundObservationSearch, {
      query: "Dense grid next page",
      roles: ["button"],
      nearText: "Dense issue grid"
    });
    assert.equal(internalDiscovery.modelCalls, 2);
    assert.equal(internalDiscovery.mcpToolLoads, 1);
    assert.equal(internalDiscovery.mcpAssetLoads, 1);
    assert.equal(internalDiscovery.capabilityLoadsOverlappedObservation, true);
    assert.equal(internalDiscovery.userHandoffSuppressed, true);
    assert.equal(internalDiscovery.recoveryDecisionStatus, "continue");
    assert.equal(internalDiscovery.recoveryActionRef, "request-type-lookup");
    assert.deepEqual(internalDiscovery.recoveryPurposes, ["decision", "repair", "decision"]);
    assert.deepEqual(internalDiscovery.recoveryNearTexts, ["", "Request type"]);
    assert.equal(internalDiscovery.repeatedDisclosureWasNotReturned, true);
    assert.equal(internalDiscovery.genericContractFailureHidden, true);
    assert.equal(internalDiscovery.boundedDiscoveryStatus, "blocked");
    assert.match(internalDiscovery.boundedDiscoveryMessage, /아직 확인하지 못한 요소/);
    assert.equal(internalDiscovery.boundedDiscoveryWindows, 3);
    assert.equal(internalDiscovery.boundedDiscoveryLimit, 3);
    assert.equal(internalDiscovery.boundedDiscoveryObservationCalls, 3);
    assert.equal(internalDiscovery.boundedDiscoveryModelCalls, 3);

    const turnBoundaryContracts = await exerciseTurnBoundaryContracts({
      cdp,
      panelSessionId,
      tabId: firstTabId,
      context: firstContext.data
    });
    assert.equal(turnBoundaryContracts.freshIntentModelCalls, 1);
    assert.equal(turnBoundaryContracts.freshIntentMode, "standalone");
    assert.equal(turnBoundaryContracts.correctiveIntentMode, "continue_prior");
    assert.equal(turnBoundaryContracts.correctiveIntentModelCalls, 2);
    assert.equal(turnBoundaryContracts.correctiveIntentCarriedPriorRun, true);
    assert.equal(turnBoundaryContracts.correctiveIntentReplacedFailedTarget, true);
    assert.equal(turnBoundaryContracts.intentMode, "standalone");
    assert.equal(turnBoundaryContracts.intentRepeatPolicy, "once");
    assert.equal(turnBoundaryContracts.standaloneObjectiveStayedExact, true);
    assert.equal(turnBoundaryContracts.resolverSawFailedPriorRun, true);
    assert.equal(turnBoundaryContracts.plannerExcludedRawConversation, true);
    assert.equal(turnBoundaryContracts.plannerContextCompacted, true);
    assert.ok(
      turnBoundaryContracts.formattedPageContextChars
        < turnBoundaryContracts.rawPageContextChars
    );
    assert.equal(turnBoundaryContracts.malformedRawHidden, true);
    assert.equal(turnBoundaryContracts.internalJsonRejected, true);
    assert.equal(turnBoundaryContracts.staleElementSearchCleared, true);
    assert.equal(turnBoundaryContracts.repeatBlockedAfterOneSuccess, true);
    assert.equal(turnBoundaryContracts.disclosureRepeatBlockedWithoutMaterialProgress, true);
    assert.equal(turnBoundaryContracts.unchangedAttemptNotCountedAsSuccess, true);
    assert.equal(turnBoundaryContracts.unchangedAttemptRepeatBlocked, true);
    assert.equal(turnBoundaryContracts.indeterminateAttemptNotCountedAsSuccess, true);
    assert.equal(turnBoundaryContracts.indeterminateAttemptRepeatBlocked, true);
    assert.equal(turnBoundaryContracts.stateChangingToolRepeatBlocked, true);
    assert.equal(turnBoundaryContracts.readOnlyToolRepeatAllowed, true);
    assert.equal(turnBoundaryContracts.runtimeErrorStoppedSession, true);
    assert.equal(turnBoundaryContracts.runtimeErrorJsonHidden, true);
    assert.equal(turnBoundaryContracts.completionEvidenceDiagnosticHidden, true);
    assert.equal(turnBoundaryContracts.elementSearchDiagnosticHidden, true);
    assert.equal(turnBoundaryContracts.providerStatusErrorPreserved, true);

    const collectionLedgerContracts = await exerciseCollectionLedgerContracts({
      cdp,
      panelSessionId,
      tabId: firstTabId,
      context: firstContext.data
    });
    assert.deepEqual(collectionLedgerContracts, {
      firstPageCollected: true,
      requestedColumnsOnly: true,
      multipleTraversalBlocked: true,
      spaPaginationIsTransport: true,
      intermediatePageCannotBeSkipped: true,
      disclosureDoesNotRequestExtraction: true,
      plainScrollDoesNotRequestExtraction: true,
      virtualScrollRequestsExtraction: true,
      secondPageReachedExactTarget: true,
      thirdPageBlocked: true,
      terminalAnswerAllowed: true,
      repeatedPageStalled: true,
      zeroNewPageStalled: true
    });

    const workflowSetContracts = await exerciseWorkflowSetContracts({
      cdp,
      panelSessionId,
      tabId: firstTabId
    });
    assert.deepEqual(workflowSetContracts, {
      parametersResolved: true,
      outputContractPreserved: true,
      mismatchedIntentRejected: true,
      sequentialStepsCompleted: true,
      preSessionFailureTerminated: true,
      originDriftBlocked: true,
      busyStopDeferred: true
    });

    const latencyFastPaths = await exerciseLatencyFastPathContracts({
      cdp,
      panelSessionId,
      context: firstContext.data
    });
    assert.deepEqual(latencyFastPaths, {
      normalDomScreenshotSkipped: true,
      visualSurfaceScreenshotRetained: true,
      explicitScreenshotRetained: true,
      disabledScreenshotSkipped: true,
      disclosurePolicyAllowed: true,
      readOnlyPolicyAllowed: true,
      unresolvedClickNeedsPolicy: true
    });

    const loopRuntimeContracts = await exerciseLoopRuntimeContracts({
      cdp,
      panelSessionId,
      tabId: firstTabId,
      context: firstContext.data
    });
    assert.deepEqual(loopRuntimeContracts.verificationOnlyFlags, [false, true]);
    assert.equal(loopRuntimeContracts.executedEffects, 1);
    assert.equal(loopRuntimeContracts.finalStatus, "completed");
    assert.equal(loopRuntimeContracts.toolOnlySettleMessages, 0);
    assert.equal(loopRuntimeContracts.permanentRetryCalls, 1);
    assert.equal(loopRuntimeContracts.permanentRetryDelays, 0);
    assert.equal(loopRuntimeContracts.transientRetryCalls, 3);
    assert.deepEqual(loopRuntimeContracts.transientRetryDelays, [350, 700]);
    assert.equal(loopRuntimeContracts.exhaustedRetryCalls, 4);
    assert.deepEqual(loopRuntimeContracts.exhaustedRetryDelays, [350, 700, 1050]);
    assert.equal(loopRuntimeContracts.freshProbeReusedObservation, true);
    assert.equal(loopRuntimeContracts.freshProbeCollections, 0);
    assert.equal(loopRuntimeContracts.productionFinalVerificationOpened, true);
    assert.equal(loopRuntimeContracts.staleToolPreparationRejected, true);
    assert.equal(loopRuntimeContracts.staleToolPreparationCollections, 0);
    assert.equal(loopRuntimeContracts.staleToolPreparationUsedPlanningProbe, true);
    assert.equal(
      loopRuntimeContracts.stableToolPreparationAccepted,
      true,
      JSON.stringify(loopRuntimeContracts.stableToolPreparationDiagnostics)
    );
    assert.equal(loopRuntimeContracts.changedBrowserToolPreparationRejected, true);
    assert.equal(loopRuntimeContracts.changedVisualToolPreparationRejected, true);
    assert.equal(loopRuntimeContracts.changedVisualCaptureCalls, 1);

    const transitionContracts = await exerciseTabTransitionContracts({ cdp, panelSessionId });
    assert.equal(transitionContracts.preservedRunningSession, true);
    assert.equal(transitionContracts.deferredWhileBound, true);
    assert.equal(transitionContracts.resumedOnLatestTab, true);

    await evaluate(cdp, panelSessionId, `(async () => {
      await chrome.scripting.executeScript({
        target: { tabId: ${JSON.stringify(firstTabId)} },
        world: "MAIN",
        func: () => {
          const fixture = document.createElement("div");
          fixture.id = "stale-target-fixture";
          Object.assign(fixture.style, {
            position: "fixed",
            right: "8px",
            top: "8px",
            zIndex: "2147483000",
            display: "grid",
            gap: "4px",
            padding: "4px",
            background: "white"
          });
          const button = document.createElement("button");
          button.id = "stale-target-button";
          button.textContent = "Stale row A";
          button.addEventListener("click", () => {
            window.__staleTargetClickCount = (window.__staleTargetClickCount || 0) + 1;
          });
          const ambientButton = document.createElement("button");
          ambientButton.id = "ambient-churn-button";
          ambientButton.textContent = "Ambient churn";
          const ambientNode = document.createElement("span");
          ambientNode.id = "ambient-churn-node";
          ambientNode.hidden = true;
          ambientButton.addEventListener("click", () => {
            ambientNode.dataset.revision = String(Number(ambientNode.dataset.revision || 0) + 1);
          });
          const mutableCheckbox = document.createElement("input");
          mutableCheckbox.id = "mutable-state-checkbox";
          mutableCheckbox.type = "checkbox";
          mutableCheckbox.setAttribute("aria-label", "Mutable state checkbox");
          const pressTarget = document.createElement("button");
          pressTarget.id = "text-press-target";
          pressTarget.textContent = "Text press target";
          pressTarget.addEventListener("keydown", () => {
            window.__textPressTargetCount = (window.__textPressTargetCount || 0) + 1;
          });
          const pressDecoy = document.createElement("button");
          pressDecoy.id = "text-press-decoy";
          pressDecoy.textContent = "Text press decoy";
          pressDecoy.addEventListener("keydown", () => {
            window.__textPressDecoyCount = (window.__textPressDecoyCount || 0) + 1;
          });
          const raceOriginal = document.createElement("button");
          raceOriginal.id = "post-observation-race-original";
          raceOriginal.textContent = "Post observation race original";
          const raceDecoy = document.createElement("button");
          raceDecoy.id = "post-observation-race-decoy";
          raceDecoy.textContent = "Post observation race decoy";
          fixture.append(
            button,
            ambientButton,
            ambientNode,
            mutableCheckbox,
            pressTarget,
            pressDecoy,
            raceOriginal,
            raceDecoy
          );
          document.body.append(fixture);
          window.__staleTargetClickCount = 0;
          window.__textPressTargetCount = 0;
          window.__textPressDecoyCount = 0;
        }
      });
    })()`);
    const staleTargetContext = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: {
        maxTextChars: 4000,
        maxElements: 20,
        elementQuery: "Stale row A",
        elementRoles: ["button"],
        redactSensitiveData: true
      }
    });
    const staleTarget = staleTargetContext.data.interactiveElements.find(
      (element) => element.label === "Stale row A"
    );
    assert.ok(staleTarget?.ref);
    assert.match(staleTarget.binding, /^binding-v1-/);
    assert.match(staleTarget.stateBinding, /^state-v1-/);
    await evaluate(cdp, panelSessionId, `(async () => {
      await chrome.scripting.executeScript({
        target: { tabId: ${JSON.stringify(firstTabId)} },
        world: "MAIN",
        func: () => {
          document.getElementById("stale-target-button").textContent = "Stale row B";
        }
      });
    })()`);
    const recycledTargetResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [{
        id: "stale-connected-target",
        type: "click",
        ref: staleTarget.ref,
        reason: "stale target binding contract"
      }],
      executionBindings: [{
        actionId: "stale-connected-target",
        frameId: staleTarget.frameId || 0,
        documentId: staleTarget.frameDocumentId || staleTargetContext.data.documentId,
        targetBinding: staleTarget.binding,
        targetStateBinding: staleTarget.stateBinding,
        conditionBindings: []
      }]
    });
    assert.equal(recycledTargetResult.ok, true);
    assert.equal(recycledTargetResult.data.results[0].ok, false);
    assert.equal(recycledTargetResult.data.results[0].code, "stale_target");

    await evaluate(cdp, panelSessionId, `(async () => {
      await chrome.scripting.executeScript({
        target: { tabId: ${JSON.stringify(firstTabId)} },
        world: "MAIN",
        func: () => {
          const previous = document.getElementById("stale-target-button");
          previous.textContent = "Stale row A";
        }
      });
    })()`);
    const replacedTargetContext = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: {
        maxTextChars: 4000,
        maxElements: 20,
        elementQuery: "Stale row A",
        elementRoles: ["button"],
        redactSensitiveData: true
      }
    });
    const replacedTarget = replacedTargetContext.data.interactiveElements.find(
      (element) => element.label === "Stale row A"
    );
    await evaluate(cdp, panelSessionId, `(async () => {
      await chrome.scripting.executeScript({
        target: { tabId: ${JSON.stringify(firstTabId)} },
        world: "MAIN",
        func: () => {
          const previous = document.getElementById("stale-target-button");
          const replacement = document.createElement("button");
          replacement.id = previous.id;
          replacement.textContent = "Replacement row";
          replacement.addEventListener("click", () => {
            window.__staleTargetClickCount = (window.__staleTargetClickCount || 0) + 1;
          });
          previous.replaceWith(replacement);
        }
      });
    })()`);
    const replacedTargetResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [{
        id: "stale-replaced-target",
        type: "click",
        ref: replacedTarget.ref,
        reason: "selector rebound contract"
      }],
      executionBindings: [{
        actionId: "stale-replaced-target",
        frameId: replacedTarget.frameId || 0,
        documentId: replacedTarget.frameDocumentId || replacedTargetContext.data.documentId,
        targetBinding: replacedTarget.binding,
        targetStateBinding: replacedTarget.stateBinding,
        conditionBindings: []
      }]
    });
    assert.equal(replacedTargetResult.ok, true);
    assert.equal(replacedTargetResult.data.results[0].ok, false);
    assert.equal(replacedTargetResult.data.results[0].code, "stale_target");
    const ambientContext = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: {
        maxTextChars: 4000,
        maxElements: 20,
        elementQuery: "Ambient churn",
        elementRoles: ["button"],
        redactSensitiveData: true
      }
    });
    const ambientTarget = ambientContext.data.interactiveElements.find(
      (element) => element.label === "Ambient churn"
    );
    const ambientResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [{
        id: "ambient-only-change",
        type: "click",
        ref: ambientTarget.ref,
        reason: "ambient revision progress contract"
      }],
      executionBindings: [{
        actionId: "ambient-only-change",
        frameId: ambientTarget.frameId || 0,
        documentId: ambientTarget.frameDocumentId || ambientContext.data.documentId,
        targetBinding: ambientTarget.binding,
        targetStateBinding: ambientTarget.stateBinding,
        conditionBindings: []
      }]
    });
    assert.equal(ambientResult.ok, true);
    assert.equal(ambientResult.data.results[0].ok, true);
    assert.equal(ambientResult.data.results[0].verification.changed, false);
    assert.equal(ambientResult.data.results[0].verification.ambientChanged, true);
    assert.equal(ambientResult.data.results[0].verification.indeterminate, true);

    const mutableStateContext = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: {
        maxTextChars: 4000,
        maxElements: 20,
        elementQuery: "Mutable state checkbox",
        elementRoles: ["checkbox"],
        redactSensitiveData: true
      }
    });
    const mutableStateTarget = mutableStateContext.data.interactiveElements.find(
      (element) => element.label === "Mutable state checkbox"
    );
    assert.equal(mutableStateTarget.checked, false);
    await evaluate(cdp, panelSessionId, `(async () => {
      await chrome.scripting.executeScript({
        target: { tabId: ${JSON.stringify(firstTabId)} },
        world: "MAIN",
        func: () => {
          document.getElementById("mutable-state-checkbox").checked = true;
        }
      });
    })()`);
    const mutableStateResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [{
        id: "property-only-state-change",
        type: "click",
        ref: mutableStateTarget.ref,
        reason: "property-only target state contract"
      }],
      executionBindings: [{
        actionId: "property-only-state-change",
        frameId: mutableStateTarget.frameId || 0,
        documentId: mutableStateTarget.frameDocumentId || mutableStateContext.data.documentId,
        targetBinding: mutableStateTarget.binding,
        targetStateBinding: mutableStateTarget.stateBinding,
        conditionBindings: []
      }]
    });
    assert.equal(mutableStateResult.data.results[0].ok, false);
    assert.equal(mutableStateResult.data.results[0].code, "stale_target");
    const checkboxStayedChecked = await evaluate(cdp, panelSessionId, `(async () => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: ${JSON.stringify(firstTabId)} },
        world: "MAIN",
        func: () => document.getElementById("mutable-state-checkbox").checked
      });
      return result.result;
    })()`);
    assert.equal(checkboxStayedChecked, true, "a stale checkbox plan must not toggle current state");

    const targetlessDocumentResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [{
        id: "targetless-stale-document",
        type: "extract",
        reason: "targetless document binding contract"
      }],
      executionBindings: [{
        actionId: "targetless-stale-document",
        frameId: 0,
        documentId: "document-from-an-expired-observation",
        targetBinding: "",
        targetStateBinding: "",
        conditionBindings: []
      }]
    });
    assert.equal(targetlessDocumentResult.data.results[0].ok, false);
    assert.equal(targetlessDocumentResult.data.results[0].code, "stale_target");

    await evaluate(cdp, panelSessionId, `(async () => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: ${JSON.stringify(firstTabId)} },
        world: "MAIN",
        func: () => document.getElementById("structured-exemplar").scrollIntoView({ block: "center" })
      });
      return result.result;
    })()`);
    const structuredCollectionContext = await poll(
      async () => extensionMessage(cdp, panelSessionId, {
        type: "COLLECT_PAGE_CONTEXT",
        targetTabId: firstTabId,
        options: {
          maxTextChars: 8000,
          maxElements: 20,
          elementQuery: "A complete first record title",
          elementRoles: ["link"],
          redactSensitiveData: true
        }
      }),
      (response) => response?.data?.interactiveElements?.some(
        (element) => element.label === "A complete first record title"
      ),
      5_000
    );
    const structuredExemplar = structuredCollectionContext.data.interactiveElements.find(
      (element) => element.label === "A complete first record title"
    );
    assert.ok(structuredExemplar?.ref);
    const structuredCollectionResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [{
        id: "extract-structured-records",
        type: "extract",
        ref: structuredExemplar.ref,
        collectionId: "fixture-records",
        collectionName: "Fixture records",
        targetCount: 40,
        reason: "exercise rendered-document collection expansion"
      }],
      executionBindings: [{
        actionId: "extract-structured-records",
        frameId: structuredExemplar.frameId || 0,
        documentId: structuredExemplar.frameDocumentId || structuredCollectionContext.data.documentId,
        targetBinding: structuredExemplar.binding,
        targetStateBinding: structuredExemplar.stateBinding,
        conditionBindings: []
      }]
    });
    assert.equal(structuredCollectionResult.ok, true);
    assert.equal(structuredCollectionResult.data.results[0].ok, true);
    const structuredBatch = structuredCollectionResult.data.results[0].result.collection;
    assert.equal(structuredBatch.scope, "rendered-document");
    assert.equal(structuredBatch.collectionId, "fixture-records");
    assert.equal(structuredBatch.targetCount, 40);
    assert.equal(structuredBatch.returnedCount, 4);
    assert.deepEqual(
      structuredBatch.records.map((record) => record.title),
      [
        "A complete first record title",
        "A complete offscreen second record title",
        "A third rendered record title",
        "2026"
      ]
    );
    assert.ok(
      structuredBatch.records.some((record) => (
        record.title === "A complete offscreen second record title"
        && /\[redacted-email\]/.test(record.context)
      )),
      "structured extraction should include offscreen rendered rows while preserving observation redaction"
    );
    assert.equal(
      structuredBatch.records.some((record) => (
        /Pinned|Display-none|Content-hidden|Opacity-hidden/.test(
          `${record.title} ${record.context}`
        )
      )),
      false,
      "single-link notices and non-rendered records must stay outside the collection"
    );
    assert.equal(new Set(structuredBatch.records.map((record) => record.url)).size, 4);
    assert.doesNotMatch(JSON.stringify(structuredBatch), /fixture-private-token|private@example\.com/);
    assert.ok(structuredBatch.records.every((record) => record.url.includes("%5Bredacted%5D")));
    assert.ok(structuredBatch.records.every((record) => record.key && record.provenance));
    assert.match(structuredBatch.pageIdentity.documentId, /^[0-9a-z-]{8,}$/i);
    assert.equal(structuredBatch.pageIdentity.domRevision, structuredCollectionContext.data.pageState.domRevision);
    assert.equal(structuredBatch.pageIdentity.sourceSliceDigest, structuredBatch.sourceSliceDigest);

    const repeatedStructuredCollectionResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [{
        id: "repeat-structured-records",
        type: "extract",
        ref: structuredExemplar.ref,
        collectionId: "fixture-records",
        collectionName: "Fixture records",
        targetCount: 40,
        reason: "verify stable source slice identity"
      }],
      executionBindings: [{
        actionId: "repeat-structured-records",
        frameId: structuredExemplar.frameId || 0,
        documentId: structuredExemplar.frameDocumentId || structuredCollectionContext.data.documentId,
        targetBinding: structuredExemplar.binding,
        targetStateBinding: structuredExemplar.stateBinding,
        conditionBindings: []
      }]
    });
    const repeatedStructuredBatch = repeatedStructuredCollectionResult.data.results[0].result.collection;
    assert.equal(repeatedStructuredBatch.sourceSliceDigest, structuredBatch.sourceSliceDigest);
    assert.deepEqual(
      repeatedStructuredBatch.records.map((record) => record.key),
      structuredBatch.records.map((record) => record.key)
    );

    const legacyExtractResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [{
        id: "legacy-extract-remains-compatible",
        type: "extract",
        reason: "verify the original extract response contract"
      }],
      executionBindings: [{
        actionId: "legacy-extract-remains-compatible",
        frameId: 0,
        documentId: structuredCollectionContext.data.documentId,
        targetBinding: "",
        targetStateBinding: "",
        conditionBindings: []
      }]
    });
    assert.equal(legacyExtractResult.data.results[0].ok, true);
    assert.equal(typeof legacyExtractResult.data.results[0].result.text, "string");
    assert.equal("collection" in legacyExtractResult.data.results[0].result, false);

    const textPressContext = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: {
        maxTextChars: 4000,
        maxElements: 20,
        elementQuery: "Text press target",
        elementRoles: ["button"],
        redactSensitiveData: true
      }
    });
    const textPressTarget = textPressContext.data.interactiveElements.find(
      (element) => element.label === "Text press target"
    );
    const textPressResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [{
        id: "text-targeted-key",
        type: "press",
        text: "Text press target",
        key: "ArrowDown",
        reason: "text lookup press contract"
      }],
      executionBindings: [{
        actionId: "text-targeted-key",
        frameId: textPressTarget.frameId || 0,
        documentId: textPressTarget.frameDocumentId || textPressContext.data.documentId,
        targetBinding: textPressTarget.binding,
        targetStateBinding: textPressTarget.stateBinding,
        conditionBindings: []
      }]
    });
    assert.equal(textPressResult.data.results[0].ok, true);
    const pressCounts = await evaluate(cdp, panelSessionId, `(async () => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: ${JSON.stringify(firstTabId)} },
        world: "MAIN",
        func: () => ({
          target: window.__textPressTargetCount || 0,
          decoy: window.__textPressDecoyCount || 0
        })
      });
      return result.result;
    })()`);
    assert.equal(pressCounts.target, 1);
    assert.equal(pressCounts.decoy, 0);

    const waitBindingResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [{
        id: "bound-wait-condition",
        type: "wait_for",
        conditionJson: JSON.stringify({
          type: "element_state",
          ref: textPressTarget.ref,
          state: "enabled",
          expected: true
        }),
        ms: 500,
        reason: "nested wait binding contract"
      }],
      executionBindings: [{
        actionId: "bound-wait-condition",
        frameId: textPressTarget.frameId || 0,
        documentId: textPressTarget.frameDocumentId || textPressContext.data.documentId,
        targetBinding: "",
        targetStateBinding: "",
        conditionBindings: [{
          ref: textPressTarget.ref,
          selector: "",
          text: "",
          frameId: textPressTarget.frameId || 0,
          documentId: textPressTarget.frameDocumentId || textPressContext.data.documentId,
          targetBinding: textPressTarget.binding,
          targetStateBinding: textPressTarget.stateBinding
        }]
      }]
    });
    assert.equal(waitBindingResult.data.results[0].ok, true);
    assert.equal(waitBindingResult.data.results[0].result.matched, true);

    const raceContext = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: {
        maxTextChars: 4000,
        maxElements: 20,
        elementQuery: "Post observation race original",
        elementRoles: ["button"],
        redactSensitiveData: true
      }
    });
    const raceTarget = raceContext.data.interactiveElements.find(
      (element) => element.label === "Post observation race original"
    );
    const raceExecutionPromise = extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [{
        id: "post-observation-race",
        type: "click",
        ref: raceTarget.ref,
        reason: "post-action target identity contract"
      }],
      executionBindings: [{
        actionId: "post-observation-race",
        frameId: raceTarget.frameId || 0,
        documentId: raceTarget.frameDocumentId || raceContext.data.documentId,
        targetBinding: raceTarget.binding,
        targetStateBinding: raceTarget.stateBinding,
        conditionBindings: []
      }]
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: {
        maxTextChars: 4000,
        maxElements: 20,
        elementQuery: "Post observation race decoy",
        elementRoles: ["button"],
        redactSensitiveData: true
      }
    });
    const raceResult = await raceExecutionPromise;
    assert.equal(raceResult.data.results[0].ok, true);
    assert.equal(
      raceResult.data.results[0].verification.changed,
      false,
      "post-action verification must stay bound to the exact executed node"
    );

    const staleClickCount = await evaluate(cdp, panelSessionId, `(async () => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: ${JSON.stringify(firstTabId)} },
        world: "MAIN",
        func: () => {
          const count = window.__staleTargetClickCount || 0;
          document.getElementById("stale-target-fixture")?.remove();
          delete window.__staleTargetClickCount;
          delete window.__textPressTargetCount;
          delete window.__textPressDecoyCount;
          return count;
        }
      });
      return result.result;
    })()`);
    assert.equal(staleClickCount, 0, "stale refs must never activate a recycled or selector-rebound target");

    await evaluate(cdp, panelSessionId, `(async () => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: ${JSON.stringify(firstTabId)} },
        world: "MAIN",
        func: () => document.getElementById("pointer-action")?.scrollIntoView({ block: "center" })
      });
      return result.result;
    })()`);
    const pointerStartContext = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: {
        maxTextChars: 8000,
        maxElements: 20,
        elementQuery: "Pointer action",
        redactSensitiveData: true
      }
    });
    const pointerTarget = pointerStartContext.data.interactiveElements.find(
      (element) => element.label === "Pointer action"
    );
    assert.ok(
      pointerTarget?.ref,
      `pointer-cursor custom controls should be recognized without page-specific selectors: ${JSON.stringify(firstContext.data.interactiveElements.map((element) => ({ label: element.label, tag: element.tag, rect: element.rect })))}`
    );
    const pointerResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [{ id: "pointer-sequence", type: "click", ref: pointerTarget.ref, reason: "custom pointer event E2E" }]
    });
    assert.equal(pointerResult.ok, true);
    assert.equal(pointerResult.data.results[0].ok, true);
    assert.equal(pointerResult.data.results[0].result.inputSequence, "pointer-mouse-click");
    const pointerContext = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: { maxTextChars: 8000, maxElements: 40, redactSensitiveData: true }
    });
    assert.match(pointerContext.data.visibleText, /Pointer sequence complete/);

    const svgTarget = pointerContext.data.interactiveElements.find((element) => element.label === "SVG action");
    assert.equal(svgTarget?.tag, "svg", "a standalone accessible SVG should be exposed as an interactive control");
    const svgResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [{ id: "click-svg", type: "click", ref: svgTarget.ref, reason: "standalone SVG control E2E" }]
    });
    assert.equal(svgResult.ok, true);
    assert.equal(svgResult.data.results[0].ok, true);
    const svgContext = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: { maxTextChars: 8000, maxElements: 40, redactSensitiveData: true }
    });
    assert.match(svgContext.data.visibleText, /SVG action complete/);

    const delegatedTarget = svgContext.data.interactiveElements.find(
      (element) => element.label === "Delegated child target"
    );
    assert.ok(delegatedTarget?.ref);
    const delegatedResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [{ id: "click-delegated-child", type: "click", ref: delegatedTarget.ref, reason: "delegated child target E2E" }]
    });
    assert.equal(delegatedResult.ok, true);
    assert.equal(delegatedResult.data.results[0].ok, true);
    const delegatedContext = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: { maxTextChars: 8000, maxElements: 40, redactSensitiveData: true }
    });
    assert.match(delegatedContext.data.visibleText, /Delegated target delegated-child/);
    assert.match(delegatedContext.data.visibleText, /Delegated native activation revealed/);

    const legacyPaginationSearch = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: {
        maxTextChars: 8000,
        maxElements: 20,
        elementQuery: "2",
        elementRoles: ["link"],
        elementNearText: "[1/5] [총 478건]",
        redactSensitiveData: true
      }
    });
    const legacyPageTwo = legacyPaginationSearch.data.interactiveElements.find(
      (element) => element.label === "2"
    );
    assert.deepEqual(
      legacyPaginationSearch.data.interactiveElements.map((element) => element.label),
      ["2"],
      "nearby text should filter context while the primary query stays bound to control identity"
    );
    assert.ok(
      legacyPageTwo?.ref,
      "numeric legacy paginator links should be found from bounded nearby context instead of date-like table rows"
    );
    assert.match(legacyPageTwo.searchMatch.contextSnippet, /\[1\/5\].*478건/);
    const legacyPageResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [{
        id: "legacy-page-two",
        type: "click",
        ref: legacyPageTwo.ref,
        reason: "exercise a legacy javascript paginator without treating it as a document navigation"
      }]
    });
    assert.equal(legacyPageResult.ok, true);
    assert.equal(legacyPageResult.data.results[0].ok, true);
    assert.equal(legacyPageResult.data.results[0].result.mayNavigate, false);
    assert.equal(legacyPageResult.data.results[0].verification.changed, true);
    const legacyPageContext = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: { maxTextChars: 8000, maxElements: 40, redactSensitiveData: true }
    });
    assert.match(legacyPageContext.data.visibleText, /Legacy page 2 loaded/);

    await evaluate(cdp, panelSessionId, `(async () => {
      await chrome.scripting.executeScript({
        target: { tabId: ${JSON.stringify(firstTabId)} },
        world: "MAIN",
        args: [${JSON.stringify(`${origin}/legacy-frameset`)}],
        func: (frameUrl) => {
          const fixture = document.createElement("div");
          fixture.id = "legacy-compat-fixture";
          const imageShell = document.createElement("div");
          imageShell.id = "legacy-image-map-shell";
          Object.assign(imageShell.style, {
            position: "fixed",
            left: "8px",
            top: "8px",
            zIndex: "2147483000",
            width: "220px",
            padding: "4px",
            background: "white",
            font: "11px sans-serif"
          });
          const title = document.createElement("div");
          title.textContent = "Legacy image menu";
          const image = document.createElement("img");
          image.id = "legacy-image-map";
          image.alt = "Legacy image menu";
          image.useMap = "#legacy-image-actions";
          image.width = 200;
          image.height = 40;
          image.style.display = "block";
          image.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='40'%3E%3Crect width='200' height='40' fill='%23dbeafe'/%3E%3Ctext x='100' y='25' text-anchor='middle' font-size='14'%3ELegacy map action%3C/text%3E%3C/svg%3E";
          const map = document.createElement("map");
          map.name = "legacy-image-actions";
          const area = document.createElement("area");
          area.shape = "rect";
          area.coords = "0,0,200,40";
          area.href = "javascript:void(0)";
          area.alt = "Legacy image map action";
          area.setAttribute("onclick", "legacyMapAction(); return false;");
          map.append(area);
          const status = document.createElement("div");
          status.id = "legacy-image-map-status";
          status.setAttribute("role", "status");
          status.textContent = "Legacy image map ready";
          imageShell.append(title, image, map, status);

          const frame = document.createElement("iframe");
          frame.id = "legacy-frameset";
          frame.title = "Legacy frameset";
          frame.src = frameUrl;
          Object.assign(frame.style, {
            position: "fixed",
            left: "250px",
            top: "8px",
            zIndex: "2147483000",
            width: "280px",
            height: "96px",
            background: "white"
          });
          fixture.append(imageShell, frame);
          document.body.append(fixture);
          window.legacyMapAction = () => {
            document.querySelector("#legacy-image-map-status").textContent = "Legacy image map complete";
          };
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 240));
    })()`);
    const legacyImageMapContext = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: {
        maxTextChars: 8000,
        maxElements: 20,
        elementQuery: "Legacy image map action",
        elementRoles: ["link"],
        elementNearText: "Legacy image menu",
        redactSensitiveData: true
      }
    });
    const legacyImageMapAction = legacyImageMapContext.data.interactiveElements.find(
      (element) => element.label === "Legacy image map action"
    );
    assert.equal(legacyImageMapAction?.tag, "area");
    assert.ok(legacyImageMapAction?.rect?.width > 0);
    assert.ok(legacyImageMapAction?.hitPoint);
    const legacyImageMapResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [{
        id: "legacy-image-map-action",
        type: "click",
        ref: legacyImageMapAction.ref,
        reason: "exercise a visible legacy image-map control"
      }]
    });
    assert.equal(legacyImageMapResult.ok, true);
    assert.equal(
      legacyImageMapResult.data.results[0].ok,
      true,
      JSON.stringify(legacyImageMapResult.data.results[0])
    );
    assert.equal(
      legacyImageMapResult.data.results[0].result.activation,
      "page-owned-legacy-handler"
    );
    const legacyImageMapDomStatus = await evaluate(cdp, panelSessionId, `(async () => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: ${JSON.stringify(firstTabId)} },
        func: () => {
          const element = document.querySelector("#legacy-image-map-status");
          const rect = element?.getBoundingClientRect();
          const point = rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
          const hit = point ? document.elementFromPoint(point.x, point.y) : null;
          return {
            text: element?.textContent || "",
            rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
            hit: hit?.id || hit?.tagName || ""
          };
        }
      });
      return result?.result || null;
    })()`);
    assert.equal(
      legacyImageMapDomStatus?.text,
      "Legacy image map complete",
      JSON.stringify(legacyImageMapResult.data.results[0])
    );
    const legacyImageMapVerified = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: { maxTextChars: 8000, maxElements: 40, redactSensitiveData: true }
    });
    assert.match(
      legacyImageMapVerified.data.visibleText,
      /Legacy image map complete/,
      JSON.stringify(legacyImageMapDomStatus)
    );

    const legacyFrameContext = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: {
        maxTextChars: 8000,
        maxElements: 20,
        elementQuery: "Legacy legacy-left action",
        elementRoles: ["button"],
        redactSensitiveData: true
      }
    });
    const legacyFrameAction = legacyFrameContext.data.interactiveElements.find(
      (element) => element.label === "Legacy legacy-left action"
    );
    assert.ok(
      legacyFrameAction?.frameId > 0,
      `named duplicate-URL <frame> content should map to a browser frame: ${JSON.stringify(
        legacyFrameContext.data.automationCapabilities.frames
      )}`
    );
    assert.equal(
      JSON.stringify(legacyFrameContext.data).includes("frameNameBinding"),
      false,
      "the raw frame-name binding must remain internal to frame resolution"
    );
    assert.match(legacyFrameAction.scope || "", /top/);
    const legacyFrameResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [{
        id: "legacy-frame-action",
        type: "click",
        ref: legacyFrameAction.ref,
        reason: "exercise a named legacy frame with a duplicate navigation URL"
      }]
    });
    assert.equal(legacyFrameResult.ok, true);
    assert.equal(legacyFrameResult.data.results[0].ok, true);
    const legacyFrameVerified = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: { maxTextChars: 8000, maxElements: 40, redactSensitiveData: true }
    });
    assert.match(legacyFrameVerified.data.visibleText, /Legacy legacy-left complete/);
    await evaluate(cdp, panelSessionId, `(async () => {
      await chrome.scripting.executeScript({
        target: { tabId: ${JSON.stringify(firstTabId)} },
        world: "MAIN",
        func: () => {
          document.querySelector("#legacy-compat-fixture")?.remove();
          delete window.legacyMapAction;
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
    })()`);

    const limitedContext = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: { maxTextChars: 8000, maxElements: 20, redactSensitiveData: true }
    });
    assert.equal(limitedContext.data.interactiveElementStats.included, 20);
    assert.ok(limitedContext.data.interactiveElementStats.total > 20);
    assert.equal(limitedContext.data.interactiveElementStats.truncated, true);
    assert.equal(
      limitedContext.data.interactiveElements[0]?.label,
      "Visual-first late candidate",
      "all exposed candidates must be collected before visual ordering and limiting"
    );
    assert.equal(limitedContext.data.elementDiscovery.hasMore, true);
    assert.ok(limitedContext.data.elementDiscovery.nextCursor);

    let elementPage = limitedContext;
    let denseNextPage = elementPage.data.interactiveElements.find(
      (element) => element.label === "Dense grid next page"
    );
    let previousVisited = elementPage.data.elementDiscovery.visited;
    for (let page = 0; !denseNextPage && elementPage.data.elementDiscovery.hasMore && page < 20; page += 1) {
      elementPage = await extensionMessage(cdp, panelSessionId, {
        type: "COLLECT_PAGE_CONTEXT",
        targetTabId: firstTabId,
        options: {
          maxTextChars: 8000,
          maxElements: 20,
          elementCursor: elementPage.data.elementDiscovery.nextCursor,
          redactSensitiveData: true
        }
      });
      assert.ok(elementPage.data.elementDiscovery.visited > previousVisited);
      previousVisited = elementPage.data.elementDiscovery.visited;
      denseNextPage = elementPage.data.interactiveElements.find(
        (element) => element.label === "Dense grid next page"
      );
    }
    assert.ok(
      denseNextPage?.ref,
      `cursor paging must make a control after a dense grid reachable: ${JSON.stringify({
        visited: elementPage.data.elementDiscovery.visited,
        total: elementPage.data.elementDiscovery.total,
        hasMore: elementPage.data.elementDiscovery.hasMore,
        labels: elementPage.data.interactiveElements.map((element) => element.label)
      })}`
    );

    const queriedElements = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: {
        maxTextChars: 8000,
        maxElements: 20,
        elementQuery: "Dense grid next page",
        elementRoles: ["button"],
        elementNearText: "Dense issue grid",
        redactSensitiveData: true
      }
    });
    assert.ok(
      queriedElements.data.interactiveElements.some((element) => element.label === "Dense grid next page"),
      "goal-derived visible-element search should find the paginator without a page-specific hardcoded rule"
    );
    assert.equal(queriedElements.data.elementDiscovery.availableTotalExact, false);
    assert.equal(queriedElements.data.elementDiscovery.availableTotal, null);
    assert.ok(
      queriedElements.data.elementDiscovery.potentialTotal
        > queriedElements.data.elementDiscovery.total
    );
    assert.deepEqual(queriedElements.data.elementDiscovery.search, {
      query: "Dense grid next page",
      roles: ["button"],
      nearText: "Dense issue grid"
    });
    const searchedPaginator = queriedElements.data.interactiveElements.find(
      (element) => element.label === "Dense grid next page"
    );
    assert.ok(searchedPaginator.searchMatch.matchedFields.includes("context"));
    assert.match(searchedPaginator.searchMatch.contextSnippet, /Dense issue grid/);

    const broadSearch = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: {
        maxTextChars: 8000,
        maxElements: 20,
        elementQuery: "Dense grid",
        elementRoles: ["button"],
        elementNearText: "Dense issue grid",
        redactSensitiveData: true
      }
    });
    assert.equal(broadSearch.data.elementDiscovery.hasMore, true);
    const continuedSearch = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: {
        maxTextChars: 8000,
        maxElements: 20,
        elementCursor: broadSearch.data.elementDiscovery.nextCursor,
        elementQuery: "Dense grid",
        elementRoles: ["button"],
        elementNearText: "Dense issue grid",
        redactSensitiveData: true
      }
    });
    assert.ok(
      continuedSearch.data.elementDiscovery.visited > broadSearch.data.elementDiscovery.visited
    );
    assert.ok(
      continuedSearch.data.elementDiscovery.visited
        <= broadSearch.data.elementDiscovery.visited + 20
    );
    assert.deepEqual(continuedSearch.data.elementDiscovery.search, broadSearch.data.elementDiscovery.search);
    const relationalSearch = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: {
        maxTextChars: 8000,
        maxElements: 20,
        elementQuery: "",
        elementRoles: ["button"],
        elementNearText: "Request type",
        redactSensitiveData: true
      }
    });
    assert.equal(
      relationalSearch.data.interactiveElements[0]?.selector,
      "#request-type-lookup",
      `nearText should rank the icon in the nearest field above controls that only share a broad form context: ${JSON.stringify(
        relationalSearch.data.interactiveElements.map((element) => ({
          selector: element.selector,
          label: element.label,
          score: element.searchMatch?.score,
          context: element.searchMatch?.contextSnippet
        }))
      )}`
    );
    assert.match(
      relationalSearch.data.interactiveElements[0]?.searchMatch?.contextSnippet || "",
      /ancestor-[1-5]: Request type/
    );
    const mismatchedSearchCursor = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: {
        maxTextChars: 8000,
        maxElements: 20,
        elementCursor: broadSearch.data.elementDiscovery.nextCursor,
        elementQuery: "Dense grid",
        elementRoles: ["link"],
        elementNearText: "Dense issue grid",
        redactSensitiveData: true
      }
    });
    assert.equal(mismatchedSearchCursor.data.elementDiscovery.cursorReset, true);
    assert.equal(mismatchedSearchCursor.data.elementDiscovery.returned, 0);
    await evaluate(cdp, panelSessionId, `(async () => {
      await chrome.scripting.executeScript({
        target: { tabId: ${JSON.stringify(firstTabId)} },
        func: () => {
          const marker = document.createElement("div");
          marker.id = "cursor-dom-mutation";
          marker.hidden = true;
          document.body.appendChild(marker);
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
    })()`);
    const resetCursorContext = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: {
        maxTextChars: 8000,
        maxElements: 20,
        elementCursor: limitedContext.data.elementDiscovery.nextCursor,
        redactSensitiveData: true
      }
    });
    assert.equal(resetCursorContext.data.elementDiscovery.cursorReset, true);
    assert.match(resetCursorContext.data.elementDiscovery.cursorResetReason, /page changed/i);
    assert.equal(resetCursorContext.data.elementDiscovery.visited, 20);

    const lowerScrollResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [{ id: "scroll-lower", type: "scroll", direction: "down", amount: 3000, reason: "reveal lower viewport" }]
    });
    assert.equal(lowerScrollResult.data.results[0].ok, true);
    const lowerContext = await poll(
      async () => extensionMessage(cdp, panelSessionId, {
        type: "COLLECT_PAGE_CONTEXT",
        targetTabId: firstTabId,
        options: { maxTextChars: 8000, maxElements: 40, redactSensitiveData: true }
      }),
      (response) => response?.data?.visibleText?.includes("Offscreen viewport fact"),
      5000
    );
    assert.ok(lowerContext.data.interactiveElements.some((element) => element.label === "Offscreen action"));

    await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [{ id: "scroll-top", type: "scroll", direction: "up", amount: 3000, reason: "restore upper viewport" }]
    });
    const restoredContext = await poll(
      async () => extensionMessage(cdp, panelSessionId, {
        type: "COLLECT_PAGE_CONTEXT",
        targetTabId: firstTabId,
        options: { maxTextChars: 12000, maxElements: 100, redactSensitiveData: true }
      }),
      (response) => response?.data?.interactiveElements?.some((element) => element.label === "Name"),
      5000
    );

    const input = restoredContext.data.interactiveElements.find((element) => element.label === "Name");
    assert.ok(input?.ref, "the real content script should expose a runtime element ref");
    const privateInput = restoredContext.data.interactiveElements.find((element) => element.label === "Email");
    assert.equal(privateInput?.value, "[redacted]");
    const shadowInput = restoredContext.data.interactiveElements.find((element) => element.label === "Shadow Name");
    const frameInput = restoredContext.data.interactiveElements.find((element) => element.label === "Frame Name");
    const crossFrameInput = restoredContext.data.interactiveElements.find((element) => element.label === "Cross Frame Name");
    const crossFrameAction = restoredContext.data.interactiveElements.find((element) => element.label === "Cross Frame Action");
    const uploadInput = restoredContext.data.interactiveElements.find((element) => element.label === "Upload document");
    assert.match(shadowInput?.scope || "", /shadow/);
    assert.match(frameInput?.scope || "", /frame/);
    assert.match(crossFrameInput?.ref || "", /^f\d+:e\d+$/);
    assert.ok(crossFrameInput?.frameId > 0);
    assert.equal(crossFrameInput?.rectSpace, "top-viewport");
    assert.ok(uploadInput?.ref);

    const crossFrameResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [
        { id: "fill-cross-frame", type: "fill", selector: crossFrameInput.selector, value: "cross-bound", reason: "cross-origin selector routing E2E" },
        { id: "click-cross-frame", type: "click", text: "Cross Frame Action", reason: "cross-origin text routing E2E" }
      ],
      executionBindings: [
        {
          actionId: "fill-cross-frame",
          frameId: crossFrameInput.frameId,
          documentId: crossFrameInput.frameDocumentId,
          targetBinding: crossFrameInput.binding,
          targetStateBinding: crossFrameInput.stateBinding,
          conditionBindings: []
        },
        {
          actionId: "click-cross-frame",
          frameId: crossFrameAction.frameId,
          documentId: crossFrameAction.frameDocumentId,
          targetBinding: crossFrameAction.binding,
          targetStateBinding: crossFrameAction.stateBinding,
          conditionBindings: []
        }
      ]
    });
    assert.equal(crossFrameResult.ok, true);
    assert.equal(crossFrameResult.data.results.every((result) => result.ok), true);
    assert.equal(crossFrameResult.data.results[0].frameId, crossFrameInput.frameId);
    const crossFrameContext = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: { maxTextChars: 12000, maxElements: 100, redactSensitiveData: true }
    });
    assert.match(crossFrameContext.data.visibleText, /Cross frame action complete/);
    assert.equal(
      crossFrameContext.data.interactiveElements.find((element) => element.label === "Cross Frame Name")?.value,
      "cross-bound"
    );

    const scrollRegion = crossFrameContext.data.scrollRegions.find((region) => region.label === "Scrollable results");
    assert.ok(scrollRegion?.ref);
    assert.equal(
      crossFrameContext.data.interactiveElements.some((element) => element.label === "Nested scroll action"),
      false
    );
    const nestedScrollResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [{
        id: "scroll-nested-region",
        type: "scroll",
        ref: scrollRegion.ref,
        direction: "down",
        amount: 220,
        reason: "reveal a clipped control inside its own scroll container"
      }]
    });
    assert.equal(nestedScrollResult.data.results[0].ok, true);
    const nestedContext = await poll(
      async () => extensionMessage(cdp, panelSessionId, {
        type: "COLLECT_PAGE_CONTEXT",
        targetTabId: firstTabId,
        options: { maxTextChars: 12000, maxElements: 100, redactSensitiveData: true }
      }),
      (response) => response?.data?.interactiveElements?.some((element) => element.label === "Nested scroll action"),
      5000
    );
    assert.ok(nestedContext.data.scrollRegions.find((region) => region.ref === scrollRegion.ref)?.scrollTop > 0);

    const visualSurface = nestedContext.data.visualSurfaces.find((surface) => surface.label === "Visual command surface");
    assert.ok(visualSurface?.ref);
    const visualBypassResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [{
        id: "visual-bypass",
        type: "click",
        ref: visualSurface.ref,
        reason: "verify that a normal click cannot bypass visual safeguards"
      }]
    });
    assert.equal(visualBypassResult.data.results[0].ok, false);
    assert.equal(visualBypassResult.data.results[0].code, "visual_action_required");
    const visualSurfaceContext = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: { maxTextChars: 12000, maxElements: 100, redactSensitiveData: true }
    });
    const currentVisualSurface = visualSurfaceContext.data.visualSurfaces.find(
      (surface) => surface.label === "Visual command surface"
    );
    const visualActionResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [{
        id: "visual-apply",
        type: "visual_click",
        ref: currentVisualSurface.ref,
        xNormalized: 750,
        yNormalized: 500,
        targetDescription: "green Apply area",
        reason: "visual surface E2E"
      }]
    });
    assert.equal(visualActionResult.data.results[0].ok, true);
    const visualContext = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: { maxTextChars: 12000, maxElements: 100, redactSensitiveData: true }
    });
    assert.match(visualContext.data.visibleText, /Visual apply complete/);
    if (process.argv.includes("--capture-docs")) {
      await captureWebCompatibilityDocs(cdp, panelSessionId, visualContext.data);
    }
    const currentShadowInput = visualContext.data.interactiveElements.find((element) => element.label === "Shadow Name");
    const currentFrameInput = visualContext.data.interactiveElements.find((element) => element.label === "Frame Name");
    const currentUploadInput = visualContext.data.interactiveElements.find((element) => element.label === "Upload document");
    const currentPageNameInput = visualContext.data.interactiveElements.find((element) => element.label === "Name");

    const deepActionResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [
        { id: "fill-shadow", type: "fill", ref: currentShadowInput.ref, value: "shadow-value", reason: "Shadow DOM E2E" },
        { id: "fill-frame", type: "fill", ref: currentFrameInput.ref, value: "frame-value", reason: "iframe E2E" }
      ]
    });
    assert.equal(deepActionResult.ok, true);
    assert.equal(deepActionResult.data.results.every((result) => result.ok), true);

    const waitResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [
        { id: "start-async", type: "click", selector: "#async", reason: "start async result" },
        {
          id: "wait-async",
          type: "wait_for",
          conditionJson: JSON.stringify({ type: "live_region", operator: "contains", value: "Async complete" }),
          ms: 5000,
          reason: "event-driven wait"
        }
      ]
    });
    assert.equal(waitResult.ok, true);
    assert.equal(waitResult.data.results[1].result.matched, true);

    const uploadResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [{
        id: "upload",
        type: "upload",
        ref: currentUploadInput.ref,
        files: [{
          name: "agent-e2e.txt",
          type: "text/plain",
          lastModified: Date.now(),
          dataUrl: "data:text/plain;base64,YWdlbnQtZTJl"
        }],
        reason: "user-selected upload handoff"
      }]
    });
    assert.equal(uploadResult.ok, true);
    assert.equal(uploadResult.data.results[0].result.uploaded[0].name, "agent-e2e.txt");

    const actionResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [{ id: "fill-first", type: "fill", ref: currentPageNameInput.ref, value: "bound-tab", reason: "E2E tab binding" }]
    });
    assert.equal(actionResult.ok, true);
    assert.equal(actionResult.data.results[0].ok, true);

    const secondTargetId = await createPage(cdp, `${origin}/page-b`);
    await cdp.send("Target.activateTarget", { targetId: secondTargetId });
    const secondTabId = await queryTabId(cdp, panelSessionId, `${origin}/page-b`);
    assert.notEqual(firstTabId, secondTabId);
    const secondPanelTab = await extensionMessage(cdp, panelSessionId, {
      type: "OPEN_PANEL_TAB",
      targetTabId: secondTabId
    });
    assert.equal(secondPanelTab.ok, true);
    assert.notEqual(secondPanelTab.data.id, panelTabContract.panelTabId);
    const targetSpecificPanelCount = await evaluate(cdp, panelSessionId, `(async () => {
      const tabs = await chrome.tabs.query({});
      return tabs.filter((tab) => String(tab.url || tab.pendingUrl || "").startsWith(chrome.runtime.getURL("panel.html"))).length;
    })()`);
    assert.equal(targetSpecificPanelCount, 2, "a different target should not reload an existing agent workspace");
    await evaluate(cdp, panelSessionId, `chrome.tabs.remove(${JSON.stringify(secondPanelTab.data.id)})`);

    const boundResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [{ id: "fill-bound", type: "fill", selector: "#name", value: "still-first", reason: "Stay on bound tab" }]
    });
    assert.equal(boundResult.ok, true);
    assert.equal(await readInputValue(cdp, firstTargetId), "still-first");
    assert.equal(await readInputValue(cdp, secondTargetId), "second-tab");

    const openedTab = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_BROWSER_ACTIONS",
      targetTabId: firstTabId,
      actions: [{ id: "open-popup", type: "tab_open", url: `${origin}/popup`, adopt: false, reason: "tab lifecycle E2E" }]
    });
    assert.equal(openedTab.ok, true);
    const openedTabId = openedTab.data.results[0].result.openedTabId;
    const browserContext = await extensionMessage(cdp, panelSessionId, {
      type: "GET_BROWSER_CONTEXT",
      targetTabId: firstTabId
    });
    assert.equal(browserContext.data.tabs.some((tab) => tab.id === openedTabId || tab.tabId === openedTabId), true);
    const closedTab = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_BROWSER_ACTIONS",
      targetTabId: firstTabId,
      actions: [{ id: "close-popup", type: "tab_close", tabId: openedTabId, reason: "cleanup popup" }]
    });
    assert.equal(closedTab.data.results[0].ok, true);

    await navigateTarget(cdp, firstTargetId, `${origin}/page-a?reload=1&token=private-runtime-token`);
    const reloadedContext = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: { maxTextChars: 8000, maxElements: 40, redactSensitiveData: true }
    });
    assert.equal(reloadedContext.ok, true);
    assert.notEqual(reloadedContext.data.documentId, firstContext.data.documentId);
    assert.doesNotMatch(reloadedContext.data.url, /private-runtime-token/);

    const runningWorker = await waitForTarget(cdp, (target) => (
      target.type === "service_worker" && target.url === `chrome-extension://${extensionId}/background.js`
    ));
    await cdp.send("Target.closeTarget", { targetId: runningWorker.targetId });
    await poll(async () => {
      const { targetInfos } = await cdp.send("Target.getTargets");
      return targetInfos.some((target) => target.targetId === runningWorker.targetId) ? "" : "stopped";
    }, Boolean, 10000);
    const afterWorkerRestart = await extensionMessage(cdp, panelSessionId, {
      type: "COLLECT_PAGE_CONTEXT",
      targetTabId: firstTabId,
      options: { maxTextChars: 8000, maxElements: 40, redactSensitiveData: true }
    });
    assert.equal(afterWorkerRestart.ok, true);
    assert.equal(afterWorkerRestart.data.documentId, reloadedContext.data.documentId);

    companion = await createCompanionServer({
      port: 0,
      statePath: path.join(temporaryRoot, "companion", "companion-state.json"),
      logger: silentLogger,
      authenticationTimeoutMs: 10_000,
      toolCallTimeoutMs: 15_000,
    });

    const parsedExtensionSetup = await evaluate(
      cdp,
      panelSessionId,
      `parseBridgeSetupValue(${JSON.stringify(companion.extensionSetup)})`
    );
    assert.equal(parsedExtensionSetup.endpoint, companion.endpoints.extension);
    assert.equal(parsedExtensionSetup.pairingCode, companion.pairingCode);

    const bridgeConnectPoint = await evaluate(cdp, panelSessionId, `(async () => {
      await loadSettings();
      state.settings = {
        ...state.settings,
        bridgeEnabled: false,
        bridgeEndpoint: "",
        bridgeRequireApproval: true,
        policyGuardEnabled: false,
        stopOnSensitiveInput: true
      };
      applySettingsToForm();
      state.activeTab = {
        id: ${JSON.stringify(firstTabId)},
        title: "First page",
        url: ${JSON.stringify(`${origin}/page-a`)}
      };
      elements.inputs.bridgeEndpoint.value = ${JSON.stringify(companion.extensionSetup)};
      openSettings();
      activateSettingsTab("bridge");
      renderBridgeStatus();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {
        disabled: elements.bridgeConnectButton.disabled
      };
    })()`);
    assert.equal(bridgeConnectPoint.disabled, false);
    await cdp.send("Runtime.evaluate", {
      expression: "elements.bridgeConnectButton.click(); true",
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    }, panelSessionId);
    let connectedBridge;
    try {
      connectedBridge = await poll(
        async () => extensionMessage(cdp, panelSessionId, { type: "GET_BRIDGE_STATUS" }),
        (response) => response?.ok
          && response.data.connected
          && response.data.runtime.armed
          && companion.extensionConnected,
        15_000
      );
    } catch (error) {
      const diagnostic = await evaluate(cdp, panelSessionId, `({
        busy: state.busy,
        bridgeStatus: state.bridgeStatus,
        settingsStatus: elements.settingsStatus.textContent,
        endpoint: elements.inputs.bridgeEndpoint.value,
        activeTab: state.activeTab,
        permissionLogs: state.evaluationLogs.filter((entry) => String(entry.kind || "").includes("permission")).slice(-3)
      })`);
      throw new Error(`${error.message} Bridge UI diagnostic: ${JSON.stringify(diagnostic)}`);
    }
    const oneClickBridge = await evaluate(cdp, panelSessionId, `({
        status: state.bridgeStatus,
        storedEndpoint: state.settings.bridgeEndpoint,
        inputValue: elements.inputs.bridgeEndpoint.value,
        settingsStatus: elements.settingsStatus.textContent
      })`);
    assert.equal(connectedBridge.data.connected, true, oneClickBridge.settingsStatus);
    assert.equal(connectedBridge.data.paired, true);
    assert.equal(connectedBridge.data.runtime.armed, true);
    assert.equal(connectedBridge.data.runtime.sharedTab.tabId, firstTabId);
    assert.equal(oneClickBridge.storedEndpoint, companion.endpoints.extension);
    assert.equal(oneClickBridge.inputValue, companion.endpoints.extension);
    assert.doesNotMatch(oneClickBridge.inputValue, /#pair=/);
    assert.equal(companion.extensionConnected, true);
    assert.equal(companion.pairingCode, null, "the one-time pairing code must be consumed");

    if (process.argv.includes("--capture-docs")) {
      await evaluate(cdp, panelSessionId, `(async () => {
        await loadSettings();
        await refreshBridgeStatus();
        openSettings();
        activateSettingsTab("bridge");
        elements.inputs.bridgeEnabled.checked = true;
        hideRestrictedPage();
        document.querySelector(".settings-body")?.scrollTo({ top: 0 });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return true;
      })()`);
      await capturePanelScreenshot(cdp, panelSessionId, "bridge-settings.png");
      await evaluate(cdp, panelSessionId, "closeSettings(); true");
    }

    mcpClient = new Client(
      { name: "real-chrome-bridge-e2e", version: "1.0.0" },
      { capabilities: {} }
    );
    const mcpTransport = new StreamableHTTPClientTransport(new URL(companion.endpoints.mcp), {
      requestInit: {
        headers: { Authorization: `Bearer ${companion.mcpToken}` }
      }
    });
    await mcpClient.connect(mcpTransport);

    const bridgeGoal = "Inspect the shared page and enter the approved test value in the Name field.";
    const begunTask = toolData(await mcpClient.callTool({
      name: "browser_begin",
      arguments: { goal: bridgeGoal }
    }));
    assert.equal(begunTask.status, "ready");
    assert.equal(Object.hasOwn(begunTask, "session_id"), false);
    assert.equal(Object.hasOwn(begunTask, "observation_id"), false);
    const bridgeNameInput = begunTask.page.interactiveElements.find(
      (element) => element.label === "Name"
    );
    assert.ok(bridgeNameInput?.ref, "the MCP observation must expose a runtime-bound Name ref");

    const readOnlyOperation = toolData(await mcpClient.callTool({
      name: "browser_act",
      arguments: {
        actions: [{
          id: "extract-visible-page",
          type: "extract",
          reason: "Verify a read-only operation through the complete Bridge path."
        }]
      }
    }));
    assert.equal(readOnlyOperation.status, "completed");
    assert.match(readOnlyOperation.operation.result.results[0].result.text, /First page/);

    const continuedTask = toolData(await mcpClient.callTool({
      name: "browser_continue",
      arguments: {}
    }));
    assert.equal(continuedTask.status, "ready");
    const currentNameInput = continuedTask.page.interactiveElements.find(
      (element) => element.label === "Name"
    );
    assert.ok(currentNameInput?.ref);

    const approvalOperation = toolData(await mcpClient.callTool({
      name: "browser_act",
      arguments: {
        actions: [{
          id: "fill-name-after-approval",
          type: "fill",
          ref: currentNameInput.ref,
          value: "bridge-approved",
          reason: "Set the non-sensitive test field after explicit extension approval."
        }]
      }
    }));
    assert.equal(approvalOperation.status, "approval_required");
    assert.equal(approvalOperation.operation.status, "waiting_approval");
    assert.equal(approvalOperation.operation.approval.required, true);

    const pendingApprovals = await extensionMessage(cdp, panelSessionId, {
      type: "LIST_EXTERNAL_APPROVALS"
    });
    assert.equal(pendingApprovals.ok, true);
    assert.equal(pendingApprovals.data.operations.length, 1);
    const pendingOperationId = pendingApprovals.data.operations[0].operation_id;

    if (process.argv.includes("--capture-docs")) {
      await evaluate(cdp, panelSessionId, `(async () => {
        await refreshBridgeStatus();
        state.externalApprovals = state.externalApprovals.map((operation) => ({
          ...operation,
          actions: operation.actions.map((action) => ({
            ...action,
            reason: "Change a non-sensitive field on the shared test page."
          })),
          policy: {
            ...(operation.policy || {}),
            message: "The extension policy requires explicit approval for this shared-page state change."
          }
        }));
        renderExternalApprovalPanel();
        closeSettings();
        hideRestrictedPage();
        elements.statusLine.textContent = "Bridge · Sharing test tab";
        elements.externalApprovalPanel.scrollIntoView({ block: "start" });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return true;
      })()`);
      await capturePanelScreenshot(cdp, panelSessionId, "bridge-approval.png");
    }

    const approvedOperation = await extensionMessage(cdp, panelSessionId, {
      type: "APPROVE_EXTERNAL_OPERATION",
      operationId: pendingOperationId
    });
    assert.equal(approvedOperation.ok, true);
    assert.equal(approvedOperation.data.operation.status, "completed");

    const completedTask = toolData(await mcpClient.callTool({
      name: "browser_continue",
      arguments: {}
    }));
    assert.equal(completedTask.status, "ready");
    assert.equal(completedTask.last_operation.status, "completed");
    assert.ok(completedTask.last_operation.evidence?.id);
    assert.equal(await readInputValue(cdp, firstTargetId), "bridge-approved");

    const closedSession = toolData(await mcpClient.callTool({
      name: "browser_end",
      arguments: {}
    }));
    assert.equal(closedSession.closed, true);

    const visualSettingsSnapshot = await evaluate(cdp, panelSessionId, `(async () => {
      const stored = await chrome.storage.local.get("settings");
      await chrome.storage.local.set({
        settings: {
          ...(stored.settings || {}),
          apiProfile: "openai-responses",
          apiEndpoint: ${JSON.stringify(`${origin}/mock-visual-ai`)},
          model: "e2e-visual-model",
          includeScreenshot: true,
          structuredOutput: true,
          maxApiRetries: 0,
          bridgeRequireApproval: true,
          policyGuardEnabled: false
        }
      });
      return stored.settings || {};
    })()`);
    const targetPageSessionId = await attach(cdp, firstTargetId);
    await evaluate(
      cdp,
      targetPageSessionId,
      "document.querySelector('#visual-status').textContent = 'Visual surface idle'; true"
    );
    const visualTargetActivated = await evaluate(cdp, panelSessionId, `(async () => {
      const tab = await chrome.tabs.update(${JSON.stringify(firstTabId)}, { active: true });
      return Boolean(tab?.active);
    })()`);
    assert.equal(visualTargetActivated, true);

    const visualTask = toolData(await mcpClient.callTool({
      name: "browser_begin",
      arguments: {
        goal: "Use the visible canvas to activate the green Apply area and verify the result."
      }
    }));
    const bridgeVisualSurface = visualTask.page.visualSurfaces.find(
      (surface) => surface.label === "Visual command surface"
    );
    assert.ok(bridgeVisualSurface?.ref, "the Bridge observation must expose the current visual surface");

    const visualProposal = toolData(await mcpClient.callTool({
      name: "browser_visual_act",
      arguments: {
        surface_ref: bridgeVisualSurface.ref,
        target_description: "green Apply area",
        reason: "Activate the requested visible canvas control."
      }
    }));
    assert.equal(visualProposal.status, "approval_required");
    assert.equal(visualProposal.operation.status, "waiting_approval");

    const visualApprovals = await extensionMessage(cdp, panelSessionId, {
      type: "LIST_EXTERNAL_APPROVALS"
    });
    const visualPendingOperation = visualApprovals.data.operations.find(
      (operation) => operation.status === "waiting_approval"
    );
    assert.ok(visualPendingOperation?.operation_id);
    const approvedVisualOperation = await extensionMessage(cdp, panelSessionId, {
      type: "APPROVE_EXTERNAL_OPERATION",
      operationId: visualPendingOperation.operation_id
    });
    assert.equal(approvedVisualOperation.ok, true);
    assert.equal(approvedVisualOperation.data.operation.status, "completed");

    const visualCompletion = toolData(await mcpClient.callTool({
      name: "browser_continue",
      arguments: {}
    }));
    assert.equal(visualCompletion.status, "ready");
    assert.match(visualCompletion.page.visibleText, /Visual apply complete/);
    const visualModelStats = await (await fetch(`${origin}/mock-visual-ai-stats`)).json();
    assert.deepEqual(visualModelStats, { intent: 1, locator: 2, verifier: 2, imageInputs: 4 });
    const closedVisualSession = toolData(await mcpClient.callTool({
      name: "browser_end",
      arguments: {}
    }));
    assert.equal(closedVisualSession.closed, true);
    await evaluate(cdp, panelSessionId, `chrome.storage.local.set({
      settings: ${JSON.stringify(visualSettingsSnapshot)}
    })`);

    if (process.argv.includes("--local-harness")) {
      await runLocalHarnessBridgeScenario({
        cdp,
        companion,
        firstTargetId,
        panelSessionId,
      });
    }
    if (process.env.WEB_PLUGIN_LIVE_URL) {
      await runConfiguredLiveSiteSmoke({ cdp, panelSessionId });
    }

    const detachedBridge = await extensionMessage(cdp, panelSessionId, {
      type: "DETACH_BRIDGE_TAB"
    });
    assert.equal(detachedBridge.ok, true);
    assert.equal(detachedBridge.data.runtime.armed, false);

    const revokedBridge = await extensionMessage(cdp, panelSessionId, {
      type: "REVOKE_BRIDGE"
    });
    assert.equal(revokedBridge.ok, true);
    assert.equal(revokedBridge.data.paired, false);
    await poll(async () => companion.extensionConnected, (connected) => connected === false, 5_000);

    await mcpClient.close();
    mcpClient = null;

    process.stdout.write("Real Chrome extension E2E passed: grounded multi-frame observation, hidden-frame exclusion, nested scrolling, visual surfaces, bounded approvals, files, tabs, worker restart, and the authenticated MCP Bridge flow.\n");
  } finally {
    cdp.close();
  }
} finally {
  await mcpClient?.close().catch(() => {});
  await companion?.close().catch(() => {});
  if (browserProcess && browserProcess.exitCode === null) {
    browserProcess.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => browserProcess.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000))
    ]);
  }
  await new Promise((resolve) => server?.close(resolve) || resolve());
  await new Promise((resolve) => frameServer?.close(resolve) || resolve());
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function prepareTestExtension() {
  await cp(root, extensionRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(root, source);
      return !relative.startsWith(".git") && !relative.startsWith("node_modules") && !relative.startsWith(".idea");
    }
  });
  const manifestPath = path.join(extensionRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  manifest.key = publicKeyDer.toString("base64");
  // Headless Chrome cannot grant activeTab through a toolbar click, so the
  // disposable E2E copy receives screenshot access without changing the
  // production manifest's optional-host-permission policy.
  manifest.host_permissions = ["<all_urls>"];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const digest = createHash("sha256").update(publicKeyDer).digest().subarray(0, 16);
  return Array.from(digest)
    .flatMap((byte) => [byte >> 4, byte & 15])
    .map((nibble) => String.fromCharCode("a".charCodeAt(0) + nibble))
    .join("");
}

async function resolveChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-for-testing"
  ].filter(Boolean);

  const playwrightCache = path.join(homedir(), "Library", "Caches", "ms-playwright");
  const installs = await readdir(playwrightCache, { withFileTypes: true }).catch(() => []);
  for (const install of installs.filter((entry) => entry.isDirectory() && entry.name.startsWith("chromium-"))) {
    candidates.unshift(path.join(
      playwrightCache,
      install.name,
      "chrome-mac-arm64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing"
    ));
  }

  for (const candidate of candidates) {
    if (await access(candidate).then(() => true).catch(() => false)) {
      return candidate;
    }
  }
  throw new Error("Chrome for Testing or Chromium is required. Set CHROME_PATH to an extension-capable browser binary.");
}

async function startFixtureServer() {
  visualAiCallCounts = { intent: 0, locator: 0, verifier: 0, imageInputs: 0 };
  frameServer = createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.url?.startsWith("/hidden-cross-frame")) {
      response.end(`<!doctype html><html><body><p>Hidden cross-frame fact</p><button>Hidden cross-frame action</button></body></html>`);
      return;
    }
    if (request.url?.startsWith("/covered-cross-frame")) {
      response.end(`<!doctype html><html><body><p>Covered cross-frame fact</p><button>Covered cross-frame action</button></body></html>`);
      return;
    }
    response.end(`<!doctype html><html><body>
      <label for="cross-frame-name">Cross Frame Name</label>
      <input id="cross-frame-name">
      <button id="cross-frame-action" type="button">Cross Frame Action</button>
      <div id="cross-frame-status" role="status">Cross frame ready</div>
      <script>
        document.querySelector('#cross-frame-action').addEventListener('click', () => {
          document.querySelector('#cross-frame-status').textContent = 'Cross frame action complete';
        });
      </script>
    </body></html>`);
  });
  await new Promise((resolve, reject) => {
    frameServer.once("error", reject);
    frameServer.listen(0, "127.0.0.1", resolve);
  });
  const frameAddress = frameServer.address();
  const frameOrigin = `http://127.0.0.1:${frameAddress.port}`;

  server = createServer(async (request, response) => {
    if (request.url?.startsWith("/mock-visual-ai-stats")) {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify(visualAiCallCounts));
      return;
    }
    if (request.url?.startsWith("/mock-visual-ai")) {
      const body = await readJsonRequest(request);
      const instructions = String(body.instructions || "");
      const hasImage = (body.input || []).some((message) => (
        (message.content || []).some((item) => item.type === "input_image" && item.image_url)
      ));
      if (hasImage) {
        visualAiCallCounts.imageInputs += 1;
      }

      let payload;
      if (
        instructions.includes("immutable repetition boundary")
        || instructions.includes("resolve one immutable browser-task intent")
      ) {
        visualAiCallCounts.intent += 1;
        payload = {
          version: "1.0",
          mode: "standalone",
          objective: "Click the visible Apply target once.",
          contextSummary: "",
          repeatPolicy: "once",
          repeatLimit: 1,
          deliverable: {
            kind: "effect",
            itemDescription: "",
            targetCount: null,
            fields: [],
            includeCriteria: []
          },
          completionCriteria: ["The visible Apply target has been clicked once."],
          reason: "The goal requests one complete visual action."
        };
      } else if (instructions.includes("visual target locator")) {
        visualAiCallCounts.locator += 1;
        payload = {
          version: "1.0",
          status: "found",
          message: "The requested Apply target is unambiguous inside the current surface.",
          targetDescription: "green Apply area",
          xNormalized: 750,
          yNormalized: 500,
          confidence: 0.99
        };
      } else if (instructions.includes("independent visual-action verifier")) {
        visualAiCallCounts.verifier += 1;
        const evidenceId = JSON.stringify(body).match(/visual-evidence-[a-z0-9]+/)?.[0] || "";
        payload = {
          version: "1.0",
          status: "verified",
          message: "The proposed point matches the visible Apply target.",
          evidenceIds: [evidenceId],
          missingEvidence: [],
          confidence: 0.99
        };
      } else {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: { message: "Unexpected visual model request." } }));
        return;
      }

      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        id: `resp-e2e-visual-${visualAiCallCounts.intent + visualAiCallCounts.locator + visualAiCallCounts.verifier}`,
        status: "completed",
        model: "e2e-visual-model",
        output: [{
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: JSON.stringify(payload), annotations: [] }]
        }],
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 }
      }));
      return;
    }
    if (request.url?.startsWith("/mock-empty-ai")) {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        id: "resp-e2e-empty",
        status: "completed",
        model: "e2e-model",
        output: [],
        usage: { input_tokens: 9, output_tokens: 0, total_tokens: 9 }
      }));
      return;
    }
    if (request.url?.startsWith("/mock-ai")) {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        id: "resp-e2e",
        status: "completed",
        model: "e2e-model",
        output: [{
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "Audit path works.", annotations: [] }]
        }],
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          total_tokens: 16,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 1 }
        }
      }));
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.url?.startsWith("/frame")) {
      response.end(`<!doctype html><html><body><label for="frame-name">Frame Name</label><input id="frame-name"></body></html>`);
      return;
    }
    if (request.url?.startsWith("/legacy-frameset")) {
      response.end(`<!doctype html><html><head><title>Legacy frameset</title></head>
        <frameset cols="50%,50%">
          <frame name="legacy-left" src="/legacy-frame">
          <frame name="legacy-right" src="/legacy-frame">
        </frameset>
      </html>`);
      return;
    }
    if (request.url?.startsWith("/legacy-frame")) {
      response.end(`<!doctype html><html><body style="margin:4px;font:11px sans-serif">
        <button id="legacy-frame-action" type="button"></button>
        <div id="legacy-frame-status" role="status"></div>
        <script>
          const label = 'Legacy ' + window.name;
          document.querySelector('#legacy-frame-action').textContent = label + ' action';
          document.querySelector('#legacy-frame-status').textContent = label + ' ready';
          document.querySelector('#legacy-frame-action').addEventListener('click', () => {
            document.querySelector('#legacy-frame-status').textContent = label + ' complete';
          });
        </script>
      </body></html>`);
      return;
    }
    const second = request.url?.startsWith("/page-b");
    const candidateProbes = Array.from({ length: 24 }, (_, index) => (
      `<button type="button" aria-label="Candidate probe ${index + 1}">${index + 1}</button>`
    )).join("");
    const denseGridCells = Array.from({ length: 120 }, (_, index) => (
      `<button type="button" aria-label="Dense grid cell ${index + 1}">${index + 1}</button>`
    )).join("");
    response.end(`<!doctype html><html><head><title>${second ? "Second" : "First"} tab</title><style>
      body { overflow-y: scroll; }
      #interaction-lab { position: relative; width: 520px; height: 96px; margin-top: 12px; }
      #covered-action { position: absolute; inset: 0 auto auto 0; width: 130px; height: 34px; }
      #action-cover { position: absolute; inset: 0 auto auto 0; width: 130px; height: 34px; z-index: 2; background: white; pointer-events: none; }
      #pointer-action { position: absolute; left: 0; top: 50px; cursor: pointer; padding: 6px; border: 1px solid #333; }
      #clipped-shell { position: absolute; left: 180px; top: 0; width: 130px; height: 34px; overflow: hidden; }
      #clipped-action { position: absolute; left: 0; top: 60px; width: 120px; height: 30px; }
      iframe { width: 180px; height: 70px; }
      #candidate-probes { position: fixed; left: 570px; top: 8px; z-index: 1; display: grid; grid-template-columns: repeat(6, 32px); gap: 2px; }
      #candidate-probes button { box-sizing: border-box; width: 32px; height: 14px; min-width: 0; padding: 0; overflow: hidden; font-size: 7px; }
      #dense-grid { position: fixed; left: 600px; top: 205px; z-index: 2; width: 190px; display: grid; grid-template-columns: repeat(10, 16px); gap: 1px; padding: 2px; background: white; }
      #dense-grid button { box-sizing: border-box; width: 16px; height: 12px; min-width: 0; padding: 0; overflow: hidden; font-size: 6px; }
      #dense-next-page { grid-column: 1 / -1; width: 100% !important; height: 16px !important; font-size: 8px !important; }
      #visual-first-candidate { position: fixed; left: 540px; top: 1px; z-index: 2; width: 24px; height: 14px; padding: 0; font-size: 0; }
      #robustness-lab { position: fixed; left: 540px; top: 82px; z-index: 1; width: 240px; font: 12px sans-serif; }
      #display-contents-copy { display: contents; }
      #svg-action { display: block; width: 130px; height: 32px; margin-top: 6px; cursor: pointer; }
      #delegated-action { cursor: pointer; margin-top: 6px; }
      #nested-scroll { width: 260px; height: 76px; overflow: auto; border: 1px solid #94a3b8; }
      #nested-scroll-content { height: 280px; padding-top: 210px; box-sizing: border-box; }
      #visual-canvas { display: block; width: 240px; height: 80px; margin-top: 8px; }
      #advanced-structure-lab { position: fixed; right: 8px; bottom: 8px; z-index: 4; width: 270px; padding: 4px; background: white; }
      #legacy-pagination { position: fixed; left: 300px; top: 82px; z-index: 5; width: 220px; padding: 4px; background: white; font: 12px sans-serif; }
      #legacy-pagination ul { display: flex; gap: 8px; margin: 2px 0; padding: 0; list-style: none; }
      #relational-controls { position: fixed; left: 300px; top: 330px; z-index: 6; width: 250px; padding: 6px; background: white; border: 1px solid #cbd5e1; font: 12px sans-serif; }
      #relational-controls .relation-field { display: grid; grid-template-columns: 1fr 28px; align-items: center; gap: 6px; margin: 4px 0; }
      #relational-controls button { width: 28px; height: 24px; padding: 0; }
      #hidden-cross-frame { display: none; }
      #covered-frame-shell { position: fixed; left: 300px; bottom: 8px; z-index: 3; width: 180px; height: 70px; }
      #covered-frame-shell iframe { position: absolute; inset: 0; margin: 0; }
      #covered-frame-overlay { position: absolute; inset: 0 auto 0 0; z-index: 1; width: 70px; background: white; }
      #structured-collection { margin-top: 16px; font: 12px sans-serif; }
      #structured-collection table { border-collapse: collapse; }
      #structured-collection td { padding: 2px 8px; }
      #structured-collection .offscreen-record { transform: translateY(1200px); }
      #structured-collection .display-none-record { display: none; }
      #structured-collection .content-hidden-record { content-visibility: hidden; }
      #structured-collection .opacity-hidden-record { opacity: 0; }
      #offscreen-section { margin-top: 1300px; min-height: 280px; }
    </style></head><body>
      <h1>${second ? "Second" : "First"} page</h1>
      <div style="display:none">Hidden DOM fact</div>
      <div id="candidate-probes" aria-label="Candidate limit fixtures">${candidateProbes}</div>
      <div id="dense-grid" role="grid" aria-label="Dense issue grid">
        ${denseGridCells}
        <button id="dense-next-page" type="button" aria-label="Dense grid next page">&gt;</button>
      </div>
      <div id="interaction-lab">
        <button id="covered-action" type="button">Covered action</button>
        <div id="action-cover">Visible cover</div>
        <div id="pointer-action"><span>Pointer action</span></div>
        <div id="clipped-shell"><button id="clipped-action" type="button">Clipped action</button></div>
      </div>
      <div id="pointer-status" role="status">Pointer idle</div>
      <div id="legacy-pagination">
        <div>[1/5] [총 478건]</div>
        <div class="pageSkip">
          <ul>
            <li><span>1</span></li>
            <li><a href="javascript:legacySearch(2);">2</a></li>
            <li><a href="javascript:legacySearch(3);">3</a></li>
          </ul>
        </div>
        <div id="legacy-page-status" role="status">Legacy page 1 loaded</div>
      </div>
      <div id="relational-controls" role="group" aria-label="Workflow filters">
        <div class="relation-field">
          <span>Request form</span>
          <button id="request-form-options" type="button" aria-label="Request form options" aria-haspopup="listbox" aria-expanded="false">▼</button>
        </div>
        <div class="relation-field">
          <span>Request type</span>
          <button id="request-type-lookup" type="button">
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14">
              <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor"></circle>
              <path d="M9 9l4 4" stroke="currentColor"></path>
            </svg>
          </button>
        </div>
      </div>
      <div id="robustness-lab">
        <div id="display-contents-copy">Display contents direct visible fact</div>
        <svg id="svg-action" role="button" tabindex="0" aria-label="SVG action" viewBox="0 0 130 32">
          <rect width="130" height="32" rx="4" fill="#dbeafe"></rect>
          <text x="65" y="20" text-anchor="middle">SVG action</text>
        </svg>
        <div id="svg-status" role="status">SVG idle</div>
        <details id="delegated-details">
          <summary id="delegated-action"><span id="delegated-child">Delegated child target</span></summary>
          <div>Delegated native activation revealed</div>
        </details>
        <div id="delegated-status" role="status">Delegated idle</div>
      </div>
      <label for="name">Name</label>
      <input id="name" value="${second ? "second-tab" : "first-tab"}">
      <label for="email">Email</label>
      <input id="email" type="email" value="private@example.com">
      <button id="save" type="button">Save</button>
      <div role="status">Ready</div>
      <div id="shadow-host"></div>
      <iframe title="Same-origin frame" src="/frame"></iframe>
      <iframe title="Cross-origin frame" src="${frameOrigin}/cross-frame"></iframe>
      <iframe id="hidden-cross-frame" title="Hidden cross-origin frame" src="${frameOrigin}/hidden-cross-frame"></iframe>
      <div id="covered-frame-shell">
        <iframe title="Covered cross-origin frame" src="${frameOrigin}/covered-cross-frame"></iframe>
        <div id="covered-frame-overlay">Visible frame cover</div>
      </div>
      <iframe title="Metadata-only frame" src="data:text/html,%3Cbody%3EOpaque%20frame%3C%2Fbody%3E"></iframe>
      <div id="advanced-structure-lab">
        <div id="nested-scroll" role="region" aria-label="Scrollable results">
          <div id="nested-scroll-content">
            <button id="nested-scroll-action" type="button">Nested scroll action</button>
          </div>
        </div>
        <canvas id="visual-canvas" width="240" height="80" aria-label="Visual command surface"></canvas>
        <div id="visual-status" role="status">Visual surface idle</div>
      </div>
      <label for="upload">Upload document</label>
      <input id="upload" type="file" accept="text/plain">
      <button id="async" type="button">Start async</button>
      <div id="async-status" role="status">Idle</div>
      <section id="structured-collection" aria-label="Structured result fixture">
        <table aria-label="Layout table"><tbody><tr><td>
          <table aria-label="Nested result table"><tbody>
            <tr class="result-record notice-record">
              <td>Notice</td>
              <td><a href="/records?board=general&amp;record=notice&amp;session_token=fixture-private-token">Pinned maintenance notice</a></td>
              <td>Staff</td>
            </tr>
            <tr class="result-record">
              <td><a href="/records?board=general&amp;record=101&amp;session_token=fixture-private-token">101</a></td>
              <td><a id="structured-exemplar" href="/records?board=general&amp;record=101&amp;session_token=fixture-private-token" title="A complete first record title">A short first title…</a></td>
              <td>2026-07-24</td>
            </tr>
            <tr class="result-record offscreen-record">
              <td><a href="/records?board=general&amp;record=102&amp;session_token=fixture-private-token">102</a></td>
              <td><a href="/records?board=general&amp;record=102&amp;session_token=fixture-private-token" aria-label="A complete offscreen second record title">Second title…</a></td>
              <td>private@example.com</td>
            </tr>
            <tr class="result-record">
              <td><a href="/records?board=general&amp;record=103&amp;session_token=fixture-private-token">103</a></td>
              <td><a href="/records?board=general&amp;record=103&amp;session_token=fixture-private-token" title="Open">A third rendered record title</a></td>
              <td>2026-07-22</td>
            </tr>
            <tr class="result-record">
              <td><a href="/records?board=general&amp;record=104&amp;session_token=fixture-private-token">104</a></td>
              <td><a href="/records?board=general&amp;record=104&amp;session_token=fixture-private-token" title="Open">2026</a></td>
              <td>2026-07-21</td>
            </tr>
            <tr class="result-record display-none-record">
              <td><a href="/records?board=general&amp;record=105&amp;session_token=fixture-private-token">105</a></td>
              <td><a href="/records?board=general&amp;record=105&amp;session_token=fixture-private-token">Display-none record</a></td>
              <td>2026-07-20</td>
            </tr>
            <tr class="result-record content-hidden-record">
              <td><a href="/records?board=general&amp;record=106&amp;session_token=fixture-private-token">106</a></td>
              <td><a href="/records?board=general&amp;record=106&amp;session_token=fixture-private-token">Content-hidden record</a></td>
              <td>2026-07-19</td>
            </tr>
            <tr class="result-record opacity-hidden-record">
              <td><a href="/records?board=general&amp;record=107&amp;session_token=fixture-private-token">107</a></td>
              <td><a href="/records?board=general&amp;record=107&amp;session_token=fixture-private-token">Opacity-hidden record</a></td>
              <td>2026-07-18</td>
            </tr>
          </tbody></table>
        </td><td><a href="/layout-help">Layout help</a></td></tr></tbody></table>
      </section>
      <section id="offscreen-section">
        <p>Offscreen viewport fact</p>
        <button id="offscreen-action" type="button">Offscreen action</button>
      </section>
      <button id="visual-first-candidate" type="button" aria-label="Visual-first late candidate"></button>
      <script>
        const root = document.querySelector('#shadow-host').attachShadow({mode:'open'});
        root.innerHTML = '<label for="shadow-name">Shadow Name</label><input id="shadow-name">';
        window.legacySearch = (page) => {
          document.querySelector('#legacy-page-status').textContent = 'Legacy page ' + page + ' loaded';
        };
        document.querySelector('#async').addEventListener('click', () => {
          setTimeout(() => { document.querySelector('#async-status').textContent = 'Async complete'; }, 180);
        });
        const pointerAction = document.querySelector('#pointer-action');
        pointerAction.addEventListener('pointerdown', () => { pointerAction.dataset.pointerArmed = 'true'; });
        pointerAction.addEventListener('click', () => {
          document.querySelector('#pointer-status').textContent = pointerAction.dataset.pointerArmed === 'true'
            ? 'Pointer sequence complete'
            : 'Pointer sequence missing';
        });
        document.querySelector('#svg-action').addEventListener('click', () => {
          document.querySelector('#svg-status').textContent = 'SVG action complete';
        });
        document.querySelector('#delegated-action').addEventListener('click', (event) => {
          document.querySelector('#delegated-status').textContent = 'Delegated target ' + event.target.id;
        });
        const visualCanvas = document.querySelector('#visual-canvas');
        const visualContext = visualCanvas.getContext('2d');
        visualContext.fillStyle = '#2563eb';
        visualContext.fillRect(0, 0, 120, 80);
        visualContext.fillStyle = '#16a34a';
        visualContext.fillRect(120, 0, 120, 80);
        visualContext.fillStyle = '#ffffff';
        visualContext.font = '16px sans-serif';
        visualContext.fillText('Inspect', 32, 46);
        visualContext.fillText('Apply', 158, 46);
        visualCanvas.addEventListener('click', (event) => {
          document.querySelector('#visual-status').textContent = event.offsetX >= 120
            ? 'Visual apply complete'
            : 'Visual inspect complete';
        });
      </script>
    </body></html>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function readJsonRequest(request) {
  let source = "";
  for await (const chunk of request) {
    source += chunk;
  }
  return JSON.parse(source || "{}");
}

async function readDebugPort(profile) {
  const file = path.join(profile, "DevToolsActivePort");
  const text = await poll(async () => readFile(file, "utf8").catch(() => ""), Boolean, 20000);
  return Number(text.split(/\r?\n/)[0]);
}

async function waitForJson(url) {
  return poll(async () => {
    const response = await fetch(url).catch(() => null);
    return response?.ok ? response.json() : null;
  }, Boolean, 10000);
}

async function waitForTarget(cdp, predicate) {
  return poll(async () => {
    const { targetInfos } = await cdp.send("Target.getTargets");
    return targetInfos.find(predicate) || null;
  }, Boolean, 20000);
}

async function createPage(cdp, url) {
  const { targetId } = await cdp.send("Target.createTarget", { url });
  const sessionId = await attach(cdp, targetId);
  await waitForReady(cdp, sessionId);
  return targetId;
}

async function attach(cdp, targetId) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId).catch(() => {});
  return sessionId;
}

async function waitForReady(cdp, sessionId) {
  await poll(async () => {
    const result = await evaluate(cdp, sessionId, "document.readyState").catch(() => "");
    return result === "complete" ? result : "";
  }, Boolean, 15000);
}

async function queryTabId(cdp, sessionId, urlPrefix) {
  return evaluate(cdp, sessionId, `(async () => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((item) => String(item.url || "").startsWith(${JSON.stringify(urlPrefix)}));
    return tab?.id || 0;
  })()`);
}

async function exercisePanelContracts({ cdp, panelSessionId, tabId, context }) {
  await poll(
    async () => evaluate(cdp, panelSessionId, "Boolean(state?.activeTab && elements?.conversationWorkspace)"),
    Boolean,
    15_000
  );
  const testTabIds = [970001, 970002];
  const testUrl = "https://example.test/panel-contract";
  let initialized = false;
  try {
    await evaluate(cdp, panelSessionId, `(() => {
      globalThis.__panelContractSnapshot = {
        settings: structuredClone(state.settings),
        runtimeSettings: structuredClone(state.runtimeSettings),
        activeTab: state.activeTab ? { ...state.activeTab } : null,
        lastContext: state.lastContext ? structuredClone(state.lastContext) : null,
        conversation: structuredClone(state.conversation),
        pickedElement: state.pickedElement ? structuredClone(state.pickedElement) : null,
        undoStack: structuredClone(state.undoStack),
        evaluationLogs: structuredClone(state.evaluationLogs),
        currentPlan: state.currentPlan,
        externalApprovals: structuredClone(state.externalApprovals),
        selectedExternalOperationId: state.selectedExternalOperationId,
        statusText: elements.statusLine.textContent,
        contextStatus: elements.contextStatus.textContent,
        utilityMenuOpen: elements.utilityMenu.open,
        templatePopoverOpen: elements.templatePopover.open
      };
      state.settings = { ...state.settings, uiLanguage: "ko" };
      applySettingsToForm();
      applyUiLanguage();
      resetTabScopedState();
      applyActiveTabSummary({
        id: ${JSON.stringify(tabId)},
        title: ${JSON.stringify(context.title || "Agent test dashboard")},
        url: ${JSON.stringify(context.url)}
      });
      state.lastContext = ${JSON.stringify(context)};
      state.runtimeSettings = { ...state.settings, includeScreenshot: false, agentMode: "approve" };
      for (let index = 1; index <= 18; index += 1) {
        appendChatMessage(
          index % 2 ? "user" : "assistant",
          "이전 대화 " + index + ": 승인 화면에서도 확인해야 하는 내용입니다.",
          { record: false }
        );
      }
      startRunTimeline("좁은 패널 작업 흐름 검증");
      updateRunTimeline("observe", "active", "현재 화면을 읽는 중");
      const actionTarget = state.lastContext.interactiveElements.find((item) => item.rect)
        || state.lastContext.interactiveElements[0];
      globalThis.__panelContractDecision = {
        version: "1.0",
        status: "continue",
        message: "현재 화면의 대상 하나를 클릭하려고 합니다.",
        summary: "클릭 승인 요청",
        progress: "현재 화면에서 실행 대상을 확인했습니다.",
        doneReason: "",
        completionEvidence: [],
        needsUserApproval: true,
        plan: ["현재 화면 확인", "대상 확인", "클릭", "변화 재확인"],
        toolCalls: [],
        actions: [{ id: "panel-layout-click", type: "click", ref: actionTarget.ref, reason: "승인 레이아웃 검증" }],
        verification: { required: true, expectedChange: "화면 변화", successCriteria: ["변경된 화면을 다시 관찰"] },
        safety: { warnings: ["화면이 바뀔 수 있습니다."], requiresApproval: ["클릭 실행"], blocked: [] }
      };
      globalThis.__panelContractExternalApprovals = [
        {
          operation_id: "external-one",
          actions: [{ type: "click", ref: actionTarget.ref, reason: "첫 번째 요청" }],
          safety: { approvalReasons: ["상태 변경"] },
          policy: { message: "첫 번째 외부 요청", risks: [] },
          approval: {}
        },
        {
          operation_id: "external-two",
          actions: [
            { type: "focus", ref: actionTarget.ref, reason: "두 번째 요청" },
            { type: "click", ref: actionTarget.ref, reason: "두 번째 요청" }
          ],
          safety: { approvalReasons: ["상태 변경"] },
          policy: { message: "두 번째 외부 요청", risks: [] },
          approval: {}
        }
      ];
      hideApprovalPanel();
      state.externalApprovals = [structuredClone(globalThis.__panelContractExternalApprovals[0])];
      state.selectedExternalOperationId = "external-one";
      closeTransientMenus();
      renderExternalApprovalPanel();
    })()`);
    initialized = true;

    const layouts = [];
    for (const viewport of [
      { width: 420, height: 600 },
      { width: 360, height: 640 },
      { width: 300, height: 640 },
      { width: 240, height: 600 }
    ]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        ...viewport,
        deviceScaleFactor: 1,
        mobile: false
      }, panelSessionId);
      layouts.push(await evaluate(cdp, panelSessionId, `(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const topbarRect = document.querySelector(".topbar").getBoundingClientRect();
        const composerRect = elements.composer.getBoundingClientRect();
        const chatRect = elements.messageList.getBoundingClientRect();
        const approvalRect = elements.externalApprovalPanel.getBoundingClientRect();
        const activityDockRect = elements.activityDock.getBoundingClientRect();
        const inputRect = elements.chatInput.getBoundingClientRect();
        const sendRect = elements.sendButton.getBoundingClientRect();
        const composerStyle = getComputedStyle(elements.composer);
        const layout = {
          width: innerWidth,
          height: innerHeight,
          documentOverflow: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1
            || document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          topbarHeight: Math.round(topbarRect.height),
          composerHeight: Math.round(composerRect.height),
          chatHeight: Math.round(chatRect.height),
          activityDockHeight: Math.round(activityDockRect.height),
          activityDockCardCount: elements.activityDock.querySelectorAll(".activity-card").length,
          activityDockCollapsed: !state.agentRunUi?.article?.open,
          activityDockNoHorizontalOverflow:
            elements.activityDock.scrollWidth <= elements.activityDock.clientWidth + 1,
          externalApprovalHeight: Math.round(approvalRect.height),
          composerVisible: !elements.composer.hidden
            && composerStyle.display !== "none"
            && composerRect.top >= 0
            && composerRect.bottom <= innerHeight + 1,
          composerInputSingleRow: Math.min(inputRect.bottom, sendRect.bottom) - Math.max(inputRect.top, sendRect.top) > 0,
          templatePopoverClosed: !elements.templatePopover.open,
          externalPickerHidden: elements.externalApprovalPicker.hidden
        };

        const stressSnapshot = {
          statusText: elements.statusLine.textContent,
          utilityMenuOpen: elements.utilityMenu.open,
          templatePopoverOpen: elements.templatePopover.open
        };
        try {
          const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const roundedRect = (element) => {
            const rect = element.getBoundingClientRect();
            return {
              top: Math.round(rect.top),
              right: Math.round(rect.right),
              bottom: Math.round(rect.bottom),
              left: Math.round(rect.left),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            };
          };
          const measureControl = (element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return {
              inViewport: !element.hidden
                && style.display !== "none"
                && style.visibility !== "hidden"
                && Number(style.opacity || 1) > 0
                && rect.width > 0
                && rect.height > 0
                && rect.left >= -1
                && rect.top >= -1
                && rect.right <= innerWidth + 1
                && rect.bottom <= innerHeight + 1,
              rect: roundedRect(element)
            };
          };
          const measureContainer = (element) => ({
            noHorizontalOverflow: element.scrollWidth <= element.clientWidth + 1,
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth
          });

          elements.statusLine.textContent = "현재 요청의 범위를 고정하고 화면 내용을 확인해 완료 근거까지 남깁니다.";
          elements.utilityMenu.open = false;
          elements.templatePopover.open = false;
          await nextFrame();

          const topbarActions = {
            pickElementButton: measureControl(elements.pickElementButton),
            openSettingsButton: measureControl(elements.openSettingsButton),
            utilityMenuButton: measureControl(elements.utilityMenuButton)
          };
          const controls = {
            ...topbarActions,
            chatInput: measureControl(elements.chatInput),
            sendButton: measureControl(elements.sendButton),
            templateTrigger: measureControl(elements.templatePopover.querySelector(":scope > summary"))
          };
          const containers = {
            document: measureContainer(document.documentElement),
            topbar: measureContainer(document.querySelector(".topbar")),
            composerTools: measureContainer(document.querySelector(".composer-tools")),
            composerInputRow: measureContainer(document.querySelector(".composer-input-row"))
          };

          elements.templatePopover.open = true;
          await nextFrame();
          const templatePanel = elements.templatePopover.querySelector(".composer-popover-panel");
          controls.templatePanel = measureControl(templatePanel);
          controls.templateSelect = measureControl(elements.templateSelect);
          controls.templateTitleInput = measureControl(elements.templateTitleInput);
          controls.templatePromptInput = measureControl(elements.templatePromptInput);
          controls.newTemplateButton = measureControl(elements.newTemplateButton);
          controls.importCurrentInputButton = measureControl(elements.importCurrentInputButton);
          controls.insertTemplateButton = measureControl(elements.insertTemplateButton);
          controls.saveTemplateButton = measureControl(elements.saveTemplateButton);
          controls.deleteTemplateButton = measureControl(elements.deleteTemplateButton);
          containers.templatePanel = measureContainer(templatePanel);
          containers.templateEditor = measureContainer(templatePanel.querySelector(".template-editor"));
          containers.templateQuickActions = measureContainer(templatePanel.querySelector(".template-quick-actions"));
          containers.templateActions = measureContainer(templatePanel.querySelector(".template-actions"));

          layout.narrowStress = {
            topbarActionCount: Object.values(topbarActions).filter((measurement) => measurement.inViewport).length,
            controls,
            containers
          };
        } finally {
          elements.statusLine.textContent = stressSnapshot.statusText;
          elements.utilityMenu.open = stressSnapshot.utilityMenuOpen;
          elements.templatePopover.open = stressSnapshot.templatePopoverOpen;
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }

        const settingsWasHidden = elements.settingsModal.hidden;
        const settingsClassWasPresent = document.body.classList.contains("settings-open");
        elements.settingsModal.hidden = false;
        document.body.classList.add("settings-open");
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const tabRects = elements.settingsTabs.map((tab) => tab.getBoundingClientRect());
        const rowTops = tabRects.map((rect) => Math.round(rect.top));
        const tabsStyle = getComputedStyle(document.querySelector(".settings-tabs"));
        layout.settingsTabsSingleRow = rowTops.length > 0 && Math.max(...rowTops) - Math.min(...rowTops) <= 1;
        layout.settingsTabsScrollable = tabsStyle.overflowX === "auto" || tabsStyle.overflowX === "scroll";
        const previousSettingsTab = elements.settingsTabs.find((tab) => tab.classList.contains("active"))?.dataset.settingsTab || "general";
        activateSettingsTab("general");
        document.querySelector(".settings-body")?.scrollTo({ top: 0 });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const generalPanel = document.getElementById("generalPanel");
        const settingsGear = document.querySelector(".settings-heading-icon");
        const summaryGridStyle = getComputedStyle(document.querySelector(".settings-summary-grid"));
        layout.generalPanelNoHorizontalOverflow = generalPanel.scrollWidth <= generalPanel.clientWidth + 1;
        layout.settingsSummaryColumnCount = summaryGridStyle.gridTemplateColumns.split(" ").filter(Boolean).length;
        layout.settingsGearVisible = settingsGear.getBoundingClientRect().width > 0;
        activateSettingsTab("bridge");
        document.querySelector(".settings-body")?.scrollTo({ top: 0 });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const bridgePanel = document.getElementById("bridgePanel");
        const bridgeActions = bridgePanel.querySelector(".bridge-actions");
        layout.bridgePanelNoHorizontalOverflow = bridgePanel.scrollWidth <= bridgePanel.clientWidth + 1;
        layout.bridgeActionsNoHorizontalOverflow = bridgeActions.scrollWidth <= bridgeActions.clientWidth + 1;
        activateSettingsTab(previousSettingsTab);
        elements.settingsModal.hidden = settingsWasHidden;
        document.body.classList.toggle("settings-open", settingsClassWasPresent);
        return layout;
      })()`));
    }

    const approvalModes = await evaluate(cdp, panelSessionId, `(async () => {
      state.externalApprovals = [];
      state.selectedExternalOperationId = "";
      renderExternalApprovalPanel();
      const approvalDraft = "승인 검토 중에도 보존할 작성 중 요청";
      elements.chatInput.value = approvalDraft;
      state.currentPlan = globalThis.__panelContractDecision;
      renderApprovalPanel(globalThis.__panelContractDecision);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const approvalRect = elements.approvalPanel.getBoundingClientRect();
      const controlsRect = elements.approvalPanel.querySelector(".approval-controls").getBoundingClientRect();
      const local = {
        composerHidden: elements.composer.hidden,
        approvalStackVisible: !elements.approvalStack.hidden,
        approvalPanelFocused: document.activeElement === elements.approvalPanel,
        approvalControlsVisible: controlsRect.top >= approvalRect.top - 1
          && controlsRect.bottom <= approvalRect.bottom + 1,
        annotationHidden: elements.annotationDetails.hidden && elements.annotationPreview.hidden,
        annotationSourcePresent: elements.annotationPreview.hasAttribute("src"),
        documentOverflow: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1
          || document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      };

      rejectCurrentPlan();
      const afterReject = {
        chatInputFocused: document.activeElement === elements.chatInput,
        draftPreserved: elements.chatInput.value === approvalDraft,
        composerVisible: !elements.composer.hidden && getComputedStyle(elements.composer).display !== "none"
      };
      state.externalApprovals = [structuredClone(globalThis.__panelContractExternalApprovals[0])];
      state.selectedExternalOperationId = "external-one";
      renderExternalApprovalPanel();
      const composerRect = elements.composer.getBoundingClientRect();
      const externalOnly = {
        composerVisible: !elements.composer.hidden
          && getComputedStyle(elements.composer).display !== "none"
          && composerRect.bottom <= innerHeight + 1,
        pickerHidden: elements.externalApprovalPicker.hidden,
        requestCount: elements.externalApprovalSelect.options.length
      };

      state.externalApprovals = structuredClone(globalThis.__panelContractExternalApprovals);
      renderExternalApprovalPanel();
      const multipleExternal = {
        pickerVisible: !elements.externalApprovalPicker.hidden,
        requestCount: elements.externalApprovalSelect.options.length,
        selectedActionCount: elements.externalApprovalList.children.length
      };
      return { local, afterReject, externalOnly, multipleExternal };
    })()`);

    const functional = await evaluate(cdp, panelSessionId, `(async () => {
        startNewTemplate();
        elements.templateTitleInput.value = "릴리스 전 점검";
        elements.templatePromptInput.value = "현재 화면에서 릴리스 전 확인할 항목을 정리해줘.";
        handleTemplateDraftInput();
        await saveTemplateEditor();
        const createdTemplateId = elements.templateSelect.value;
        const savedCountAfterCreate = getSavedTaskTemplates().length;

        elements.templateTitleInput.value = "배포 전 점검";
        elements.templatePromptInput.value = "현재 화면에서 배포 전 확인할 항목과 위험을 정리해줘.";
        handleTemplateDraftInput();
        await saveTemplateEditor();
        const updatedTemplate = getSelectedTaskTemplate();
        const savedCountAfterUpdate = getSavedTaskTemplates().length;

        await deleteSelectedTemplate();
        const deleteNeedsConfirmation = state.templateDeleteConfirmationId === createdTemplateId
          && getTaskTemplates().some((item) => item.id === createdTemplateId);
        await deleteSelectedTemplate();
        const customDeleted = !getTaskTemplates().some((item) => item.id === createdTemplateId);

        elements.templateSelect.value = "summarize-page";
        renderTemplateEditor();
        elements.templateTitleInput.value = "페이지 핵심 요약";
        elements.templatePromptInput.value = "현재 보이는 페이지의 핵심만 간결하게 요약해줘.";
        handleTemplateDraftInput();
        await saveTemplateEditor();
        const builtInCustomized = getSelectedTaskTemplate()?.customized === true;
        await deleteSelectedTemplate();
        const builtInRestoreNeedsConfirmation = state.templateDeleteConfirmationId === "summarize-page"
          && getSelectedTaskTemplate()?.customized === true;
        await deleteSelectedTemplate();
        const restoredBuiltIn = getSelectedTaskTemplate();

        state.settings.taskTemplates = Array.from({ length: MAX_TASK_TEMPLATES }, (_, index) => ({
          id: "custom-limit-" + (index + 1),
          title: "한도 검증 " + (index + 1),
          prompt: "저장 한도 검증 문구 " + (index + 1)
        }));
        renderTemplateSelect("");
        elements.templateTitleInput.value = "한도 초과 템플릿";
        elements.templatePromptInput.value = "기존 템플릿을 지우지 않고 저장을 거부해야 합니다.";
        handleTemplateDraftInput();
        await saveTemplateEditor();
        const maxLimitPreserved = getSavedTaskTemplates().length === MAX_TASK_TEMPLATES
          && getSavedTaskTemplates()[0]?.id === "custom-limit-1"
          && elements.templateStatus.textContent.includes("최대");
        state.settings.taskTemplates = [];
        renderTemplateSelect("");

        elements.chatInput.value = "현재 입력을 템플릿 편집기로 가져오기";
        startNewTemplate();
        importCurrentInputToTemplateEditor();
        const importedCurrentInput = elements.templatePromptInput.value === elements.chatInput.value
          && Boolean(elements.templateTitleInput.value);

        elements.chatInput.value = "기존에 작성하던 요청";
        elements.chatInput.setSelectionRange(elements.chatInput.value.length, elements.chatInput.value.length);
        elements.templateSelect.value = "summarize-page";
        renderTemplateEditor();
        const selectedTemplatePrompt = elements.templatePromptInput.value;
        elements.templatePopover.open = true;
        insertSelectedTemplate();
        const template = {
          createdTemplateId,
          savedCountAfterCreate,
          updatedInPlace: updatedTemplate?.id === createdTemplateId
            && updatedTemplate.title === "배포 전 점검"
            && updatedTemplate.prompt.includes("위험")
            && savedCountAfterUpdate === savedCountAfterCreate,
          deleteNeedsConfirmation,
          customDeleted,
          builtInCustomized,
          builtInRestoreNeedsConfirmation,
          builtInRestored: restoredBuiltIn?.title === "페이지 요약"
            && restoredBuiltIn?.customized === false,
          maxLimitPreserved,
          importedCurrentInput,
          preservedDraft: elements.chatInput.value.includes("기존에 작성하던 요청"),
          insertedPrompt: Boolean(selectedTemplatePrompt) && elements.chatInput.value.includes(selectedTemplatePrompt),
          popoverClosedAfterInsert: !elements.templatePopover.open
        };

        state.settings = {
          ...state.settings,
          agentMode: "approve",
          includeScreenshot: true,
          mcpEnabled: false,
          siteProfiles: {
            ...state.settings.siteProfiles,
            "https://example.test": { enabled: true, includeScreenshot: false }
          }
        };
        state.activeTab = { id: ${JSON.stringify(tabId)}, title: "Agent test dashboard", url: "https://example.test/dashboard" };
        state.lastContext = null;
        applySiteProfileForActiveTab();
        const site = {
          target: elements.siteProfileTarget.textContent,
          agentMode: state.runtimeSettings.agentMode,
          includeScreenshot: state.runtimeSettings.includeScreenshot,
          mcpEnabled: state.runtimeSettings.mcpEnabled,
          agentModeField: elements.siteInputs.agentMode.value,
          screenshotField: elements.siteInputs.includeScreenshot.value,
          mcpField: elements.siteInputs.mcpEnabled.value
        };

        const localeInputBefore = elements.chatInput.value;
        const pageTitleBefore = elements.pageTitle.textContent;
        state.settings.taskTemplates = [{
          id: "custom-language-source",
          title: "설정",
          prompt: "완료"
        }];
        renderTemplateSelect("custom-language-source");
        startRunTimeline("사용자 작업 원문");
        updateRunTimeline("observe", "active", "3번째 턴 화면 관찰 중");
        elements.inputs.uiLanguage.value = "en";
        await saveSettingsFromForm({ quiet: true });
        appendChatMessage("system", "설정이 저장되었습니다.", { record: false });
        setStatusLine("3번째 턴 · 화면 관찰 중");
        elements.contextStatus.textContent = "현재 화면을 읽는 중입니다.";
        await new Promise((resolve) => setTimeout(resolve, 20));
        const englishLocale = {
          lang: document.documentElement.lang,
          preference: state.settings.uiLanguage,
          storedPreference: (await chrome.storage.local.get("settings")).settings?.uiLanguage,
          settingsTitle: document.getElementById("settingsTitle").textContent,
          generalTab: document.getElementById("generalTab").textContent,
          composerPlaceholder: elements.chatInput.placeholder,
          builtInTemplateTitle: getTaskTemplates().find((item) => item.id === "summarize-page")?.title,
          builtInTemplatePrompt: getTaskTemplates().find((item) => item.id === "summarize-page")?.prompt,
          personalTemplateTitle: getSelectedTaskTemplate()?.title,
          personalTemplatePrompt: getSelectedTaskTemplate()?.prompt,
          personalTemplateOption: elements.templateSelect.selectedOptions[0]?.textContent,
          runtimeStatus: elements.statusLine.textContent,
          contextStatus: elements.contextStatus.textContent,
          timelineTitle: state.agentRunUi.title.textContent,
          timelinePhase: state.agentRunUi.phaseElements.observe.name.textContent,
          timelineDetail: state.agentRunUi.phaseElements.observe.detail.textContent,
          timelineTaskPreserved: state.agentRunUi.article.querySelector(".activity-summary")?.textContent === "사용자 작업 원문",
          timelineDockVisible: !elements.activityDock.hidden,
          timelineDockCardCount: elements.activityDock.querySelectorAll(".activity-card").length,
          timelineDetachedFromConversation: !elements.messageList.querySelector(".activity-card, .timeline-message"),
          timelineCollapsed: !state.agentRunUi.article.open,
          pageTitlePreserved: elements.pageTitle.textContent === pageTitleBefore,
          userMessage: elements.messageList.querySelector(".message.user .message-text")?.textContent,
          systemMessage: elements.messageList.querySelector(".message.system:last-child .message-text")?.textContent,
          composerValuePreserved: elements.chatInput.value === localeInputBefore
        };

        elements.inputs.uiLanguage.value = "ko";
        await saveSettingsFromForm({ quiet: true });
        await new Promise((resolve) => setTimeout(resolve, 20));
        const koreanLocale = {
          lang: document.documentElement.lang,
          settingsTitle: document.getElementById("settingsTitle").textContent,
          systemMessage: elements.messageList.querySelector(".message.system:last-child .message-text")?.textContent,
          builtInTemplateTitle: getTaskTemplates().find((item) => item.id === "summarize-page")?.title,
          runtimeStatus: elements.statusLine.textContent,
          contextStatus: elements.contextStatus.textContent,
          timelineTitle: state.agentRunUi.title.textContent,
          timelinePhase: state.agentRunUi.phaseElements.observe.name.textContent,
          timelineDetail: state.agentRunUi.phaseElements.observe.detail.textContent
        };
        const locale = { english: englishLocale, korean: koreanLocale };

        appendChatMessage("user", "**사용자 원문은 그대로**", { record: false });
        const plainUserMessage = elements.messageList.querySelector(".message.user:last-child .message-text");

        globalThis.__markdownExecutionProbe = false;
        appendChatMessage("assistant", [
          "# 렌더링 상태",
          "",
          "## 세부 표현",
          "",
          "**굵게**, *기울임*, ~~취소선~~, \\\\*리터럴 별표\\\\*, AT&amp;T &lt;안전한 텍스트&gt;",
          "첫 줄  ",
          "둘째 줄",
          "",
          "엔티티 HTML: &lt;img src=x onerror=globalThis.__markdownExecutionProbe=true&gt;",
          "",
          "3. 세 번째부터 시작",
          "4. 다음 항목",
          "   - 중첩 목록",
          "",
          "| 항목 | 결과 |",
          "| --- | ---: |",
          "| 표 | 완료 |",
          "",
          "- **굵은 목록**",
          "- [x] 확인 완료",
          "",
          "> 전체 테두리 인용",
          "",
          "---",
          "",
          "\`inline\`",
          "",
          "\`\`\`js",
          "const value = '<script>unsafe()</script>';",
          "\`\`\`",
          "",
          "[안전한 링크](https://example.test/docs)",
          "[상대 링크](/relative-docs)",
          "<https://example.test/auto>",
          "[참조 링크][guide]",
          "[위험한 링크](javascript:globalThis.__markdownExecutionProbe=true)",
          "![원격 이미지](https://example.test/image.png)",
          "",
          "<img src=x onerror=\\"globalThis.__markdownExecutionProbe=true\\">",
          "",
          "[guide]: https://example.test/reference"
        ].join("\\n"), { record: false });
        const markdownMessage = elements.messageList.querySelector(".message.assistant:last-child .message-text");
        const markdownTableRegion = markdownMessage.querySelector(".markdown-table-scroll");
        const markdown = {
          bodyClass: markdownMessage.classList.contains("markdown-body"),
          headings: Array.from(markdownMessage.querySelectorAll("h1, h2"), (heading) => heading.textContent),
          strongText: markdownMessage.querySelector("strong")?.textContent,
          emphasisText: markdownMessage.querySelector("em")?.textContent,
          deletedText: markdownMessage.querySelector("del")?.textContent,
          escapedAndDecodedText: markdownMessage.textContent.includes(
            "*리터럴 별표*, AT&T <안전한 텍스트>"
          ),
          entitySourceHidden: !markdownMessage.textContent.includes("&amp;"),
          escapedHtmlVisible: markdownMessage.textContent.includes(
            "<img src=x onerror=globalThis.__markdownExecutionProbe=true>"
          ),
          lineBreaks: Array.from(markdownMessage.querySelectorAll("p"))
            .find((paragraph) => (
              paragraph.textContent.includes("첫 줄")
              && paragraph.textContent.includes("둘째 줄")
            ))
            ?.querySelectorAll("br").length,
          orderedStart: markdownMessage.querySelector("ol")?.start,
          nestedListText: markdownMessage.querySelector("ol ul li")?.textContent,
          tableCount: markdownMessage.querySelectorAll("table").length,
          tableHeaders: Array.from(markdownMessage.querySelectorAll("th"), (cell) => cell.textContent),
          tableCells: Array.from(markdownMessage.querySelectorAll("td"), (cell) => cell.textContent),
          sourceDelimiterVisible: markdownMessage.textContent.includes("| --- |"),
          listStrongText: markdownMessage.querySelector("li strong")?.textContent,
          checkedTaskDisabled: Boolean(
            markdownMessage.querySelector('.markdown-task-list-item input[type="checkbox"]:checked:disabled')
          ),
          checkedTaskText: markdownMessage.querySelector(
            ".markdown-task-list-item .markdown-task-content"
          )?.textContent,
          checkedTaskLabel: markdownMessage.querySelector(
            '.markdown-task-list-item input[type="checkbox"]:checked'
          )?.getAttribute("aria-label"),
          quote: markdownMessage.querySelector("blockquote")?.textContent.trim(),
          horizontalRules: markdownMessage.querySelectorAll("hr").length,
          inlineCode: markdownMessage.querySelector(".markdown-inline-code")?.textContent,
          blockCode: markdownMessage.querySelector(".markdown-code-shell code")?.textContent,
          blockCodeFocusable: markdownMessage.querySelector(".markdown-code-shell pre")?.tabIndex === 0,
          safeLinkHref: markdownMessage.querySelector('a[href="https://example.test/docs"]')?.href,
          relativeLinkPath: Array.from(markdownMessage.querySelectorAll("a"))
            .find((anchor) => anchor.textContent === "상대 링크")?.pathname,
          automaticLinkHref: Array.from(markdownMessage.querySelectorAll("a"))
            .find((anchor) => anchor.textContent === "https://example.test/auto")?.href,
          referenceLinkHref: Array.from(markdownMessage.querySelectorAll("a"))
            .find((anchor) => anchor.textContent === "참조 링크")?.href,
          unsafeLinkAnchors: Array.from(markdownMessage.querySelectorAll("a"), (anchor) => anchor.href)
            .filter((href) => href.startsWith("javascript:")).length,
          unsafeLinkText: markdownMessage.querySelector(".markdown-unsafe-link")?.textContent,
          fetchedImages: markdownMessage.querySelectorAll("img").length,
          remoteImageLink: markdownMessage.querySelector(".markdown-image-link")?.href,
          rawHtmlVisible: markdownMessage.textContent.includes("<img src=x onerror="),
          scripts: markdownMessage.querySelectorAll("script").length,
          executionProbe: globalThis.__markdownExecutionProbe,
          tableRegionFocusable: markdownTableRegion?.tabIndex === 0,
          userSourceText: plainUserMessage?.textContent,
          userMarkdownElements: plainUserMessage?.querySelectorAll("strong, em, table, code").length
        };
        delete globalThis.__markdownExecutionProbe;

        return { template, site, locale, markdown };
    })()`);

    return { layouts, approvalModes, ...functional };
  } finally {
    try {
      if (initialized) {
        await evaluate(cdp, panelSessionId, `(async () => {
        const original = globalThis.__panelContractSnapshot;
        const storedSessions = await chrome.storage.local.get(SESSION_STORAGE_KEY);
        const sessions = { ...(storedSessions[SESSION_STORAGE_KEY] || {}) };
        for (const tabId of ${JSON.stringify(testTabIds)}) {
          delete sessions[buildSessionKey(tabId, ${JSON.stringify(testUrl)})];
        }
        await chrome.storage.local.set({ [SESSION_STORAGE_KEY]: sessions });
        state.settings = original.settings;
        state.runtimeSettings = original.runtimeSettings;
        state.activeTab = original.activeTab;
        state.lastContext = original.lastContext;
        state.conversation = original.conversation;
        state.pickedElement = original.pickedElement;
        state.undoStack = original.undoStack;
        state.evaluationLogs = original.evaluationLogs;
        state.currentPlan = original.currentPlan;
        clearRunTimeline();
        state.externalApprovals = original.externalApprovals;
        state.selectedExternalOperationId = original.selectedExternalOperationId;
        applySettingsToForm();
        applyUiLanguage();
        await persistSettings();
        clearRenderedChatMessages();
        for (const message of state.conversation) {
          appendChatMessage(message.role, message.text, { tone: message.tone || "", record: false });
        }
        elements.chatInput.value = "";
        renderTemplateSelect();
        hideApprovalPanel();
        renderExternalApprovalPanel();
        updatePickedElementBadge();
        updateAgentButtons();
        setStatusLine(original.statusText);
        elements.contextStatus.textContent = original.contextStatus;
        elements.utilityMenu.open = original.utilityMenuOpen;
        elements.templatePopover.open = original.templatePopoverOpen;
        delete globalThis.__panelContractSnapshot;
        delete globalThis.__panelContractDecision;
        delete globalThis.__panelContractExternalApprovals;
        })()`);
      }
    } finally {
      await cdp.send("Emulation.clearDeviceMetricsOverride", {}, panelSessionId).catch(() => {});
    }
  }
}

async function exerciseInternalElementDiscoveryContract({ cdp, panelSessionId, tabId, context }) {
  return evaluate(cdp, panelSessionId, `(async () => {
    const originalState = {
      runtimeSettings: state.runtimeSettings,
      activeTab: state.activeTab,
      lastContext: state.lastContext,
      agentSession: state.agentSession,
      agentRunUi: state.agentRunUi,
      currentPlan: state.currentPlan,
      conversation: state.conversation,
      evaluationLogs: state.evaluationLogs
    };
    const originalCollectDecisionObservation = collectDecisionObservation;
    const originalLoadMcpToolContext = loadMcpToolContext;
    const originalLoadMcpAssetContext = loadMcpAssetContext;
    const originalRequestAiDecision = requestAiDecision;
    try {
      state.runtimeSettings = {
        ...state.settings,
        includeScreenshot: false,
        mcpEnabled: false,
        maxNoProgressSteps: 2,
        maxActionsPerTurn: 3
      };
      state.activeTab = {
        id: ${JSON.stringify(tabId)},
        title: ${JSON.stringify(context.title)},
        url: ${JSON.stringify(context.url)}
      };
      state.conversation = [{ role: "user", text: "문제점 조회 그리드의 다음 페이지로 이동해줘" }];
      state.evaluationLogs = [];
      clearRunTimeline();
      state.currentPlan = null;
      state.agentSession = {
        runId: "element-discovery-e2e",
        targetTabId: ${JSON.stringify(tabId)},
        documentId: ${JSON.stringify(context.documentId)},
        latestUserMessage: "문제점 조회 그리드의 다음 페이지로 이동해줘",
        step: 0,
        history: [],
        evidence: [],
        currentPageEvidenceId: "",
        status: "running",
        stopRequested: false,
        pendingRequestId: "",
        noProgressCount: 0,
        lastObservationFingerprint: "",
        lastDecisionFingerprint: "",
        startedAt: new Date().toISOString()
      };

      const firstContext = {
        ...structuredClone(${JSON.stringify(context)}),
        interactiveElements: [{
          ref: "e1",
          tag: "button",
          role: "button",
          type: "button",
          label: "Grid row 1",
          selector: "#row-1",
          actionability: "interactive"
        }],
        interactiveElementStats: {
          total: 121,
          availableTotal: 121,
          included: 80,
          visited: 80,
          truncated: true
        },
        elementDiscovery: {
          scope: "current-visual-viewport",
          query: "",
          search: { query: "", roles: [], nearText: "" },
          pageSize: 80,
          returned: 80,
          total: 121,
          availableTotal: 121,
          visited: 80,
          remaining: 41,
          hasMore: true,
          nextCursor: "cursor-window-2"
        }
      };
      const secondContext = {
        ...structuredClone(firstContext),
        interactiveElements: [{
          ref: "e1",
          tag: "button",
          role: "button",
          type: "button",
          label: "Dense grid next page",
          selector: "#dense-next-page",
          actionability: "interactive",
          searchMatch: {
            score: 2040,
            matchedFields: ["label", "role", "context"],
            contextSnippet: "collection: Dense issue grid"
          }
        }],
        interactiveElementStats: {
          total: 1,
          availableTotal: 121,
          included: 1,
          visited: 1,
          truncated: false
        },
        elementDiscovery: {
          scope: "current-visual-viewport",
          query: "Dense grid next page",
          search: {
            query: "Dense grid next page",
            roles: ["button"],
            nearText: "Dense issue grid"
          },
          pageSize: 80,
          returned: 1,
          total: 1,
          availableTotal: 121,
          visited: 1,
          remaining: 0,
          hasMore: false,
          nextCursor: ""
        }
      };
      const requestedCursors = [];
      const requestedSearches = [];
      let modelCalls = 0;
      let mcpToolLoads = 0;
      let mcpAssetLoads = 0;
      let capabilityLoadsOverlappedObservation = false;
      let releaseCapabilityLoads;
      const capabilityLoadGate = new Promise((resolve) => {
        releaseCapabilityLoads = resolve;
      });
      collectDecisionObservation = async (discovery = {}) => {
        capabilityLoadsOverlappedObservation = mcpToolLoads === 1 && mcpAssetLoads === 1;
        releaseCapabilityLoads();
        requestedCursors.push(discovery.elementCursor || "");
        requestedSearches.push(discovery.elementQuery || "");
        const observed = discovery.elementQuery ? secondContext : firstContext;
        state.lastContext = observed;
        return { context: observed, screenshotDataUrl: "" };
      };
      loadMcpToolContext = async () => {
        mcpToolLoads += 1;
        await capabilityLoadGate;
        return { enabled: false, tools: [], error: "" };
      };
      loadMcpAssetContext = async () => {
        mcpAssetLoads += 1;
        await capabilityLoadGate;
        return { enabled: false, resources: [], prompts: [], error: "" };
      };
      requestAiDecision = async () => {
        modelCalls += 1;
        const payload = modelCalls === 1
          ? {
              version: "1.0",
              status: "discover",
              message: "",
              summary: "현재 화면에서 관련 페이지 이동 버튼 검색",
              progress: "첫 요소 묶음을 확인했습니다.",
              doneReason: "",
              completionEvidence: [],
              needsUserApproval: false,
              plan: ["다음 페이지 버튼 찾기"],
              elementSearch: {
                query: "Dense grid next page",
                roles: ["button"],
                nearText: "Dense issue grid",
                reason: "현재 관찰에 대상 ref가 없어 관련 컨트롤만 로컬 검색"
              },
              toolCalls: [],
              actions: [],
              verification: { required: false, expectedChange: "", successCriteria: [] }
            }
          : {
              version: "1.0",
              status: "continue",
              message: "다음 페이지 버튼을 클릭합니다.",
              summary: "다음 페이지 이동",
              progress: "추가 요소 묶음에서 대상 버튼을 찾았습니다.",
              doneReason: "",
              completionEvidence: [],
              needsUserApproval: false,
              plan: ["다음 페이지 버튼 클릭", "결과 재확인"],
              elementSearch: {
                query: "",
                roles: [],
                nearText: "",
                reason: ""
              },
              toolCalls: [],
              actions: [{
                id: "click-next-page",
                type: "click",
                ref: "e1",
                reason: "문제점 조회 그리드의 다음 페이지로 이동"
              }],
              verification: {
                required: true,
                expectedChange: "그리드가 2페이지로 변경됩니다.",
                successCriteria: ["2페이지 데이터가 보입니다."]
              }
            };
        return { text: JSON.stringify(payload) };
      };

      const decision = await requestChatDecision(state.agentSession);
      const firstScenario = {
        decisionStatus: decision.status,
        actionRef: decision.actions[0]?.ref || "",
        requestedCursors: [...requestedCursors],
        requestedSearches: [...requestedSearches],
        boundObservationSearch: {
          query: decision.observationRequest?.elementQuery || "",
          roles: decision.observationRequest?.elementRoles || [],
          nearText: decision.observationRequest?.elementNearText || ""
        },
        modelCalls,
        mcpToolLoads,
        mcpAssetLoads,
        capabilityLoadsOverlappedObservation,
        userHandoffSuppressed: !state.conversation.some(
          (message) => message.role === "assistant" && /직접|수동/.test(message.text || "")
        )
      };

      const wrongDisclosureContext = {
        ...structuredClone(firstContext),
        pageState: {
          ...(structuredClone(firstContext.pageState || {})),
          domRevision: 500
        },
        interactiveElements: [{
          ref: "request-form-options",
          scope: "main",
          tag: "button",
          role: "button",
          type: "button",
          label: "Request form options",
          selector: "#request-form-options",
          ariaHasPopup: "listbox",
          ariaExpanded: "true",
          disabled: false,
          actionability: "interactive"
        }],
        elementDiscovery: {
          scope: "current-visual-viewport",
          query: "",
          search: { query: "", roles: [], nearText: "" },
          pageSize: 80,
          returned: 1,
          total: 1,
          availableTotal: 2,
          visited: 1,
          remaining: 0,
          hasMore: false,
          nextCursor: ""
        }
      };
      const lookupContext = {
        ...structuredClone(wrongDisclosureContext),
        interactiveElements: [{
          ref: "request-type-lookup",
          scope: "main",
          tag: "button",
          role: "button",
          type: "button",
          label: "",
          selector: "#request-type-lookup",
          disabled: false,
          actionability: "interactive",
          searchMatch: {
            score: 1700,
            matchedFields: ["role", "context"],
            contextSnippet: "ancestor-2: Request type"
          }
        }],
        elementDiscovery: {
          scope: "current-visual-viewport",
          query: "",
          search: { query: "", roles: ["button"], nearText: "Request type" },
          pageSize: 80,
          returned: 1,
          total: 1,
          availableTotal: 2,
          visited: 1,
          remaining: 0,
          hasMore: false,
          nextCursor: ""
        }
      };
      state.agentSession = {
        runId: "loop-recovery-e2e",
        targetTabId: ${JSON.stringify(tabId)},
        documentId: ${JSON.stringify(context.documentId)},
        latestUserMessage: "요청 유형을 선택해줘",
        turnIntent: createFallbackTurnIntent("요청 유형을 선택해줘"),
        successfulEffects: [],
        successfulInteractions: [],
        attemptLedger: [],
        effectSequence: 0,
        effectKeySalt: "loop-recovery",
        step: 0,
        history: [],
        evidence: [],
        currentPageEvidenceId: "",
        status: "running",
        stopRequested: false,
        pendingRequestId: "",
        noProgressCount: 0,
        lastObservationFingerprint: "",
        lastDecisionFingerprint: "",
        startedAt: new Date().toISOString()
      };
      const seedDisclosureDecision = {
        step: 0,
        status: "continue",
        toolCalls: [],
        actions: [{
          id: "seed-wrong-disclosure",
          type: "click",
          ref: "request-form-options",
          reason: "잘못 선택한 요청양식 표시 컨트롤"
        }],
        verification: {
          required: true,
          expectedChange: "요청 유형 선택지가 열린다.",
          successCriteria: ["요청 유형을 선택할 수 있다."]
        }
      };
      enforceTurnEffectBoundary(
        state.agentSession,
        seedDisclosureDecision,
        wrongDisclosureContext
      );
      recordExecutionOutcomes(state.agentSession, seedDisclosureDecision, [], [{
        ok: true,
        action: seedDisclosureDecision.actions[0],
        result: { mayNavigate: false },
        verification: {
          changed: true,
          targetChanged: true,
          beforeTarget: { expanded: "false" },
          afterTarget: { expanded: "true" }
        }
      }]);

      const recoveryPurposes = [];
      const recoveryNearTexts = [];
      collectDecisionObservation = async (discovery = {}) => {
        recoveryNearTexts.push(discovery.elementNearText || "");
        const observed = discovery.elementNearText ? lookupContext : wrongDisclosureContext;
        state.lastContext = observed;
        return { context: observed, screenshotDataUrl: "" };
      };
      requestAiDecision = async (_session, request) => {
        recoveryPurposes.push(request.purpose);
        const call = recoveryPurposes.length;
        if (call === 1) {
          return {
            text: JSON.stringify({
              version: "1.0",
              status: "continue",
              message: "같은 드롭다운을 다시 확인합니다.",
              summary: "요청양식 드롭다운 재실행",
              progress: "요청 유형은 아직 선택되지 않았습니다.",
              doneReason: "",
              completionEvidence: [],
              needsUserApproval: false,
              plan: ["같은 드롭다운 다시 클릭"],
              elementSearch: { query: "", roles: [], nearText: "", reason: "" },
              toolCalls: [],
              actions: [{
                id: "repeat-wrong-disclosure",
                type: "click",
                ref: "request-form-options",
                reason: "다시 열어 확인"
              }],
              verification: {
                required: true,
                expectedChange: "요청 유형 선택지가 열린다.",
                successCriteria: ["요청 유형을 선택할 수 있다."]
              }
            })
          };
        }
        if (call === 2) {
          return {
            text: JSON.stringify({
              version: "1.0",
              status: "discover",
              message: "",
              summary: "요청 유형 필드 주변의 버튼을 다시 찾습니다.",
              progress: "같은 표시 컨트롤은 반복하지 않습니다.",
              doneReason: "",
              completionEvidence: [],
              needsUserApproval: false,
              plan: ["요청 유형 필드 주변 버튼 검색"],
              elementSearch: {
                query: "",
                roles: ["button"],
                nearText: "Request type",
                reason: "아이콘 자체 이름이 없으므로 인접 필드 라벨과 버튼 역할로 검색"
              },
              toolCalls: [],
              actions: [],
              verification: { required: false, expectedChange: "", successCriteria: [] }
            })
          };
        }
        return {
          text: JSON.stringify({
            version: "1.0",
            status: "continue",
            message: "요청 유형 필드 옆 조회 버튼을 누릅니다.",
            summary: "올바른 관계형 대상 선택",
            progress: "인접 라벨 검색으로 다른 버튼을 찾았습니다.",
            doneReason: "",
            completionEvidence: [],
            needsUserApproval: false,
            plan: ["조회 버튼 클릭", "선택지 확인"],
            elementSearch: { query: "", roles: [], nearText: "", reason: "" },
            toolCalls: [],
            actions: [{
              id: "open-request-type-lookup",
              type: "click",
              ref: "request-type-lookup",
              reason: "요청 유형 필드와 가장 가까운 버튼"
            }],
            verification: {
              required: true,
              expectedChange: "요청 유형 선택 화면이 열린다.",
              successCriteria: ["요청 유형 선택 후보가 보인다."]
            }
          })
        };
      };
      const recoveryDecision = await requestChatDecision(state.agentSession);

      state.runtimeSettings = {
        ...state.runtimeSettings,
        maxAgentSteps: 3
      };
      state.agentSession = {
        runId: "bounded-discovery-e2e",
        targetTabId: ${JSON.stringify(tabId)},
        documentId: ${JSON.stringify(context.documentId)},
        latestUserMessage: "보이지 않는 대상을 찾아줘",
        turnIntent: createFallbackTurnIntent("보이지 않는 대상을 찾아줘"),
        successfulEffects: [],
        successfulInteractions: [],
        attemptLedger: [],
        effectSequence: 0,
        effectKeySalt: "bounded-discovery",
        step: 0,
        history: [],
        evidence: [],
        currentPageEvidenceId: "",
        status: "running",
        stopRequested: false,
        pendingRequestId: "",
        noProgressCount: 0,
        lastObservationFingerprint: "",
        lastDecisionFingerprint: "",
        startedAt: new Date().toISOString()
      };
      let budgetObservationCalls = 0;
      let budgetModelCalls = 0;
      collectDecisionObservation = async (discovery = {}) => {
        budgetObservationCalls += 1;
        const observed = {
          ...structuredClone(firstContext),
          interactiveElements: [{
            ref: "e1",
            tag: "button",
            role: "button",
            type: "button",
            label: \`Unrelated window \${budgetObservationCalls}\`,
            selector: \`#unrelated-\${budgetObservationCalls}\`,
            actionability: "interactive"
          }],
          elementDiscovery: {
            scope: "current-visual-viewport",
            query: "",
            search: { query: "", roles: [], nearText: "" },
            pageSize: 1,
            returned: 1,
            total: 1000,
            availableTotal: 1000,
            visited: budgetObservationCalls,
            remaining: 1000 - budgetObservationCalls,
            hasMore: true,
            nextCursor: \`cursor-\${budgetObservationCalls + 1}\`
          }
        };
        state.lastContext = observed;
        return { context: observed, screenshotDataUrl: "" };
      };
      requestAiDecision = async () => {
        budgetModelCalls += 1;
        return {
          text: JSON.stringify({
            version: "1.0",
            status: "blocked",
            message: "현재 요소 묶음에서는 대상을 찾지 못했습니다.",
            summary: "대상 없음",
            progress: "현재 묶음 확인",
            doneReason: "대상을 찾지 못함",
            completionEvidence: [],
            needsUserApproval: false,
            plan: [],
            elementSearch: { query: "", roles: [], nearText: "", reason: "" },
            toolCalls: [],
            actions: [],
            verification: { required: false, expectedChange: "", successCriteria: [] }
          })
        };
      };
      const boundedDecision = await requestChatDecision(state.agentSession);
      return {
        ...firstScenario,
        recoveryDecisionStatus: recoveryDecision.status,
        recoveryActionRef: recoveryDecision.actions[0]?.ref || "",
        recoveryPurposes,
        recoveryNearTexts,
        repeatedDisclosureWasNotReturned:
          recoveryDecision.actions.every((action) => action.ref !== "request-form-options"),
        genericContractFailureHidden:
          !recoveryDecision.message.includes("안전한 실행 계획으로 변환"),
        boundedDiscoveryStatus: boundedDecision.status,
        boundedDiscoveryMessage: boundedDecision.message,
        boundedDiscoveryWindows: boundedDecision.discoveryBudget?.usedWindows || 0,
        boundedDiscoveryLimit: boundedDecision.discoveryBudget?.maxWindows || 0,
        boundedDiscoveryObservationCalls: budgetObservationCalls,
        boundedDiscoveryModelCalls: budgetModelCalls
      };
    } finally {
      collectDecisionObservation = originalCollectDecisionObservation;
      loadMcpToolContext = originalLoadMcpToolContext;
      loadMcpAssetContext = originalLoadMcpAssetContext;
      requestAiDecision = originalRequestAiDecision;
      state.runtimeSettings = originalState.runtimeSettings;
      state.activeTab = originalState.activeTab;
      state.lastContext = originalState.lastContext;
      state.agentSession = originalState.agentSession;
      clearRunTimeline();
      state.currentPlan = originalState.currentPlan;
      state.conversation = originalState.conversation;
      state.evaluationLogs = originalState.evaluationLogs;
    }
  })()`);
}

async function exerciseTurnBoundaryContracts({ cdp, panelSessionId, tabId, context }) {
  return evaluate(cdp, panelSessionId, `(async () => {
    const original = {
      requestAiDecision,
      settings: structuredClone(state.settings),
      runtimeSettings: structuredClone(state.runtimeSettings),
      activeTab: state.activeTab ? structuredClone(state.activeTab) : null,
      lastContext: state.lastContext ? structuredClone(state.lastContext) : null,
      agentSession: state.agentSession,
      agentRunUi: state.agentRunUi,
      currentPlan: state.currentPlan,
      conversation: structuredClone(state.conversation),
      evaluationLogs: structuredClone(state.evaluationLogs)
    };
    try {
      state.runtimeSettings = {
        ...state.settings,
        includeScreenshot: false,
        mcpEnabled: false,
        maxNoProgressSteps: 2,
        maxActionsPerTurn: 3
      };
      state.activeTab = {
        id: ${JSON.stringify(tabId)},
        title: ${JSON.stringify(context.title)},
        url: ${JSON.stringify(context.url)}
      };
      const currentContext = {
        ...structuredClone(${JSON.stringify(context)}),
        interactiveElements: [{
          ref: "e1",
          scope: "main",
          tag: "button",
          role: "button",
          type: "button",
          label: "Dense grid next page",
          selector: "#dense-next-page",
          disabled: false,
          actionability: "interactive"
        }]
      };
      state.lastContext = currentContext;
      state.conversation = [{
        role: "user",
        text: "현재 화면을 요약해줘.",
        tone: "",
        kind: "",
        taskStatus: ""
      }];
      state.evaluationLogs = [];
      clearRunTimeline();
      createAgentSession("현재 화면을 요약해줘.");
      let freshIntentModelCalls = 0;
      requestAiDecision = async () => {
        freshIntentModelCalls += 1;
        throw new Error("intent endpoint unavailable");
      };
      const freshIntent = await resolveAgentTurnIntent(state.agentSession);

      state.agentSession.status = "blocked";
      state.agentSession.turnIntent = AgentCore.normalizeTurnIntent({
        version: "1.0",
        mode: "standalone",
        objective: "요청 유형을 선택한다.",
        contextSummary: "",
        repeatPolicy: "once",
        repeatLimit: 1,
        completionCriteria: ["요청 유형이 선택되어 표시된다."],
        reason: "최초 요청"
      }, { latestUserMessage: "요청 유형을 선택한다." });
      state.agentSession.history = [{
        kind: "decision",
        step: 3,
        status: "blocked",
        message: "같은 요청양식 드롭다운을 반복해 대상을 특정하지 못했습니다.",
        summary: "잘못된 표시 컨트롤 반복",
        progress: "요청 유형은 선택되지 않았습니다.",
        elementSearch: { query: "요청 유형", roles: ["button"], nearText: "", reason: "대상 검색" },
        actions: [{ type: "click", ref: "e28", reason: "요청양식 드롭다운 열기" }]
      }];
      state.conversation = [
        {
          role: "user",
          text: "요청 유형을 선택해줘.",
          tone: "",
          kind: "",
          taskStatus: ""
        },
        {
          role: "assistant",
          text: "같은 요청양식 드롭다운을 반복해 대상을 특정하지 못했습니다.",
          tone: "error",
          kind: "agent-decision",
          taskStatus: "blocked"
        },
        {
          role: "user",
          text: "요청 유형의 돋보기 누르면 돼.",
          tone: "",
          kind: "",
          taskStatus: ""
        }
      ];
      createAgentSession("요청 유형의 돋보기 누르면 돼.");
      let correctiveIntentModelCalls = 0;
      const correctiveIntentRequests = [];
      requestAiDecision = async (_activeSession, request) => {
        correctiveIntentModelCalls += 1;
        correctiveIntentRequests.push(request);
        if (correctiveIntentModelCalls === 1) {
          return { text: '{"mode":"continue_prior"}' };
        }
        return {
          text: JSON.stringify({
            version: "1.0",
            mode: "continue_prior",
            objective: "이전의 잘못된 요청양식 드롭다운 대신 요청 유형 필드 옆 돋보기 버튼을 사용해 요청 유형을 선택한다.",
            contextSummary: "직전 실행은 요청양식 드롭다운을 반복했고, 최신 교정은 요청 유형 필드의 돋보기 버튼을 새 대상으로 지정한다.",
            repeatPolicy: "once",
            repeatLimit: 1,
            deliverable: {
              kind: "effect",
              itemDescription: "",
              targetCount: null,
              fields: [],
              includeCriteria: []
            },
            completionCriteria: ["요청 유형 필드에 선택 결과가 표시된다."],
            reason: "최신 메시지는 직전 실패의 대상을 교정하는 문맥 의존 지시다."
          })
        };
      };
      const correctiveIntent = await resolveAgentTurnIntent(state.agentSession);
      const correctiveIntentCarriedPriorRun = correctiveIntentRequests[0]?.user.includes(
        '"status": "blocked"'
      ) && correctiveIntentRequests[0]?.user.includes(
        "잘못된 표시 컨트롤 반복"
      );

      state.conversation = [
        {
          role: "user",
          text: "다음 페이지로 넘겨서 내용을 확인해줘.",
          tone: "",
          kind: "",
          taskStatus: ""
        },
        {
          role: "assistant",
          text: "이전 작업 중 오류가 발생했습니다.",
          tone: "error",
          kind: "run-error",
          taskStatus: "failed"
        },
        {
          role: "user",
          text: "현재 페이지에서 다음 페이지로 한 번 이동해줘.",
          tone: "",
          kind: "",
          taskStatus: ""
        }
      ];
      state.evaluationLogs = [];
      clearRunTimeline();
      createAgentSession("현재 페이지에서 다음 페이지로 한 번 이동해줘.");
      const session = state.agentSession;
      let intentRequest = null;
      requestAiDecision = async (_activeSession, request) => {
        intentRequest = request;
        return {
          text: JSON.stringify({
            version: "1.0",
            mode: "standalone",
            objective: "이전 요청까지 합쳐 다음 페이지 이동을 계속 반복한다.",
            contextSummary: "",
            repeatPolicy: "once",
            repeatLimit: 1,
            deliverable: {
              kind: "effect",
              itemDescription: "",
              targetCount: null,
              fields: [],
              includeCriteria: []
            },
            completionCriteria: ["요청 시작 시점보다 한 페이지 앞으로 이동한 현재 화면이 관찰된다."],
            reason: "최신 메시지는 자체로 완결된 새 명령이며 한 번이라는 범위를 명시한다."
          })
        };
      };
      const intent = await resolveAgentTurnIntent(session);
      const plannerPrompt = buildChatAgentPrompt(
        session,
        currentContext,
        { enabled: false, tools: [], error: "" },
        1
      );

      const malformed = normalizeAiDecisionResponse('{"status": "continue"', 1);
      const malformedValidation = validateChatDecision(
        malformed,
        currentContext,
        { enabled: false, tools: [] }
      );
      const malformedText = buildDecisionText(malformed);

      const internalJsonDecision = normalizeAiDecisionResponse(JSON.stringify({
        version: "1.0",
        status: "answer",
        message: "Internal response follows:\\n" + JSON.stringify({
          status: "continue",
          actions: [{ type: "click", ref: "e1" }],
          elementSearch: { query: "next", roles: ["button"], nearText: "", reason: "find" }
        }),
        summary: "internal payload",
        progress: "",
        doneReason: "",
        completionEvidence: [],
        needsUserApproval: false,
        plan: [],
        elementSearch: { query: "", roles: [], nearText: "", reason: "" },
        toolCalls: [],
        actions: [],
        verification: { required: false, expectedChange: "", successCriteria: [] }
      }), 1);
      const internalJsonValidation = validateChatDecision(
        internalJsonDecision,
        currentContext,
        { enabled: false, tools: [] }
      );

      const firstAction = normalizeAiDecisionResponse(JSON.stringify({
        version: "1.0",
        status: "continue",
        message: "다음 페이지로 이동합니다.",
        summary: "다음 페이지 이동",
        progress: "",
        doneReason: "",
        completionEvidence: [],
        needsUserApproval: false,
        plan: ["한 번 이동", "결과 확인"],
        elementSearch: {
          query: "next page",
          roles: ["button"],
          nearText: "issue grid",
          reason: "이전 검색 메타데이터가 액션 응답에 남음"
        },
        toolCalls: [],
        actions: [{
          id: "next-once",
          type: "click",
          ref: "e1",
          reason: "한 페이지 이동"
        }],
        verification: {
          required: true,
          expectedChange: "페이지 인덱스가 한 번 증가",
          successCriteria: ["한 페이지 앞으로 이동"]
        }
      }), 1);
      const firstValidation = validateChatDecision(
        firstAction,
        currentContext,
        { enabled: false, tools: [] }
      );
      enforceTurnEffectBoundary(session, firstAction, currentContext);
      recordExecutionOutcomes(session, firstAction, [], [{
        ok: true,
        action: firstAction.actions[0],
        result: { changed: true }
      }]);

      const repeatedAction = normalizeAiDecisionResponse(JSON.stringify({
        version: "1.0",
        status: "continue",
        message: "다음 페이지로 다시 이동합니다.",
        summary: "다음 페이지 재이동",
        progress: "한 페이지 이동 완료",
        doneReason: "",
        completionEvidence: [],
        needsUserApproval: false,
        plan: ["같은 버튼 다시 클릭"],
        elementSearch: { query: "", roles: [], nearText: "", reason: "" },
        toolCalls: [],
        actions: [{
          id: "next-again",
          type: "click",
          ref: "e1",
          reason: "다음 페이지가 계속 보임"
        }],
        verification: {
          required: true,
          expectedChange: "페이지가 다시 변경",
          successCriteria: ["다음 페이지 표시"]
        }
      }), 2);
      enforceTurnEffectBoundary(session, repeatedAction, currentContext);

      const disclosureContext = {
        ...structuredClone(currentContext),
        interactiveElements: [{
          ref: "disclosure-e1",
          scope: "main",
          tag: "button",
          role: "button",
          type: "button",
          label: "Request form options",
          selector: "#request-form-options",
          ariaHasPopup: "listbox",
          ariaExpanded: "false",
          disabled: false,
          actionability: "interactive"
        }]
      };
      const disclosureSession = {
        ...session,
        turnIntent: createFallbackTurnIntent("요청 유형을 한 번 선택해줘."),
        successfulEffects: [],
        successfulInteractions: [],
        attemptLedger: [],
        effectSequence: 0,
        effectKeySalt: "disclosure-loop"
      };
      const disclosureDecision = {
        step: 1,
        status: "continue",
        toolCalls: [],
        actions: [{
          id: "open-wrong-dropdown",
          type: "click",
          ref: "disclosure-e1",
          reason: "옵션을 확인"
        }],
        verification: {
          required: true,
          expectedChange: "올바른 요청 유형 선택지가 열린다.",
          successCriteria: ["요청 유형 선택지가 보인다."]
        }
      };
      enforceTurnEffectBoundary(disclosureSession, disclosureDecision, disclosureContext);
      recordExecutionOutcomes(disclosureSession, disclosureDecision, [], [{
        ok: true,
        action: disclosureDecision.actions[0],
        result: { mayNavigate: false },
        verification: {
          changed: true,
          targetChanged: true,
          beforeTarget: { expanded: "false" },
          afterTarget: { expanded: "true" }
        }
      }]);
      const repeatedDisclosureDecision = structuredClone(disclosureDecision);
      repeatedDisclosureDecision.step = 2;
      enforceTurnEffectBoundary(disclosureSession, repeatedDisclosureDecision, {
        ...structuredClone(disclosureContext),
        interactiveElements: [{
          ...structuredClone(disclosureContext.interactiveElements[0]),
          ariaExpanded: "true"
        }]
      });

      const unchangedSession = {
        ...session,
        turnIntent: createFallbackTurnIntent("현재 대상에서 한 번 실행해줘."),
        successfulEffects: [],
        successfulInteractions: [],
        attemptLedger: [],
        effectSequence: 0,
        effectKeySalt: "unchanged-loop"
      };
      const unchangedDecision = normalizeAiDecisionResponse(JSON.stringify({
        version: "1.0",
        status: "continue",
        message: "대상을 실행합니다.",
        summary: "대상 실행",
        progress: "",
        doneReason: "",
        completionEvidence: [],
        needsUserApproval: false,
        plan: ["대상 실행", "변화 확인"],
        elementSearch: { query: "", roles: [], nearText: "", reason: "" },
        toolCalls: [],
        actions: [{
          id: "unchanged-attempt",
          type: "click",
          ref: "e1",
          reason: "현재 대상 실행"
        }],
        verification: {
          required: true,
          expectedChange: "현재 화면이 변경된다.",
          successCriteria: ["관찰 가능한 변화가 생긴다."]
        }
      }), 1);
      enforceTurnEffectBoundary(unchangedSession, unchangedDecision, currentContext);
      recordExecutionOutcomes(unchangedSession, unchangedDecision, [], [{
        ok: true,
        action: unchangedDecision.actions[0],
        result: { mayNavigate: false },
        verification: {
          changed: false,
          reason: "no observable page state change",
          targetChanged: false
        }
      }]);
      const repeatedUnchangedDecision = normalizeAiDecisionResponse(JSON.stringify({
        ...unchangedDecision,
        step: 2,
        message: "같은 대상을 다시 실행합니다.",
        actions: [{
          id: "unchanged-attempt-again",
          type: "click",
          ref: "e1",
          reason: "변화가 없어서 같은 대상 재시도"
        }]
      }), 2);
      enforceTurnEffectBoundary(unchangedSession, repeatedUnchangedDecision, currentContext);

      const indeterminateSession = {
        ...unchangedSession,
        successfulEffects: [],
        successfulInteractions: [],
        attemptLedger: [],
        effectSequence: 0,
        effectKeySalt: "indeterminate-loop"
      };
      const indeterminateDecision = normalizeAiDecisionResponse(JSON.stringify({
        ...unchangedDecision,
        step: 1,
        actions: [{
          id: "indeterminate-attempt",
          type: "click",
          ref: "e1",
          reason: "ambient-only change attempt"
        }]
      }), 1);
      enforceTurnEffectBoundary(indeterminateSession, indeterminateDecision, currentContext);
      recordExecutionOutcomes(indeterminateSession, indeterminateDecision, [], [{
        ok: true,
        action: indeterminateDecision.actions[0],
        result: { mayNavigate: false },
        verification: {
          changed: false,
          materialChanged: false,
          ambientChanged: true,
          indeterminate: true,
          reason: "only ambient page revisions changed"
        }
      }]);
      const repeatedIndeterminateDecision = normalizeAiDecisionResponse(JSON.stringify({
        ...indeterminateDecision,
        step: 2,
        actions: [{
          id: "indeterminate-attempt-again",
          type: "click",
          ref: "e1",
          reason: "same target after ambient-only churn"
        }]
      }), 2);
      enforceTurnEffectBoundary(
        indeterminateSession,
        repeatedIndeterminateDecision,
        currentContext
      );

      const writeToolContext = {
        tools: [{
          name: "fixture.update",
          kind: "tool",
          sourceName: "update",
          annotations: { readOnlyHint: false }
        }]
      };
      const writeToolDecision = {
        status: "continue",
        toolCalls: [{
          toolName: "fixture.update",
          arguments: { record: "visible-row", value: "updated" }
        }],
        actions: [],
        mcpContext: writeToolContext
      };
      enforceTurnEffectBoundary(session, writeToolDecision, currentContext);
      recordExecutionOutcomes(session, writeToolDecision, [{ ok: true }], []);
      const repeatedWriteToolDecision = structuredClone(writeToolDecision);
      enforceTurnEffectBoundary(session, repeatedWriteToolDecision, currentContext);

      const readToolContext = {
        tools: [{
          name: "fixture.read",
          kind: "tool",
          sourceName: "read",
          annotations: { readOnlyHint: true }
        }]
      };
      const readToolDecision = {
        status: "continue",
        toolCalls: [{
          toolName: "fixture.read",
          arguments: { record: "visible-row" }
        }],
        actions: [],
        mcpContext: readToolContext
      };
      enforceTurnEffectBoundary(session, readToolDecision, currentContext);
      recordExecutionOutcomes(session, readToolDecision, [{ ok: true }], []);
      const repeatedReadToolDecision = structuredClone(readToolDecision);
      enforceTurnEffectBoundary(session, repeatedReadToolDecision, currentContext);

      await runBusy(async () => {
        throw new Error(JSON.stringify({
          error: { message: "Provider request failed without exposing its JSON envelope." }
        }));
      });
      const lastConversation = state.conversation.at(-1);
      const completionEvidenceDiagnostic = getUserFacingErrorMessage(
        new Error("completed 판단에는 런타임이 발급한 completionEvidence ID가 필요합니다.")
      );
      const elementSearchDiagnostic = getUserFacingErrorMessage(
        new Error("elementSearch는 discover 판단에서만 사용할 수 있습니다.")
      );
      const providerStatusError = getUserFacingErrorMessage(
        new Error("Invalid status 401 from provider.")
      );

      return {
        freshIntentModelCalls,
        freshIntentMode: freshIntent.mode,
        correctiveIntentMode: correctiveIntent.mode,
        correctiveIntentModelCalls,
        correctiveIntentCarriedPriorRun,
        correctiveIntentReplacedFailedTarget:
          correctiveIntent.objective.includes("돋보기 버튼")
          && !correctiveIntent.objective.includes("요청양식 드롭다운을 반복"),
        intentMode: intent.mode,
        intentRepeatPolicy: intent.repeatPolicy,
        standaloneObjectiveStayedExact: intent.objective
          === "현재 페이지에서 다음 페이지로 한 번 이동해줘.",
        resolverSawFailedPriorRun: intentRequest?.system.includes("earlier error")
          && intentRequest?.user.includes('"taskStatus": "failed"'),
        plannerExcludedRawConversation: plannerPrompt.includes("Resolved turn intent JSON")
          && !plannerPrompt.includes("다음 페이지로 넘겨서 내용을 확인해줘."),
        plannerContextCompacted: plannerPrompt.includes("Current page context JSON")
          && !plannerPrompt.includes('"documentTextExcerpt"')
          && !plannerPrompt.includes('"collectionDiagnostics"')
          && !plannerPrompt.includes('"payload":')
          && !plannerPrompt.includes('"binding":')
          && !plannerPrompt.includes('"stateBinding":'),
        rawPageContextChars: JSON.stringify(currentContext).length,
        formattedPageContextChars: JSON.stringify(formatPageContextForPrompt(currentContext)).length,
        malformedRawHidden: !malformedText.includes('{"status"')
          && malformedValidation.valid === false,
        internalJsonRejected: internalJsonValidation.valid === false,
        staleElementSearchCleared: firstValidation.valid === true
          && firstAction.elementSearch.query === "",
        repeatBlockedAfterOneSuccess: repeatedAction.status === "blocked"
          && repeatedAction.actions.length === 0,
        disclosureRepeatBlockedWithoutMaterialProgress:
          repeatedDisclosureDecision.status === "blocked"
          && repeatedDisclosureDecision.actions.length === 0
          && disclosureSession.successfulInteractions.length === 1,
        unchangedAttemptNotCountedAsSuccess:
          unchangedSession.attemptLedger[0]?.outcome === "unchanged"
          && unchangedSession.successfulEffects.length === 0,
        unchangedAttemptRepeatBlocked:
          repeatedUnchangedDecision.status === "blocked"
          && repeatedUnchangedDecision.actions.length === 0,
        indeterminateAttemptNotCountedAsSuccess:
          indeterminateSession.attemptLedger[0]?.outcome === "indeterminate"
          && indeterminateSession.successfulEffects.length === 0,
        indeterminateAttemptRepeatBlocked:
          repeatedIndeterminateDecision.status === "blocked"
          && repeatedIndeterminateDecision.actions.length === 0,
        stateChangingToolRepeatBlocked: repeatedWriteToolDecision.status === "blocked"
          && repeatedWriteToolDecision.toolCalls.length === 0,
        readOnlyToolRepeatAllowed: repeatedReadToolDecision.status === "continue"
          && repeatedReadToolDecision.toolCalls.length === 1,
        runtimeErrorStoppedSession: session.status === "failed" && session.stopRequested === true,
        runtimeErrorJsonHidden: lastConversation?.kind === "run-error"
          && !lastConversation.text.includes("{")
          && lastConversation.text.includes("Provider request failed"),
        completionEvidenceDiagnosticHidden: !completionEvidenceDiagnostic.includes("completionEvidence")
          && completionEvidenceDiagnostic.includes("안전한 실행 계획"),
        elementSearchDiagnosticHidden: !elementSearchDiagnostic.includes("elementSearch")
          && elementSearchDiagnostic.includes("안전한 실행 계획"),
        providerStatusErrorPreserved: providerStatusError === "Invalid status 401 from provider."
      };
    } finally {
      requestAiDecision = original.requestAiDecision;
      state.settings = original.settings;
      state.runtimeSettings = original.runtimeSettings;
      state.activeTab = original.activeTab;
      state.lastContext = original.lastContext;
      state.agentSession = original.agentSession;
      clearRunTimeline();
      state.currentPlan = original.currentPlan;
      state.conversation = original.conversation;
      state.evaluationLogs = original.evaluationLogs;
      elements.messageList.replaceChildren();
      for (const message of state.conversation) {
        appendChatMessage(message.role, message.text, {
          tone: message.tone || "",
          record: false
        });
      }
      updateAgentButtons();
    }
  })()`);
}

async function exerciseCollectionLedgerContracts({ cdp, panelSessionId, tabId, context }) {
  return evaluate(cdp, panelSessionId, `(() => {
    const original = {
      activeTab: state.activeTab ? structuredClone(state.activeTab) : null,
      lastContext: state.lastContext ? structuredClone(state.lastContext) : null,
      agentSession: state.agentSession,
      agentRunUi: state.agentRunUi,
      datasets: structuredClone(state.datasets),
      evaluationLogs: structuredClone(state.evaluationLogs)
    };
    const makeRows = (start) => Array.from({ length: 20 }, (_, index) => ({
      key: String(start + index),
      title: "Board title " + (start + index),
      url: "https://example.test/post/" + (start + index),
      context: "Record " + (start + index),
      provenance: { source: "fixture" }
    }));
    const makeBatch = (page, start, digest = "slice-" + page) => ({
      collectionId: "free-board-titles",
      collectionName: "Free board titles",
      targetCount: 40,
      records: makeRows(start),
      pageIdentity: {
        url: "https://example.test/board?page=" + page,
        documentId: "document-" + page,
        domRevision: page,
        sourceSliceDigest: digest
      },
      scope: "rendered-document",
      provenance: { source: "bound-exemplar" }
    });
    const makeExtractDecision = (step) => ({
      step,
      status: "continue",
      toolCalls: [],
      actions: [{
        id: "extract-page-" + step,
        type: "extract",
        ref: "record-title",
        collectionId: "free-board-titles",
        collectionName: "Free board titles",
        targetCount: 40,
        reason: "collect one rendered result page"
      }],
      verification: {
        required: true,
        expectedChange: "collection ledger grows",
        successCriteria: ["unique rows are added"]
      }
    });
    const makeSession = () => {
      createAgentSession("자유게시판 일반 글 제목 40개를 알려줘.");
      state.agentSession.turnIntent = AgentCore.normalizeTurnIntent({
        version: "1.0",
        mode: "standalone",
        objective: "Collect exactly 40 normal free-board post titles.",
        contextSummary: "",
        repeatPolicy: "once",
        repeatLimit: 1,
        deliverable: {
          kind: "collection",
          itemDescription: "normal free-board post",
          targetCount: 40,
          fields: ["title"],
          includeCriteria: ["Exclude pinned notices."]
        },
        completionCriteria: ["Exactly 40 unique titles are returned."],
        reason: "The number is output cardinality."
      });
      return state.agentSession;
    };
    try {
      state.activeTab = {
        id: ${JSON.stringify(tabId)},
        title: ${JSON.stringify(context.title)},
        url: "https://example.test/board?page=1"
      };
      state.lastContext = {
        ...structuredClone(${JSON.stringify(context)}),
        url: "https://example.test/board?page=1",
        interactiveElements: [{
          ref: "next-page",
          tag: "button",
          role: "button",
          type: "button",
          label: "Next page",
          selector: "#next-page",
          disabled: false,
          actionability: "interactive"
        }]
      };
      state.evaluationLogs = [];
      clearRunTimeline();

      const session = makeSession();
      const pageOneDecision = makeExtractDecision(1);
      const pageOneResult = {
        ok: true,
        action: pageOneDecision.actions[0],
        result: { collection: makeBatch(1, 1) },
        verification: { changed: false, materialChanged: false, domChanged: false }
      };
      ingestStructuredCollectionResults(session, pageOneDecision, [pageOneResult]);
      recordExecutionOutcomes(session, pageOneDecision, [], [pageOneResult]);
      const firstPageCollected = session.datasets[0]?.rows.length === 20
        && session.datasets[0]?.status === "collecting"
        && session.collectionAwaitingExtraction === false;
      const requestedColumnsOnly = session.datasets[0]?.columnsExplicit === true
        && session.datasets[0]?.columns.length === 1
        && session.datasets[0]?.columns[0]?.key === "title";

      const multipleTraversalDecision = {
        step: 2,
        status: "continue",
        toolCalls: [],
        actions: [
          { id: "skip-page-2", type: "click", ref: "next-page", reason: "advance" },
          { id: "skip-page-3", type: "click", ref: "next-page", reason: "advance again" }
        ]
      };
      const multipleTraversalBlocked = validateCollectionBoundary(
        session,
        multipleTraversalDecision,
        state.lastContext
      ).valid === false;

      const paginationDecision = {
        step: 2,
        status: "continue",
        toolCalls: [],
        actions: [{ id: "page-2", type: "click", ref: "next-page", reason: "advance once" }],
        verification: {
          required: true,
          expectedChange: "result page changes",
          successCriteria: ["new rows appear"]
        }
      };
      enforceTurnEffectBoundary(session, paginationDecision, state.lastContext);
      recordExecutionOutcomes(session, paginationDecision, [], [{
        ok: true,
        action: paginationDecision.actions[0],
        result: { mayNavigate: false },
        verification: {
          changed: true,
          materialChanged: true,
          domChanged: true,
          urlChanged: false,
          targetChanged: false
        }
      }]);
      const spaPaginationIsTransport = session.collectionAwaitingExtraction === true
        && session.attemptLedger.at(-1)?.outcome === "transport"
        && session.successfulEffects.length === 0;
      const intermediatePageCannotBeSkipped = validateCollectionBoundary(
        session,
        paginationDecision,
        state.lastContext
      ).valid === false;

      const disclosureSession = structuredClone(session);
      disclosureSession.collectionAwaitingExtraction = false;
      disclosureSession.attemptLedger = [];
      disclosureSession.successfulEffects = [];
      disclosureSession.successfulInteractions = [];
      const disclosureContext = {
        ...structuredClone(state.lastContext),
        interactiveElements: [{
          ref: "page-menu",
          tag: "button",
          role: "button",
          type: "button",
          label: "Page menu",
          selector: "#page-menu",
          ariaHasPopup: "menu",
          ariaExpanded: "false",
          disabled: false,
          actionability: "interactive"
        }]
      };
      const disclosureDecision = {
        step: 2,
        status: "continue",
        toolCalls: [],
        actions: [{ id: "open-page-menu", type: "click", ref: "page-menu", reason: "show choices" }],
        verification: { required: true, expectedChange: "menu opens", successCriteria: ["choices show"] }
      };
      enforceTurnEffectBoundary(disclosureSession, disclosureDecision, disclosureContext);
      recordExecutionOutcomes(disclosureSession, disclosureDecision, [], [{
        ok: true,
        action: disclosureDecision.actions[0],
        result: { mayNavigate: false },
        verification: {
          changed: true,
          materialChanged: true,
          domChanged: true,
          targetChanged: true,
          beforeTarget: { expanded: "false" },
          afterTarget: { expanded: "true" }
        }
      }]);
      const disclosureDoesNotRequestExtraction =
        disclosureSession.collectionAwaitingExtraction === false;

      const plainScrollSession = structuredClone(disclosureSession);
      plainScrollSession.attemptLedger = [];
      const scrollDecision = {
        step: 2,
        status: "continue",
        toolCalls: [],
        actions: [{ id: "scroll-results", type: "scroll", direction: "down", reason: "reveal more" }],
        verification: { required: true, expectedChange: "scroll", successCriteria: ["viewport moves"] }
      };
      recordExecutionOutcomes(plainScrollSession, scrollDecision, [], [{
        ok: true,
        action: scrollDecision.actions[0],
        result: { mayNavigate: false },
        verification: { changed: true, materialChanged: true, domChanged: false, urlChanged: false }
      }]);
      const plainScrollDoesNotRequestExtraction =
        plainScrollSession.collectionAwaitingExtraction === false;

      const virtualScrollSession = structuredClone(disclosureSession);
      virtualScrollSession.attemptLedger = [];
      recordExecutionOutcomes(virtualScrollSession, scrollDecision, [], [{
        ok: true,
        action: scrollDecision.actions[0],
        result: { mayNavigate: false },
        verification: { changed: true, materialChanged: true, domChanged: true, urlChanged: false }
      }]);
      const virtualScrollRequestsExtraction =
        virtualScrollSession.collectionAwaitingExtraction === true
        && virtualScrollSession.attemptLedger.at(-1)?.outcome === "transport";

      const pageTwoDecision = makeExtractDecision(3);
      const pageTwoResult = {
        ok: true,
        action: pageTwoDecision.actions[0],
        result: { collection: makeBatch(2, 21) },
        verification: { changed: false, materialChanged: false, domChanged: false }
      };
      const secondExtractAllowed = validateCollectionBoundary(
        session,
        pageTwoDecision,
        state.lastContext
      ).valid;
      ingestStructuredCollectionResults(session, pageTwoDecision, [pageTwoResult]);
      recordExecutionOutcomes(session, pageTwoDecision, [], [pageTwoResult]);
      const secondPageReachedExactTarget = secondExtractAllowed
        && session.datasets[0]?.rows.length === 40
        && session.datasets[0]?.status === "reached"
        && session.collectionAwaitingExtraction === false;
      const thirdPageBlocked = validateCollectionBoundary(
        session,
        paginationDecision,
        state.lastContext
      ).valid === false;
      const terminalAnswerAllowed = validateCollectionBoundary(
        session,
        { step: 4, status: "answer", toolCalls: [], actions: [] },
        state.lastContext
      ).valid === true;

      const repeatedSession = makeSession();
      const repeatedFirst = {
        ok: true,
        action: pageOneDecision.actions[0],
        result: { collection: makeBatch(1, 1) },
        verification: {}
      };
      ingestStructuredCollectionResults(repeatedSession, pageOneDecision, [repeatedFirst]);
      repeatedSession.collectionAwaitingExtraction = true;
      const repeatedAgain = {
        ok: true,
        action: pageTwoDecision.actions[0],
        result: { collection: makeBatch(1, 1) },
        verification: {}
      };
      ingestStructuredCollectionResults(repeatedSession, pageTwoDecision, [repeatedAgain]);
      const repeatedPageStalled = repeatedSession.datasets[0]?.status === "stalled"
        && repeatedSession.datasets[0]?.stallReason === "repeated-page"
        && validateCollectionBoundary(
          repeatedSession,
          paginationDecision,
          state.lastContext
        ).valid === false;

      const zeroNewSession = makeSession();
      const zeroFirst = {
        ok: true,
        action: pageOneDecision.actions[0],
        result: { collection: makeBatch(1, 1) },
        verification: {}
      };
      ingestStructuredCollectionResults(zeroNewSession, pageOneDecision, [zeroFirst]);
      zeroNewSession.collectionAwaitingExtraction = true;
      const zeroAgain = {
        ok: true,
        action: pageTwoDecision.actions[0],
        result: { collection: makeBatch(2, 1, "different-slice") },
        verification: {}
      };
      ingestStructuredCollectionResults(zeroNewSession, pageTwoDecision, [zeroAgain]);
      const zeroNewPageStalled = zeroNewSession.datasets[0]?.status === "stalled"
        && zeroNewSession.datasets[0]?.stallReason === "zero-new-records"
        && validateCollectionBoundary(
          zeroNewSession,
          paginationDecision,
          state.lastContext
        ).valid === false;

      return {
        firstPageCollected,
        requestedColumnsOnly,
        multipleTraversalBlocked,
        spaPaginationIsTransport,
        intermediatePageCannotBeSkipped,
        disclosureDoesNotRequestExtraction,
        plainScrollDoesNotRequestExtraction,
        virtualScrollRequestsExtraction,
        secondPageReachedExactTarget,
        thirdPageBlocked,
        terminalAnswerAllowed,
        repeatedPageStalled,
        zeroNewPageStalled
      };
    } finally {
      state.activeTab = original.activeTab;
      state.lastContext = original.lastContext;
      state.agentSession = original.agentSession;
      state.datasets = original.datasets;
      state.evaluationLogs = original.evaluationLogs;
      clearRunTimeline();
      state.agentRunUi = original.agentRunUi;
      updateAgentButtons();
    }
  })()`);
}

async function exerciseWorkflowSetContracts({ cdp, panelSessionId, tabId }) {
  return evaluate(cdp, panelSessionId, `(async () => {
    const original = {
      executeAgentInstruction,
      refreshActiveTabSummary,
      activeTab: state.activeTab ? structuredClone(state.activeTab) : null,
      lastContext: state.lastContext ? structuredClone(state.lastContext) : null,
      agentSession: state.agentSession,
      workflowRun: state.workflowRun,
      workflowSets: structuredClone(state.workflowSets),
      runRecords: structuredClone(state.runRecords),
      conversation: structuredClone(state.conversation),
      busy: state.busy
    };
    const makeStep = (id, failurePolicy = "stop") => ({
      id,
      goalTemplate: "Read the current page title.",
      completionCriteria: ["The current title is returned."],
      outputContract: null,
      assertions: [{
        type: "status",
        operator: "in",
        expected: ["answer", "completed"]
      }],
      failurePolicy
    });
    try {
      state.busy = false;
      state.activeTab = {
        id: ${JSON.stringify(tabId)},
        title: "Workflow fixture",
        url: "https://example.test/start"
      };
      state.lastContext = {
        title: "Workflow fixture",
        url: "https://example.test/start"
      };
      refreshActiveTabSummary = async () => state.activeTab;

      const parametersResolved = renderWorkflowStepInstruction(
        { goalTemplate: "Collect {{ limit }} titles." },
        [{ name: "limit", required: true, defaultValue: 40 }]
      ) === "Collect 40 titles.";
      const portableContract = buildPortableOutputContract({
        kind: "collection",
        itemDescription: "board post",
        targetCount: 40,
        fields: ["title"],
        includeCriteria: ["Exclude notices."]
      });
      const outputContractPreserved = portableContract.kind === "collection"
        && portableContract.itemDescription === "board post"
        && portableContract.targetCount === 40
        && portableContract.fields[0]?.name === "title"
        && portableContract.includeCriteria[0] === "Exclude notices.";
      const mismatchedIntentRejected = validateWorkflowStepIntent({
        valid: true,
        errors: [],
        intent: AgentCore.normalizeTurnIntent({
          version: "1.0",
          mode: "standalone",
          objective: "Collect records.",
          contextSummary: "",
          repeatPolicy: "once",
          repeatLimit: 1,
          deliverable: {
            kind: "effect",
            itemDescription: "",
            targetCount: null,
            fields: [],
            includeCriteria: []
          },
          completionCriteria: ["The task completes."],
          reason: "fixture"
        })
      }, { outputContract: portableContract }).valid === false;

      let sequentialCalls = 0;
      state.runRecords = [];
      state.workflowRun = {
        setId: "sequential",
        name: "Sequential fixture",
        kind: "test",
        siteScope: { origin: "https://example.test", enforcement: "same-origin" },
        parameters: [],
        steps: [makeStep("one", "continue"), makeStep("two", "continue")],
        index: 0,
        currentRunId: "",
        handledRunIds: [],
        results: [],
        status: "running",
        startedAt: new Date().toISOString()
      };
      executeAgentInstruction = async () => {
        sequentialCalls += 1;
        const runId = "workflow-run-" + sequentialCalls;
        state.agentSession = {
          runId,
          status: "completed",
          stopRequested: true,
          datasets: [],
          activeCollectionId: ""
        };
        state.workflowRun.currentRunId = runId;
        state.runRecords.push({ runId, result: "done" });
      };
      await runNextWorkflowStep();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const sequentialStepsCompleted = sequentialCalls === 2
        && state.workflowRun.status === "completed"
        && state.workflowRun.results.length === 2
        && state.workflowRun.results.every((result) => result.passed);

      state.agentSession = null;
      state.workflowRun = {
        setId: "pre-session-error",
        name: "Pre-session failure",
        kind: "test",
        siteScope: { origin: "https://example.test", enforcement: "same-origin" },
        parameters: [],
        steps: [makeStep("fails-before-session", "continue")],
        index: 0,
        currentRunId: "",
        handledRunIds: [],
        results: [],
        status: "running",
        startedAt: new Date().toISOString()
      };
      executeAgentInstruction = async () => {
        throw new Error("settings unavailable before session");
      };
      await runNextWorkflowStep();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const preSessionFailureTerminated = state.workflowRun.status === "failed"
        && state.workflowRun.results.length === 1
        && /settings unavailable/.test(state.workflowRun.results[0].message);

      let originDriftExecutions = 0;
      state.agentSession = null;
      state.activeTab.url = "https://outside.test/landing";
      state.workflowRun = {
        setId: "origin-drift",
        name: "Origin drift",
        kind: "automation",
        siteScope: { origin: "https://example.test", enforcement: "same-origin" },
        parameters: [],
        steps: [makeStep("must-not-run")],
        index: 0,
        currentRunId: "",
        handledRunIds: [],
        results: [],
        status: "running",
        startedAt: new Date().toISOString()
      };
      executeAgentInstruction = async () => {
        originDriftExecutions += 1;
      };
      await runNextWorkflowStep();
      const originDriftBlocked = originDriftExecutions === 0
        && state.workflowRun.status === "failed"
        && /허용 출처/.test(state.workflowRun.results[0]?.message || "");

      state.activeTab.url = "https://example.test/start";
      const stoppedRun = {
        setId: "busy-stop",
        name: "Busy stop",
        kind: "test",
        siteScope: { origin: "https://example.test", enforcement: "same-origin" },
        parameters: [],
        steps: [makeStep("stopped", "continue"), makeStep("later", "continue")],
        index: 0,
        currentRunId: "busy-stop-run",
        handledRunIds: [],
        results: [],
        status: "running",
        startedAt: new Date().toISOString()
      };
      state.workflowRun = stoppedRun;
      state.agentSession = {
        runId: "busy-stop-run",
        status: "running",
        stopRequested: false,
        archivedAt: new Date().toISOString(),
        datasets: [],
        activeCollectionId: ""
      };
      state.busy = true;
      stopAgent();
      const skippedWhileBusy = stoppedRun.index === 0
        && stoppedRun.handledRunIds.length === 0;
      state.busy = false;
      handleWorkflowStepCompletion();
      const busyStopDeferred = skippedWhileBusy
        && stoppedRun.index === 1
        && stoppedRun.handledRunIds.includes("busy-stop-run");
      stoppedRun.status = "failed";

      return {
        parametersResolved,
        outputContractPreserved,
        mismatchedIntentRejected,
        sequentialStepsCompleted,
        preSessionFailureTerminated,
        originDriftBlocked,
        busyStopDeferred
      };
    } finally {
      executeAgentInstruction = original.executeAgentInstruction;
      refreshActiveTabSummary = original.refreshActiveTabSummary;
      state.activeTab = original.activeTab;
      state.lastContext = original.lastContext;
      state.agentSession = original.agentSession;
      state.workflowRun = original.workflowRun;
      state.workflowSets = original.workflowSets;
      state.runRecords = original.runRecords;
      state.conversation = original.conversation;
      state.busy = original.busy;
      elements.messageList.replaceChildren();
      for (const message of state.conversation) {
        appendChatMessage(message.role, message.text, {
          tone: message.tone || "",
          record: false
        });
      }
      updateAgentButtons();
    }
  })()`);
}

async function exerciseLatencyFastPathContracts({ cdp, panelSessionId, context }) {
  return evaluate(cdp, panelSessionId, `(() => {
    const originalRuntimeSettings = structuredClone(state.runtimeSettings);
    try {
      state.runtimeSettings = {
        ...state.settings,
        includeScreenshot: true
      };
      const domContext = {
        ...structuredClone(${JSON.stringify(context)}),
        visibleText: "Visible navigation",
        forms: [],
        tables: [],
        visualSurfaces: [],
        automationCapabilities: {
          ...structuredClone(${JSON.stringify(context.automationCapabilities || {})}),
          gaps: []
        },
        interactiveElements: [{
          ref: "menu-disclosure",
          scope: "main",
          tag: "button",
          role: "menuitem",
          type: "button",
          label: "Operations",
          ariaExpanded: "false",
          disabled: false,
          actionability: "interactive"
        }]
      };
      const disclosureDecision = {
        status: "continue",
        toolCalls: [],
        actions: [{ id: "open-menu", type: "click", ref: "menu-disclosure" }]
      };
      const readOnlyDecision = {
        status: "continue",
        toolCalls: [],
        actions: [{ id: "read-down", type: "scroll", direction: "down" }]
      };
      const unresolvedClickDecision = {
        status: "continue",
        toolCalls: [],
        actions: [{ id: "unknown-click", type: "click", ref: "missing" }]
      };
      const normalDomScreenshotSkipped = shouldCaptureDecisionScreenshot(domContext) === false;
      const visualSurfaceScreenshotRetained = shouldCaptureDecisionScreenshot({
        ...domContext,
        visualSurfaces: [{ ref: "v1", kind: "canvas" }]
      }) === true;
      const explicitScreenshotRetained = shouldCaptureDecisionScreenshot(
        domContext,
        { requireScreenshot: true }
      ) === true;
      state.runtimeSettings.includeScreenshot = false;
      const disabledScreenshotSkipped = shouldCaptureDecisionScreenshot({
        ...domContext,
        visualSurfaces: [{ ref: "v1", kind: "canvas" }]
      }) === false;
      state.runtimeSettings.includeScreenshot = true;

      return {
        normalDomScreenshotSkipped,
        visualSurfaceScreenshotRetained,
        explicitScreenshotRetained,
        disabledScreenshotSkipped,
        disclosurePolicyAllowed:
          buildDeterministicLowRiskPolicy(disclosureDecision, domContext)?.verdict === "allow",
        readOnlyPolicyAllowed:
          buildDeterministicLowRiskPolicy(readOnlyDecision, domContext)?.verdict === "allow",
        unresolvedClickNeedsPolicy:
          buildDeterministicLowRiskPolicy(unresolvedClickDecision, domContext) === null
      };
    } finally {
      state.runtimeSettings = originalRuntimeSettings;
    }
  })()`);
}

async function exerciseLoopRuntimeContracts({ cdp, panelSessionId, tabId, context }) {
  return evaluate(cdp, panelSessionId, `(async () => {
    const original = {
      requestChatDecision,
      requestExecutionPolicy,
      assessDecisionSafety,
      prepareDecisionForExecution,
      executeDecisionEffects,
      executeDecisionActions,
      waitAfterExecution,
      sendRuntimeMessage,
      collectContext,
      delay,
      verifyCurrentObservationProbe,
      captureScreenshotIfEnabled,
      settings: structuredClone(state.settings),
      runtimeSettings: structuredClone(state.runtimeSettings),
      activeTab: state.activeTab ? structuredClone(state.activeTab) : null,
      lastContext: state.lastContext ? structuredClone(state.lastContext) : null,
      agentSession: state.agentSession,
      agentRunUi: state.agentRunUi,
      currentPlan: state.currentPlan,
      conversation: structuredClone(state.conversation),
      evaluationLogs: structuredClone(state.evaluationLogs)
    };
    try {
      state.runtimeSettings = {
        ...state.settings,
        agentMode: "auto",
        maxAgentSteps: 1,
        maxNoProgressSteps: 2,
        maxActionsPerTurn: 2,
        includeScreenshot: false,
        mcpEnabled: false
      };
      state.activeTab = {
        id: ${JSON.stringify(tabId)},
        title: ${JSON.stringify(context.title)},
        url: ${JSON.stringify(context.url)}
      };
      state.lastContext = structuredClone(${JSON.stringify(context)});
      state.conversation = [];
      state.evaluationLogs = [];
      state.agentSession = {
        runId: "loop-budget-e2e",
        targetTabId: ${JSON.stringify(tabId)},
        documentId: ${JSON.stringify(context.documentId)},
        latestUserMessage: "한 번 실행하고 결과를 확인해줘",
        turnIntent: createFallbackTurnIntent("한 번 실행하고 결과를 확인해줘"),
        successfulEffects: [],
        successfulInteractions: [],
        attemptLedger: [],
        effectSequence: 0,
        effectKeySalt: "loop-budget",
        step: 0,
        history: [],
        evidence: [],
        currentPageEvidenceId: "",
        status: "running",
        stopRequested: false,
        pendingRequestId: "",
        noProgressCount: 0,
        lastObservationFingerprint: "",
        lastDecisionFingerprint: "",
        finalVerificationAvailable: false,
        startedAt: new Date().toISOString()
      };
      startRunTimeline("최종 검증 예산 확인");

      const verificationOnlyFlags = [];
      let decisionCalls = 0;
      requestChatDecision = async (session, options = {}) => {
        verificationOnlyFlags.push(Boolean(options.verificationOnly));
        decisionCalls += 1;
        session.step = decisionCalls;
        if (decisionCalls === 1) {
          return {
            version: "1.0",
            step: 1,
            status: "continue",
            message: "한 번 실행합니다.",
            summary: "실행",
            progress: "대상 확인",
            doneReason: "",
            completionEvidence: [],
            needsUserApproval: false,
            plan: ["실행", "결과 확인"],
            toolCalls: [],
            actions: [{ id: "one-effect", type: "click", ref: "e1", reason: "budget contract" }],
            verification: { required: true, expectedChange: "result", successCriteria: ["result"] },
            validation: { valid: true, errors: [], warnings: [] }
          };
        }
        return {
          version: "1.0",
          step: 2,
          status: "completed",
          message: "실행 결과를 확인했습니다.",
          summary: "완료",
          progress: "최종 상태 확인",
          doneReason: "최종 검증 완료",
          completionEvidence: ["runtime-evidence"],
          needsUserApproval: false,
          plan: ["결과 확인"],
          toolCalls: [],
          actions: [],
          verification: { required: true, expectedChange: "result", successCriteria: ["result"] },
          validation: { valid: true, errors: [], warnings: [] }
        };
      };
      requestExecutionPolicy = async () => ({
        version: "1.0",
        verdict: "allow",
        message: "allowed",
        risks: [],
        sensitiveData: [],
        approvalReasons: []
      });
      assessDecisionSafety = () => ({ blocked: [], warnings: [], requiresApproval: [] });
      prepareDecisionForExecution = async () => ({ valid: true, errors: [] });
      let executedEffects = 0;
      executeDecisionEffects = async (_decision) => {
        executedEffects += 1;
        state.agentSession.finalVerificationAvailable = true;
        return {
          toolResults: [],
          actionResults: [{
            ok: true,
            action: { type: "click" },
            verification: { changed: true }
          }]
        };
      };
      waitAfterExecution = async () => {};
      await runChatAgentLoop();
      const finalStatus = state.agentSession.status;

      waitAfterExecution = original.waitAfterExecution;
      let toolOnlySettleMessages = 0;
      sendRuntimeMessage = async () => {
        toolOnlySettleMessages += 1;
        return {};
      };
      await waitAfterExecution([]);
      sendRuntimeMessage = original.sendRuntimeMessage;

      let permanentRetryCalls = 0;
      const permanentRetryDelays = [];
      collectContext = async () => {
        permanentRetryCalls += 1;
        throw new Error("Permanent observation configuration error");
      };
      delay = async (ms) => {
        permanentRetryDelays.push(ms);
      };
      await collectContextWithRetry().catch(() => null);

      let transientRetryCalls = 0;
      const transientRetryDelays = [];
      collectContext = async () => {
        transientRetryCalls += 1;
        if (transientRetryCalls < 3) {
          throw new Error("Receiving end does not exist");
        }
        return structuredClone(${JSON.stringify(context)});
      };
      delay = async (ms) => {
        transientRetryDelays.push(ms);
      };
      await collectContextWithRetry();

      let exhaustedRetryCalls = 0;
      const exhaustedRetryDelays = [];
      collectContext = async () => {
        exhaustedRetryCalls += 1;
        throw new Error("The message port is closed");
      };
      delay = async (ms) => {
        exhaustedRetryDelays.push(ms);
      };
      await collectContextWithRetry().catch(() => null);

      const freshContext = structuredClone(${JSON.stringify(context)});
      const freshTarget = freshContext.interactiveElements[0];
      const freshDecision = {
        step: 1,
        actions: [{
          id: "fresh-fast-path",
          type: "click",
          ref: freshTarget.ref,
          reason: "freshness fast path"
        }],
        preconditions: [],
        observedDocumentId: freshContext.documentId || "",
        observedPageUrl: freshContext.url || "",
        observationRequest: {}
      };
      freshDecision.preconditions = buildActionPreconditions(freshDecision.actions, freshContext);
      state.lastContext = freshContext;
      verifyCurrentObservationProbe = async () => ({ matches: true, current: null });
      let freshProbeCollections = 0;
      collectContext = async () => {
        freshProbeCollections += 1;
        return freshContext;
      };
      const freshPreparation = await original.prepareDecisionForExecution(freshDecision);

      executeDecisionActions = async () => [{
        ok: true,
        action: { id: "production-final-effect", type: "click", ref: "e1" },
        result: { mayNavigate: false },
        verification: { changed: true, materialChanged: true }
      }];
      state.agentSession.finalVerificationAvailable = false;
      await original.executeDecisionEffects({
        step: 1,
        status: "continue",
        toolCalls: [],
        actions: [{ id: "production-final-effect", type: "click", ref: "e1" }],
        semanticEffects: [],
        structuralInteractions: [],
        executionAttempts: [],
        verification: { expectedChange: "material result", successCriteria: ["result"] }
      });
      const productionFinalVerificationOpened = state.agentSession.finalVerificationAvailable;

      state.lastContext = freshContext;
      const matchingBrowserContext = formatBrowserContext(freshContext.browser || null);
      const makeToolDecision = (overrides = {}) => ({
        step: 1,
        actions: [],
        toolCalls: [{
          toolName: "fixture.update",
          arguments: { record: "page-derived-record" }
        }],
        preconditions: [],
        observedDocumentId: freshContext.documentId || "",
        observedPageUrl: freshContext.url || "",
        observedPageProbe: structuredClone(freshContext.observationProbe || null),
        observedBrowserContext: structuredClone(matchingBrowserContext),
        observedVisualObservationId: "",
        observationRequest: {},
        ...overrides
      });
      sendRuntimeMessage = async (message) => {
        if (message?.type === "GET_BROWSER_CONTEXT") {
          return structuredClone(matchingBrowserContext);
        }
        throw new Error("Unexpected runtime message in tool freshness contract.");
      };
      verifyCurrentObservationProbe = async () => ({ matches: true, current: null });
      const stableToolEvidenceVerification = await verifyToolOnlyPlanningEvidence(
        makeToolDecision(),
        freshContext
      );
      const stableToolPreparation = await original.prepareDecisionForExecution(makeToolDecision());

      let staleToolPreparationUsedPlanningProbe = false;
      verifyCurrentObservationProbe = async (probeContext) => {
        staleToolPreparationUsedPlanningProbe = (
          AgentCore.stableStringify(probeContext?.observationProbe || null)
          === AgentCore.stableStringify(freshContext.observationProbe || null)
        );
        return { matches: false, current: null };
      };
      let staleToolPreparationCollections = 0;
      collectContext = async () => {
        staleToolPreparationCollections += 1;
        return {
          ...freshContext,
          visibleText: String(freshContext.visibleText || "") + " changed record"
        };
      };
      const staleToolPreparation = await original.prepareDecisionForExecution(makeToolDecision());

      const changedBrowserContext = structuredClone(matchingBrowserContext);
      if (changedBrowserContext?.tabs?.length) {
        changedBrowserContext.tabs[0].title = String(
          changedBrowserContext.tabs[0].title || ""
        ) + " changed";
      } else if (changedBrowserContext) {
        changedBrowserContext.error = String(changedBrowserContext.error || "") + " changed";
      }
      verifyCurrentObservationProbe = async () => ({ matches: true, current: null });
      sendRuntimeMessage = async (message) => {
        if (message?.type === "GET_BROWSER_CONTEXT") {
          return structuredClone(changedBrowserContext);
        }
        throw new Error("Unexpected runtime message in browser freshness contract.");
      };
      const changedBrowserToolPreparation = await original.prepareDecisionForExecution(
        makeToolDecision()
      );

      const visualToolContext = structuredClone(freshContext);
      const originalVisualScreenshot = "data:image/png;base64," + btoa(
        "original:" + (freshContext.documentId || freshContext.url)
      );
      const changedVisualScreenshot = "data:image/png;base64," + btoa(
        "changed:" + (freshContext.documentId || freshContext.url)
      );
      await bindScreenshotObservation(visualToolContext, originalVisualScreenshot);
      state.lastContext = visualToolContext;
      state.runtimeSettings.includeScreenshot = true;
      verifyCurrentObservationProbe = async () => ({ matches: true, current: null });
      sendRuntimeMessage = async (message) => {
        if (message?.type === "GET_BROWSER_CONTEXT") {
          return structuredClone(matchingBrowserContext);
        }
        throw new Error("Unexpected runtime message in visual freshness contract.");
      };
      let changedVisualCaptureCalls = 0;
      captureScreenshotIfEnabled = async () => {
        changedVisualCaptureCalls += 1;
        return changedVisualScreenshot;
      };
      const changedVisualToolPreparation = await original.prepareDecisionForExecution(
        makeToolDecision({
          observedPageProbe: structuredClone(visualToolContext.observationProbe || null),
          observedVisualObservationId: visualToolContext.visualObservation.id
        })
      );

      return {
        verificationOnlyFlags,
        executedEffects,
        finalStatus,
        toolOnlySettleMessages,
        permanentRetryCalls,
        permanentRetryDelays: permanentRetryDelays.length,
        transientRetryCalls,
        transientRetryDelays,
        exhaustedRetryCalls,
        exhaustedRetryDelays,
        freshProbeReusedObservation: freshPreparation.reusedObservation,
        freshProbeCollections,
        productionFinalVerificationOpened,
        staleToolPreparationRejected: staleToolPreparation.valid === false,
        staleToolPreparationCollections,
        staleToolPreparationUsedPlanningProbe,
        stableToolPreparationAccepted: stableToolPreparation.valid === true
          && stableToolPreparation.reusedObservation === true,
        stableToolPreparationDiagnostics: {
          errors: stableToolPreparation.errors || [],
          evidenceVerification: stableToolEvidenceVerification
        },
        changedBrowserToolPreparationRejected: changedBrowserToolPreparation.valid === false,
        changedVisualToolPreparationRejected: changedVisualToolPreparation.valid === false,
        changedVisualCaptureCalls
      };
    } finally {
      requestChatDecision = original.requestChatDecision;
      requestExecutionPolicy = original.requestExecutionPolicy;
      assessDecisionSafety = original.assessDecisionSafety;
      prepareDecisionForExecution = original.prepareDecisionForExecution;
      executeDecisionEffects = original.executeDecisionEffects;
      executeDecisionActions = original.executeDecisionActions;
      waitAfterExecution = original.waitAfterExecution;
      sendRuntimeMessage = original.sendRuntimeMessage;
      collectContext = original.collectContext;
      delay = original.delay;
      verifyCurrentObservationProbe = original.verifyCurrentObservationProbe;
      captureScreenshotIfEnabled = original.captureScreenshotIfEnabled;
      state.settings = original.settings;
      state.runtimeSettings = original.runtimeSettings;
      state.activeTab = original.activeTab;
      state.lastContext = original.lastContext;
      state.agentSession = original.agentSession;
      clearRunTimeline();
      state.currentPlan = original.currentPlan;
      state.conversation = original.conversation;
      state.evaluationLogs = original.evaluationLogs;
      elements.messageList.replaceChildren();
      for (const message of state.conversation) {
        appendChatMessage(message.role, message.text, {
          tone: message.tone || "",
          record: false
        });
      }
      updateAgentButtons();
    }
  })()`);
}

async function exerciseAgentVerificationContracts({ cdp, panelSessionId, tabId, context }) {
  return evaluate(cdp, panelSessionId, `(async () => {
    const original = {
      requestAiDecision,
      collectDecisionObservation,
      loadMcpToolContext,
      settings: structuredClone(state.settings),
      runtimeSettings: structuredClone(state.runtimeSettings),
      activeTab: state.activeTab ? { ...state.activeTab } : null,
      lastContext: state.lastContext ? structuredClone(state.lastContext) : null,
      agentSession: state.agentSession,
      agentRunUi: state.agentRunUi,
      currentPlan: state.currentPlan,
      conversation: structuredClone(state.conversation),
      evaluationLogs: structuredClone(state.evaluationLogs)
    };
    const coherentScreenshot = "data:image/png;base64,Y29oZXJlbnQtdmlzdWFsLW9ic2VydmF0aW9u";
    try {
      resetTabScopedState();
      state.activeTab = { id: ${JSON.stringify(tabId)}, title: ${JSON.stringify(context.title)}, url: ${JSON.stringify(context.url)} };
      state.runtimeSettings = {
        ...state.settings,
        includeScreenshot: true,
        mcpEnabled: false,
        maxNoProgressSteps: 2,
        maxActionsPerTurn: 3
      };
      state.conversation = [
        { role: "assistant", text: "현재 화면을 확인한 뒤 상태 정보를 정리해서 전달하겠습니다." },
        { role: "user", text: "계속해줘" }
      ];
      createAgentSession("계속해줘");
      const session = state.agentSession;
      session.turnIntent = AgentCore.normalizeTurnIntent({
        version: "1.0",
        mode: "continue_prior",
        objective: "현재 화면을 확인하고 상태 정보를 정리해서 전달한다.",
        contextSummary: "직전 답변에서 상태 정보를 정리해 전달하기로 했고 사용자가 그 작업을 계속하라고 했다.",
        repeatPolicy: "once",
        repeatLimit: 1,
        completionCriteria: ["현재 화면 상태 정보가 최종 답변에 실제로 포함된다."],
        reason: "최신 메시지는 직전의 구체적인 미완료 전달 약속을 명시적으로 이어 간다."
      });
      const purposes = [];
      const screenshotChecks = [];
      let groundingCallCount = 0;
      let completionVerifierSawTurnIntent = false;
      let groundingVerifierSawTurnIntent = false;
      collectDecisionObservation = async () => ({
        context: ${JSON.stringify(context)},
        screenshotDataUrl: coherentScreenshot
      });
      loadMcpToolContext = async () => ({ enabled: false, tools: [], error: "" });
      requestAiDecision = async (activeSession, request) => {
        purposes.push(request.purpose);
        if (
          request.purpose === "decision"
          || request.purpose === "answer-grounding-repair"
          || request.purpose.startsWith("answer-grounding-")
          || request.purpose.startsWith("verifier-")
        ) {
          screenshotChecks.push(request.screenshotDataUrl === coherentScreenshot);
        }
        if (request.purpose.startsWith("verifier-")) {
          completionVerifierSawTurnIntent = request.user.includes("Resolved turn intent JSON")
            && request.user.includes("현재 화면을 확인하고 상태 정보를 정리해서 전달한다.");
        }
        if (request.purpose.startsWith("answer-grounding-") && request.purpose !== "answer-grounding-repair") {
          groundingVerifierSawTurnIntent = request.user.includes("Resolved turn intent JSON")
            && request.user.includes("현재 화면을 확인하고 상태 정보를 정리해서 전달한다.");
        }
        let payload;
        if (request.purpose === "decision") {
          payload = {
            version: "1.0",
            status: "answer",
            message: "현재 화면에 상태 정보가 보입니다.",
            summary: "화면 답변",
            progress: "현재 화면을 읽었습니다.",
            doneReason: "",
            completionEvidence: [],
            needsUserApproval: false,
            plan: ["현재 화면 확인"],
            toolCalls: [],
            actions: [],
            verification: { required: false, expectedChange: "", successCriteria: [] }
          };
        } else if (request.purpose.startsWith("answer-grounding-") && request.purpose !== "answer-grounding-repair") {
          groundingCallCount += 1;
          payload = groundingCallCount === 1
            ? {
                version: "1.0",
                status: "needs_more_evidence",
                message: "답변을 현재 화면 근거에 맞춰 다시 작성해야 합니다.",
                evidenceIds: [],
                missingEvidence: ["현재 화면과 직접 연결된 표현"],
                confidence: 0.3
              }
            : {
                version: "1.0",
                status: "verified",
                message: "최종 답변이 현재 화면 근거와 대화상 요청을 충족합니다.",
                evidenceIds: [activeSession.currentPageEvidenceId],
                missingEvidence: [],
                confidence: 0.98
              };
        } else if (request.purpose === "answer-grounding-repair") {
          payload = {
            version: "1.0",
            status: "completed",
            message: "현재 화면 확인을 완료했습니다.",
            summary: "화면 확인 완료",
            progress: "현재 뷰포트 근거를 확보했습니다.",
            doneReason: "현재 화면 관찰 근거로 확인됨",
            completionEvidence: [],
            needsUserApproval: false,
            plan: ["현재 화면 확인"],
            toolCalls: [],
            actions: [],
            verification: {
              required: true,
              expectedChange: "현재 화면 관찰",
              successCriteria: ["현재 뷰포트 근거 확인"]
            }
          };
        } else if (request.purpose.startsWith("verifier-")) {
          payload = {
            version: "1.0",
            status: "verified",
            message: "현재 화면 관찰 근거로 완료를 확인했습니다.",
            evidenceIds: [activeSession.currentPageEvidenceId],
            missingEvidence: [],
            confidence: 0.99
          };
        } else {
          throw new Error(\`Unexpected verification purpose: \${request.purpose}\`);
        }
        return { text: JSON.stringify(payload), audit: null };
      };

      const repairedDecision = await requestChatDecision(session);
      const inventedEvidenceDecision = structuredClone(repairedDecision);
      inventedEvidenceDecision.completionEvidence = ["invented-completion-evidence"];
      const inventedEvidenceValidation = validateChatDecision(
        inventedEvidenceDecision,
        ${JSON.stringify(context)},
        { enabled: false, tools: [], error: "" }
      );
      const inventedCompletionEvidenceDiscarded = inventedEvidenceValidation.valid
        && inventedEvidenceDecision.completionEvidence.length === 0;

      state.conversation = [
        { role: "assistant", text: "확인한 상태 정보를 다음 답변에서 정리해 드리겠습니다." },
        { role: "user", text: "좋아요" }
      ];
      createAgentSession("좋아요");
      const promiseSession = state.agentSession;
      promiseSession.turnIntent = AgentCore.normalizeTurnIntent({
        version: "1.0",
        mode: "continue_prior",
        objective: "확인한 상태 정보를 최종 답변에 정리해 전달한다.",
        contextSummary: "직전 답변에서 확인한 정보를 다음 답변에 정리해 주겠다고 약속했고 사용자가 수락했다.",
        repeatPolicy: "once",
        repeatLimit: 1,
        completionCriteria: ["확인한 상태 정보가 최종 답변 본문에 포함된다."],
        reason: "최신 메시지는 직전의 구체적인 미완료 결과 전달을 수락한다."
      });
      const promisePurposes = [];
      let completionVerifierCalls = 0;
      requestAiDecision = async (activeSession, request) => {
        promisePurposes.push(request.purpose);
        let payload;
        if (request.purpose === "decision") {
          payload = {
            version: "1.0",
            status: "completed",
            message: "상태 정보를 확인했습니다. 이제 정리해 드리겠습니다.",
            summary: "상태 확인",
            progress: "현재 화면을 확인했습니다.",
            doneReason: "화면 관찰 완료",
            completionEvidence: [activeSession.currentPageEvidenceId],
            needsUserApproval: false,
            plan: ["현재 화면 확인", "결과 전달"],
            toolCalls: [],
            actions: [],
            verification: {
              required: true,
              expectedChange: "현재 화면 관찰",
              successCriteria: ["상태 정보 확인", "사용자에게 결과 전달"]
            }
          };
        } else if (request.purpose.startsWith("verifier-")) {
          completionVerifierCalls += 1;
          payload = completionVerifierCalls === 1
            ? {
                version: "1.0",
                status: "needs_more_evidence",
                message: "후속 대화에서 약속한 결과가 최종 답변에 포함되지 않았습니다.",
                evidenceIds: [],
                missingEvidence: ["사용자에게 전달할 실제 상태 정보"],
                confidence: 0.99
              }
            : {
                version: "1.0",
                status: "verified",
                message: "근거와 최종 결과 전달을 모두 확인했습니다.",
                evidenceIds: [activeSession.currentPageEvidenceId],
                missingEvidence: [],
                confidence: 0.99
              };
        } else if (request.purpose === "verification-replan") {
          payload = {
            version: "1.0",
            status: "completed",
            message: "현재 화면에서 확인한 상태 정보는 다음과 같습니다: 준비됨.",
            summary: "상태 정보 전달",
            progress: "현재 화면의 상태 정보를 답변에 포함했습니다.",
            doneReason: "요청한 상태 정보를 근거와 함께 전달함",
            completionEvidence: [activeSession.currentPageEvidenceId],
            needsUserApproval: false,
            plan: ["현재 화면 확인", "결과 전달"],
            toolCalls: [],
            actions: [],
            verification: {
              required: true,
              expectedChange: "현재 화면 관찰",
              successCriteria: ["상태 정보 확인", "사용자에게 결과 전달"]
            }
          };
        } else if (request.purpose.startsWith("answer-grounding-")) {
          payload = {
            version: "1.0",
            status: "verified",
            message: "최종 답변의 상태 정보가 현재 화면 근거와 일치합니다.",
            evidenceIds: [activeSession.currentPageEvidenceId],
            missingEvidence: [],
            confidence: 0.99
          };
        } else {
          throw new Error(\`Unexpected promise-delivery verification purpose: \${request.purpose}\`);
        }
        return { text: JSON.stringify(payload), audit: null };
      };
      const promiseRepairedDecision = await requestChatDecision(promiseSession);

      const evidenceSession = {
        ...session,
        runId: "viewport-evidence-contract",
        history: [],
        evidence: [],
        currentPageEvidenceId: ""
      };
      const previousContext = structuredClone(${JSON.stringify(context)});
      previousContext.viewport = { ...previousContext.viewport, scrollY: 0 };
      previousContext.pageState = { ...previousContext.pageState, domRevision: 1 };
      const currentContext = structuredClone(previousContext);
      currentContext.viewport.scrollY = 640;
      currentContext.pageState.domRevision = 2;
      const previousEvidence = registerObservationEvidence(evidenceSession, previousContext, 1);
      const currentEvidence = registerObservationEvidence(evidenceSession, currentContext, 2);
      evidenceSession.currentPageEvidenceId = currentEvidence.id;
      requestAiDecision = async (_activeSession, request) => ({
        text: JSON.stringify({
          version: "1.0",
          status: "verified",
          message: "근거 확인",
          evidenceIds: [previousEvidence.id],
          missingEvidence: [],
          confidence: 0.9
        }),
        audit: null
      });
      const previousViewportEvidence = await requestAnswerGroundingVerification(
        evidenceSession,
        { message: "이전 화면 주장", summary: "", progress: "" },
        currentContext,
        2,
        coherentScreenshot
      );
      requestAiDecision = async () => ({
        text: JSON.stringify({
          version: "1.0",
          status: "verified",
          message: "현재 근거 확인",
          evidenceIds: [currentEvidence.id],
          missingEvidence: [],
          confidence: 0.99
        }),
        audit: null
      });
      const currentViewportEvidence = await requestAnswerGroundingVerification(
        evidenceSession,
        { message: "현재 화면 주장", summary: "", progress: "" },
        currentContext,
        2,
        coherentScreenshot
      );
      const completionCandidate = {
        status: "completed",
        message: "현재 화면 확인을 완료했습니다.",
        summary: "현재 화면 확인",
        progress: "확인 완료",
        doneReason: "현재 화면 근거로 완료",
        completionEvidence: [],
        verification: {
          required: true,
          expectedChange: "현재 화면 확인",
          successCriteria: ["현재 화면 근거"]
        }
      };
      requestAiDecision = async () => ({
        text: JSON.stringify({
          version: "1.0",
          status: "verified",
          message: "이전 근거만 인용",
          evidenceIds: [previousEvidence.id],
          missingEvidence: [],
          confidence: 0.99
        }),
        audit: null
      });
      const previousCompletionEvidence = await requestCompletionVerification(
        evidenceSession,
        completionCandidate,
        currentContext,
        2,
        coherentScreenshot
      );
      requestAiDecision = async () => ({
        text: JSON.stringify({
          version: "1.0",
          status: "verified",
          message: "현재 근거 인용",
          evidenceIds: [currentEvidence.id],
          missingEvidence: [],
          confidence: 0.99
        }),
        audit: null
      });
      const currentCompletionEvidence = await requestCompletionVerification(
        evidenceSession,
        completionCandidate,
        currentContext,
        2,
        coherentScreenshot
      );

      const retainedEvidenceSession = {
        ...evidenceSession,
        runId: "retained-effect-evidence-contract",
        evidence: [],
        currentPageEvidenceId: ""
      };
      const retainedEffectEvidence = registerRuntimeEvidence(retainedEvidenceSession, {
        source: "action_result",
        step: 1,
        summary: "A material effect that must survive later page observations.",
        url: currentContext.url,
        documentId: currentContext.documentId,
        payload: { outcome: "changed" }
      });
      const staleVisualEvidence = registerRuntimeEvidence(retainedEvidenceSession, {
        source: "visual_observation",
        step: 1,
        summary: "A prior screenshot that must not remain completion evidence.",
        url: currentContext.url,
        documentId: currentContext.documentId,
        payload: { visualObservation: { id: "stale-visual" } }
      });
      for (let index = 0; index < 30; index += 1) {
        const observationContext = structuredClone(currentContext);
        observationContext.viewport.scrollY = index;
        const observationEvidence = registerObservationEvidence(
          retainedEvidenceSession,
          observationContext,
          index + 2
        );
        retainedEvidenceSession.currentPageEvidenceId = observationEvidence.id;
      }
      const retainedCompletionEvidence = getCompletionVerificationEvidence(
        retainedEvidenceSession
      );
      const retainedCompletionEvidenceIds = retainedCompletionEvidence.map((entry) => entry.id);

      const toolOnlyEvidenceSession = {
        ...evidenceSession,
        runId: "tool-only-completion-contract",
        evidence: [],
        attemptLedger: [],
        currentPageEvidenceId: ""
      };
      const unrelatedPageEvidence = registerObservationEvidence(
        toolOnlyEvidenceSession,
        currentContext,
        1
      );
      toolOnlyEvidenceSession.currentPageEvidenceId = unrelatedPageEvidence.id;
      const toolResultEvidence = registerRuntimeEvidence(toolOnlyEvidenceSession, {
        source: "tool_result",
        step: 1,
        summary: "The requested tool returned its result.",
        url: currentContext.url,
        documentId: currentContext.documentId,
        payload: { result: "tool-only-result" }
      });
      const toolOnlyCompletionDecision = {
        ...completionCandidate,
        message: "도구 조회 결과는 tool-only-result입니다.",
        completionEvidence: [toolResultEvidence.id]
      };
      requestAiDecision = async () => ({
        text: JSON.stringify({
          version: "1.0",
          status: "verified",
          message: "도구 결과만으로 완료를 확인했습니다.",
          evidenceIds: [toolResultEvidence.id],
          missingEvidence: [],
          confidence: 0.99
        }),
        audit: null
      });
      const toolOnlyCompletionVerifier = await requestCompletionVerification(
        toolOnlyEvidenceSession,
        toolOnlyCompletionDecision,
        currentContext,
        2,
        ""
      );
      const toolOnlyCompletionBound = bindVerifiedCompletionEvidence(
        toolOnlyCompletionDecision,
        toolOnlyCompletionVerifier,
        toolOnlyEvidenceSession
      );

      const visualContext = structuredClone(currentContext);
      visualContext.visualObservation = {
        id: "visual-current-runtime-binding",
        screenshotBound: true,
        coordinateSystem: "surface-relative-0-1000"
      };
      visualContext.visualSurfaces = [{
        ref: "v1",
        kind: "canvas",
        tag: "canvas",
        label: "Visual command surface",
        selector: "#visual-canvas",
        rect: { x: 20, y: 120, width: 240, height: 80 },
        actionability: "visual-coordinate-only"
      }];
      const visualDecision = {
        step: 3,
        actions: [{
          id: "visual-contract-action",
          type: "visual_click",
          ref: "v1",
          visualObservationId: "visual-planner-binding",
          xNormalized: 750,
          yNormalized: 500,
          targetDescription: "green Apply area",
          reason: "visual verifier contract"
        }]
      };
      let visualVerifierReceivedScreenshot = false;
      requestAiDecision = async (activeSession, request) => {
        visualVerifierReceivedScreenshot = request.screenshotDataUrl === coherentScreenshot;
        const visualEvidence = activeSession.evidence.findLast((item) => item.source === "visual_observation");
        return {
          text: JSON.stringify({
            version: "1.0",
            status: "verified",
            message: "화면 좌표 대상을 확인했습니다.",
            evidenceIds: [visualEvidence.id],
            missingEvidence: [],
            confidence: 0.97
          }),
          audit: null
        };
      };
      const visualVerified = await verifyVisualActionsBeforeExecution(visualDecision, {
        context: visualContext,
        screenshotDataUrl: coherentScreenshot
      });
      const visualActionRebound = visualDecision.actions[0].visualObservationId === visualContext.visualObservation.id;

      const rejectedDecision = structuredClone(visualDecision);
      requestAiDecision = async (activeSession) => {
        const visualEvidence = activeSession.evidence.findLast((item) => item.source === "visual_observation");
        return {
          text: JSON.stringify({
            version: "1.0",
            status: "rejected",
            message: "대상이 모호합니다.",
            evidenceIds: [visualEvidence.id],
            missingEvidence: ["명확한 화면 대상"],
            confidence: 0.2
          }),
          audit: null
        };
      };
      const visualRejected = await verifyVisualActionsBeforeExecution(rejectedDecision, {
        context: visualContext,
        screenshotDataUrl: coherentScreenshot
      });

      elements.messageList.replaceChildren();
      startRunTimeline("누적 작업 흐름 검증");
      updateRunTimeline("actions", "done", "2개 액션 완료");
      markUnusedTimelineEffectsSkipped();
      const actionTimeline = state.agentRunUi.phaseElements.actions;
      const timelinePreservedEarlierAction = actionTimeline.item.dataset.status === "done"
        && actionTimeline.detail.textContent === "2개 액션 완료";
      const timelineDockCardCount = elements.activityDock.querySelectorAll(".activity-card").length;
      const timelineDetachedFromConversation = !elements.messageList.querySelector(".activity-card, .timeline-message");
      const messageCountBeforeSuccess = elements.messageList.children.length;
      appendExecutionResultMessage([{
        ok: true,
        index: 0,
        action: { type: "click" },
        result: { internal: "raw-payload-must-stay-hidden" }
      }]);
      const successPayloadHiddenFromChat = elements.messageList.children.length === messageCountBeforeSuccess
        && !elements.messageList.textContent.includes("raw-payload-must-stay-hidden");

      return {
        repairedStatus: repairedDecision.status,
        completionVerified: repairedDecision.verifier?.status === "verified",
        terminalGroundingVerified: repairedDecision.grounding?.status === "verified",
        terminalGroundingCombined:
          repairedDecision.grounding?.combinedWithCompletionVerification === true,
        completionVerifierSawTurnIntent,
        groundingVerifierSawTurnIntent,
        completionEvidenceBound: repairedDecision.completionEvidence.length === 1
          && repairedDecision.completionEvidence[0] === session.currentPageEvidenceId,
        completionEvidenceRepairSkipped: !purposes.includes("repair"),
        completionEvidenceErrorHidden: !repairedDecision.message.includes("completionEvidence"),
        inventedCompletionEvidenceDiscarded,
        promiseReplanOccurred: promisePurposes.includes("verification-replan"),
        promiseCompletionVerifierCalls: completionVerifierCalls,
        promiseUsedSeparateGroundingVerifier: promisePurposes.some(
          (purpose) => purpose.startsWith("answer-grounding-")
        ),
        promiseFinalMessage: promiseRepairedDecision.message,
        promiseFinalStatus: promiseRepairedDecision.status,
        timelinePreservedEarlierAction,
        timelineDockCardCount,
        timelineDetachedFromConversation,
        successPayloadHiddenFromChat,
        purposes,
        allVisualVerificationCallsReceivedScreenshot: screenshotChecks.length >= 4 && screenshotChecks.every(Boolean),
        previousViewportEvidenceStatus: previousViewportEvidence.status,
        currentViewportEvidenceStatus: currentViewportEvidence.status,
        previousCompletionEvidenceStatus: previousCompletionEvidence.status,
        currentCompletionEvidenceStatus: currentCompletionEvidence.status,
        earlierEffectEvidenceRetained:
          retainedCompletionEvidenceIds.includes(retainedEffectEvidence.id),
        onlyCurrentViewportRetained:
          retainedCompletionEvidence.filter((entry) => entry.source === "page_observation").length === 1
          && retainedCompletionEvidenceIds.includes(retainedEvidenceSession.currentPageEvidenceId),
        staleVisualEvidenceExcluded:
          !retainedCompletionEvidenceIds.includes(staleVisualEvidence.id),
        toolOnlyCompletionVerifiedWithoutUnrelatedPage:
          toolOnlyCompletionVerifier.status === "verified"
          && toolOnlyCompletionBound
          && toolOnlyCompletionDecision.completionEvidence.length === 1
          && toolOnlyCompletionDecision.completionEvidence[0] === toolResultEvidence.id,
        visualActionVerified: visualVerified.valid,
        visualActionRebound,
        visualVerifierReceivedScreenshot,
        visualActionRejectedClosed: !visualRejected.valid
      };
    } finally {
      requestAiDecision = original.requestAiDecision;
      collectDecisionObservation = original.collectDecisionObservation;
      loadMcpToolContext = original.loadMcpToolContext;
      state.settings = original.settings;
      state.runtimeSettings = original.runtimeSettings;
      state.activeTab = original.activeTab;
      state.lastContext = original.lastContext;
      state.agentSession = original.agentSession;
      clearRunTimeline();
      state.currentPlan = original.currentPlan;
      state.conversation = original.conversation;
      state.evaluationLogs = original.evaluationLogs;
      elements.messageList.replaceChildren();
      for (const message of state.conversation) {
        appendChatMessage(message.role, message.text, { tone: message.tone || "", record: false });
      }
      updateAgentButtons();
    }
  })()`);
}

async function exerciseTabTransitionContracts({ cdp, panelSessionId }) {
  return evaluate(cdp, panelSessionId, `(async () => {
    const original = {
      readActiveTabSummary,
      persistCurrentSession,
      restoreConversationForActiveTab,
      activeTab: state.activeTab ? { ...state.activeTab } : null,
      lastContext: state.lastContext ? structuredClone(state.lastContext) : null,
      agentSession: state.agentSession,
      conversation: structuredClone(state.conversation),
      busy: state.busy,
      pending: state.activeTabTransitionPending,
      revision: state.activeTabTransitionRevision,
      queued: state.activeTabTransitionQueued,
      running: state.activeTabTransitionRunning
    };
    try {
      await activeTabTransitionQueue.catch(() => {});
      state.activeTabTransitionPending = false;
      state.activeTabTransitionQueued = false;
      state.activeTabTransitionRunning = false;
      state.busy = false;
      state.activeTab = { id: 980001, title: "Tab A", url: "https://example.test/a" };
      state.lastContext = null;
      state.conversation = [{ role: "user", text: "유지해야 하는 실행 중 메시지" }];
      persistCurrentSession = async () => {};
      restoreConversationForActiveTab = async () => false;

      let releaseLookup;
      readActiveTabSummary = () => new Promise((resolve) => {
        releaseLookup = () => resolve({ id: 980002, title: "Tab B", url: "https://example.test/b" });
      });
      const firstTransition = scheduleActiveTabTransition();
      await Promise.resolve();
      await Promise.resolve();
      state.busy = true;
      state.agentSession = {
        targetTabId: 980001,
        status: "running",
        stopRequested: false
      };
      releaseLookup();
      await firstTransition;
      const preservedRunningSession = state.activeTab.id === 980001
        && state.agentSession?.targetTabId === 980001
        && state.conversation[0]?.text === "유지해야 하는 실행 중 메시지"
        && state.activeTabTransitionPending;

      let deferredLookupCount = 0;
      readActiveTabSummary = async () => {
        deferredLookupCount += 1;
        return { id: 980003, title: "Tab C", url: "https://example.test/c" };
      };
      scheduleActiveTabTransition();
      await Promise.resolve();
      const deferredWhileBound = deferredLookupCount === 0 && state.activeTabTransitionPending;
      state.agentSession.status = "stopped";
      state.agentSession.stopRequested = true;
      state.busy = false;
      resumeActiveTabTransition();
      await settleActiveTabTransitions();
      const resumedOnLatestTab = state.activeTab.id === 980003 && !state.activeTabTransitionPending;
      return { preservedRunningSession, deferredWhileBound, resumedOnLatestTab };
    } finally {
      readActiveTabSummary = original.readActiveTabSummary;
      persistCurrentSession = original.persistCurrentSession;
      restoreConversationForActiveTab = original.restoreConversationForActiveTab;
      state.activeTab = original.activeTab;
      state.lastContext = original.lastContext;
      state.agentSession = original.agentSession;
      state.conversation = original.conversation;
      state.busy = original.busy;
      state.activeTabTransitionPending = original.pending;
      state.activeTabTransitionRevision = original.revision;
      state.activeTabTransitionQueued = original.queued;
      state.activeTabTransitionRunning = original.running;
      elements.messageList.replaceChildren();
      for (const message of state.conversation) {
        appendChatMessage(message.role, message.text, { tone: message.tone || "", record: false });
      }
      updateAgentButtons();
    }
  })()`);
}

async function runConfiguredLiveSiteSmoke({ cdp, panelSessionId }) {
  const url = new URL(process.env.WEB_PLUGIN_LIVE_URL);
  const username = String(process.env.WEB_PLUGIN_LIVE_USERNAME || "");
  const password = String(process.env.WEB_PLUGIN_LIVE_PASSWORD || "");
  assert.ok(username, "WEB_PLUGIN_LIVE_USERNAME is required with WEB_PLUGIN_LIVE_URL.");
  assert.ok(password, "WEB_PLUGIN_LIVE_PASSWORD is required with WEB_PLUGIN_LIVE_URL.");
  const steps = parseConfiguredLiveSteps(process.env.WEB_PLUGIN_LIVE_STEPS || "[]");
  assert.ok(steps.length, "WEB_PLUGIN_LIVE_STEPS must contain at least one visible label.");

  const targetId = await createPage(cdp, url.href);
  try {
    const tabId = await queryTabId(cdp, panelSessionId, url.origin);
    assert.ok(tabId, `No browser tab was found for the configured live origin ${url.origin}.`);
    await evaluate(cdp, panelSessionId, `chrome.tabs.update(${JSON.stringify(tabId)}, { active: true })`);

    const loginContext = await poll(
      async () => collectLivePageContext(cdp, panelSessionId, tabId),
      (context) => Boolean(
        findLivePasswordTarget(context)
        && findLiveUsernameTarget(context)
        && findLiveSubmitTarget(context)
      ),
      15_000
    );
    const usernameTarget = findLiveUsernameTarget(loginContext);
    const passwordTarget = findLivePasswordTarget(loginContext);
    const submitTarget = findLiveSubmitTarget(loginContext);
    const loginStartedAt = performance.now();
    const loginResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: tabId,
      actions: [
        { id: "live-username", type: "fill", ref: usernameTarget.ref, value: username },
        { id: "live-password", type: "fill", ref: passwordTarget.ref, value: password },
        { id: "live-submit", type: "click", ref: submitTarget.ref }
      ]
    });
    assert.equal(loginResult.ok, true, loginResult.error?.message || "Live login execution failed.");
    assert.equal(
      loginResult.data.results.every((result) => result.ok),
      true,
      JSON.stringify(loginResult.data.results)
    );
    const loginSettle = await extensionMessage(cdp, panelSessionId, {
      type: "WAIT_FOR_PAGE_SETTLE",
      targetTabId: tabId,
      options: { quietMs: 180, timeoutMs: 4000 }
    });
    assert.equal(loginSettle.ok, true);
    const firstStepLabel = steps[0].label;
    const authenticatedContext = await poll(
      async () => collectLivePageContext(cdp, panelSessionId, tabId, {
        elementQuery: firstStepLabel,
        maxElements: 80
      }),
      (context) => !findLivePasswordTarget(context) && Boolean(findLiveStepTarget(context, steps[0])),
      15_000
    );
    const loginElapsedMs = Math.round(performance.now() - loginStartedAt);
    const stepResults = [];
    let currentContext = authenticatedContext;

    for (const [index, step] of steps.entries()) {
      const observedAt = performance.now();
      currentContext = await collectLivePageContext(cdp, panelSessionId, tabId, {
        elementQuery: step.label,
        elementRoles: step.role ? [step.role] : [],
        maxElements: 80
      });
      const observeMs = Math.round(performance.now() - observedAt);
      const target = findLiveStepTarget(currentContext, step);
      assert.ok(
        target?.ref,
        `Live step ${index + 1} could not find a visible target labelled "${step.label}".`
      );

      const actionStartedAt = performance.now();
      const actionResult = await extensionMessage(cdp, panelSessionId, {
        type: "EXECUTE_PAGE_ACTIONS",
        targetTabId: tabId,
        actions: [{
          id: `live-step-${index + 1}`,
          type: "click",
          ref: target.ref,
          reason: "Configured live-site semantic navigation smoke test"
        }]
      });
      const actionMs = Math.round(performance.now() - actionStartedAt);
      assert.equal(actionResult.ok, true, actionResult.error?.message || `Live step ${index + 1} failed.`);
      assert.equal(
        actionResult.data.results[0]?.ok,
        true,
        JSON.stringify(actionResult.data.results[0])
      );

      const settleStartedAt = performance.now();
      const settleResult = await extensionMessage(cdp, panelSessionId, {
        type: "WAIT_FOR_PAGE_SETTLE",
        targetTabId: tabId,
        options: {
          quietMs: actionResult.data.results[0]?.result?.mayNavigate ? 240 : 120,
          timeoutMs: 4000
        }
      });
      const settleMs = Math.round(performance.now() - settleStartedAt);
      assert.equal(settleResult.ok, true);
      currentContext = await collectLivePageContext(cdp, panelSessionId, tabId);
      process.stdout.write(
        `Configured live-site step ${index + 1}: ${JSON.stringify({
          label: step.label,
          target: {
            tag: target.tag || "",
            role: target.role || "",
            href: target.href ? readUrlPath(target.href) : ""
          },
          result: actionResult.data.results[0]?.result || null,
          verification: actionResult.data.results[0]?.verification || null,
          path: readUrlPath(currentContext.url),
          observeMs,
          actionMs,
          settleMs
        })}\n`
      );
      if (step.path) {
        currentContext = await poll(
          async () => collectLivePageContext(cdp, panelSessionId, tabId),
          (context) => readUrlPath(context.url) === step.path,
          15_000
        );
      }
      stepResults.push({
        label: step.label,
        target: `${target.tag || ""}/${target.role || ""}`,
        path: readUrlPath(currentContext.url),
        observeMs,
        actionMs,
        settleMs,
        stableForMs: settleResult.data.stableForMs
      });
    }

    process.stdout.write(
      `Configured live-site extension smoke passed: login=${loginElapsedMs}ms, steps=${JSON.stringify(stepResults)}\n`
    );
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

function parseConfiguredLiveSteps(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("WEB_PLUGIN_LIVE_STEPS must be a JSON array.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("WEB_PLUGIN_LIVE_STEPS must be a JSON array.");
  }
  return parsed.map((item, index) => {
    const source = typeof item === "string" ? { label: item } : item;
    const label = String(source?.label || "").trim();
    if (!label) {
      throw new Error(`WEB_PLUGIN_LIVE_STEPS[${index}] requires a label.`);
    }
    const pathValue = String(source?.path || "").trim();
    if (pathValue && !pathValue.startsWith("/")) {
      throw new Error(`WEB_PLUGIN_LIVE_STEPS[${index}].path must start with "/".`);
    }
    return {
      label,
      role: String(source?.role || "").trim().toLowerCase(),
      path: pathValue
    };
  });
}

async function collectLivePageContext(cdp, panelSessionId, tabId, options = {}) {
  const response = await extensionMessage(cdp, panelSessionId, {
    type: "COLLECT_PAGE_CONTEXT",
    targetTabId: tabId,
    options: {
      maxTextChars: 12_000,
      maxElements: options.maxElements || 120,
      elementQuery: options.elementQuery || "",
      elementRoles: options.elementRoles || [],
      redactSensitiveData: true
    }
  });
  if (!response?.ok) {
    throw new Error(response?.error?.message || "Live page observation failed.");
  }
  return response.data;
}

function findLiveUsernameTarget(context) {
  const candidates = (context?.interactiveElements || []).filter((target) => {
    const type = String(target.type || "text").toLowerCase();
    return target.tag === "input"
      && ["", "text", "email", "tel"].includes(type)
      && !target.disabled;
  });
  return candidates
    .map((target, index) => ({
      target,
      index,
      score: [
        String(target.autocomplete || "").toLowerCase() === "username" ? 8 : 0,
        /user|account|login|email|아이디|사용자|계정/i.test(
          [target.label, target.name, target.placeholder].filter(Boolean).join(" ")
        ) ? 5 : 0,
        String(target.type || "").toLowerCase() === "email" ? 2 : 0
      ].reduce((sum, value) => sum + value, 0)
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.target || null;
}

function findLivePasswordTarget(context) {
  return (context?.interactiveElements || []).find((target) => (
    target.tag === "input"
    && String(target.type || "").toLowerCase() === "password"
    && !target.disabled
  )) || null;
}

function findLiveSubmitTarget(context) {
  const candidates = (context?.interactiveElements || []).filter((target) => (
    !target.disabled
    && (
      target.tag === "button"
      || (target.tag === "input" && ["button", "submit"].includes(String(target.type || "").toLowerCase()))
    )
  ));
  return candidates
    .map((target, index) => ({
      target,
      index,
      score: [
        String(target.type || "").toLowerCase() === "submit" ? 6 : 0,
        /sign.?in|log.?in|로그인|접속/i.test(String(target.label || "")) ? 5 : 0
      ].reduce((sum, value) => sum + value, 0)
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.target || null;
}

function findLiveStepTarget(context, step) {
  const expected = normalizeLiveLabel(step.label);
  const candidates = (context?.interactiveElements || []).filter((target) => (
    !target.disabled
    && (!step.role || String(target.role || "").toLowerCase() === step.role)
  ));
  return candidates.find((target) => normalizeLiveLabel(target.label) === expected)
    || candidates.find((target) => normalizeLiveLabel(target.label).includes(expected))
    || null;
}

function normalizeLiveLabel(value) {
  return String(value || "").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

function readUrlPath(value) {
  try {
    return new URL(value).pathname;
  } catch {
    return "";
  }
}

async function extensionMessage(cdp, sessionId, message) {
  return evaluate(cdp, sessionId, `chrome.runtime.sendMessage(${JSON.stringify(message)})`);
}

function toolData(result) {
  assert.notEqual(result?.isError, true, result?.content?.[0]?.text || "MCP tool call failed.");
  if (result?.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  return JSON.parse(result?.content?.[0]?.text || "null");
}

async function readInputValue(cdp, targetId) {
  const sessionId = await attach(cdp, targetId);
  return evaluate(cdp, sessionId, "document.querySelector('#name')?.value || ''");
}

async function capturePanelScreenshot(cdp, panelSessionId, filename) {
  const languageSnapshot = await evaluate(cdp, panelSessionId, `(async () => {
    const snapshot = {
      settingsLanguage: state.settings.uiLanguage,
      runtimeLanguage: state.runtimeSettings?.uiLanguage
    };
    state.settings = { ...state.settings, uiLanguage: "en" };
    state.runtimeSettings = { ...(state.runtimeSettings || state.settings), uiLanguage: "en" };
    applySettingsToForm();
    applyUiLanguage();
    renderBridgeStatus();
    renderExternalApprovalPanel();
    renderSettingsOverview();
    applyUiLanguage();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return snapshot;
  })()`);
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 420,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    }, panelSessionId);
    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    }, panelSessionId);
    await writeFile(path.join(root, "docs", "assets", filename), Buffer.from(data, "base64"));
  } finally {
    await evaluate(cdp, panelSessionId, `(() => {
      const snapshot = ${JSON.stringify(languageSnapshot)};
      state.settings = { ...state.settings, uiLanguage: snapshot.settingsLanguage };
      state.runtimeSettings = {
        ...(state.runtimeSettings || state.settings),
        uiLanguage: snapshot.runtimeLanguage
      };
      applySettingsToForm();
      applyUiLanguage();
      renderBridgeStatus();
      renderExternalApprovalPanel();
      renderSettingsOverview();
      applyUiLanguage();
      return true;
    })()`);
  }
}

async function captureWebCompatibilityDocs(cdp, panelSessionId, context) {
  await evaluate(cdp, panelSessionId, `(async () => {
    const original = {
      activeTab: state.activeTab ? structuredClone(state.activeTab) : null,
      lastContext: state.lastContext ? structuredClone(state.lastContext) : null,
      contextModalHidden: elements.contextModal.hidden,
      status: elements.contextStatus.textContent
    };
    globalThis.__compatibilityCaptureSnapshot = original;
    const sanitized = JSON.parse(JSON.stringify(${JSON.stringify(context)}).replace(
      /http:\\/\\/127\\.0\\.0\\.1:\\d+/g,
      "https://fixture.invalid"
    ));
    sanitized.title = "Web compatibility fixture";
    sanitized.url = "https://fixture.invalid/dashboard";
    state.activeTab = { id: 1, title: sanitized.title, url: sanitized.url };
    state.lastContext = sanitized;
    closeSettings();
    hideRestrictedPage();
    openContext();
    renderContextPanel(sanitized);
    elements.contextStatus.textContent = "Real-browser verification context";
    document.querySelector(".context-body")?.scrollTo({ top: 0 });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return true;
  })()`);
  await capturePanelScreenshot(cdp, panelSessionId, "web-compatibility.png");
  await evaluate(cdp, panelSessionId, `(() => {
    const original = globalThis.__compatibilityCaptureSnapshot;
    state.activeTab = original.activeTab;
    state.lastContext = original.lastContext;
    elements.contextModal.hidden = original.contextModalHidden;
    elements.contextStatus.textContent = original.status;
    document.body.classList.remove("settings-open");
    delete globalThis.__compatibilityCaptureSnapshot;
    return true;
  })()`);
}

async function captureTemplateManagerDocs(cdp, panelSessionId) {
  await evaluate(cdp, panelSessionId, `(async () => {
    globalThis.__templateCaptureSnapshot = {
      taskTemplates: structuredClone(state.settings.taskTemplates || []),
      selectedId: elements.templateSelect.value,
      popoverOpen: elements.templatePopover.open,
      chatInput: elements.chatInput.value,
      statusText: elements.statusLine.textContent
    };
    state.settings.taskTemplates = [{
      id: "custom-release-check",
      title: "Pre-release review",
      prompt: "Summarize the checks and risks visible on the current page before release."
    }];
    elements.chatInput.value = "";
    elements.statusLine.textContent = "Editing the selected template";
    hideRestrictedPage();
    closeUtilityMenu();
    renderTemplateSelect("custom-release-check");
    elements.templatePopover.open = true;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return true;
  })()`);
  try {
    await capturePanelScreenshot(cdp, panelSessionId, "template-manager.png");
  } finally {
    await evaluate(cdp, panelSessionId, `(() => {
      const snapshot = globalThis.__templateCaptureSnapshot;
      state.settings.taskTemplates = snapshot.taskTemplates;
      elements.chatInput.value = snapshot.chatInput;
      elements.statusLine.textContent = snapshot.statusText;
      renderTemplateSelect(snapshot.selectedId);
      elements.templatePopover.open = snapshot.popoverOpen;
      delete globalThis.__templateCaptureSnapshot;
      return true;
    })()`);
  }
}

async function captureAgentPanelDocs(cdp, panelSessionId) {
  const markdownDemo = [
    "## Current page review",
    "",
    "**Summary:** This result reflects the current page and marks items that *need follow-up*.",
    "",
    "| Item | Status |",
    "| --- | --- |",
    "| Signed-in state | Verified |",
    "| Pending requests | 3 |",
    "",
    "- [x] Observe the current page",
    "- [ ] Review pending-request details",
    "",
    "> The result includes only information shown on the page.",
    "",
    "The current observation replaces the ~~previous state~~.",
    "",
    "The `next page` action has not been run."
  ].join("\n");
  await evaluate(cdp, panelSessionId, `(async () => {
    globalThis.__agentPanelCaptureSnapshot = {
      settings: structuredClone(state.settings),
      runtimeSettings: structuredClone(state.runtimeSettings),
      activeTab: state.activeTab ? structuredClone(state.activeTab) : null,
      conversation: structuredClone(state.conversation),
      externalApprovals: structuredClone(state.externalApprovals),
      selectedExternalOperationId: state.selectedExternalOperationId,
      statusText: elements.statusLine.textContent,
      settingsHidden: elements.settingsModal.hidden,
      contextHidden: elements.contextModal.hidden,
      exportHidden: elements.exportModal.hidden
    };
    state.settings = {
      ...state.settings,
      agentMode: "approve",
      mcpEnabled: false,
      bridgeEnabled: false
    };
    state.runtimeSettings = { ...state.settings };
    applyActiveTabSummary({ id: 1, title: "Example dashboard", url: "https://fixture.invalid/dashboard" });
    state.conversation = [
      { role: "user", text: "Summarize the current-page checks in a table." },
      { role: "assistant", text: ${JSON.stringify(markdownDemo)} }
    ];
    elements.messageList.replaceChildren();
    for (const message of state.conversation) {
      appendChatMessage(message.role, message.text, { record: false });
    }
    startRunTimeline("Summarize the current-page checks in a table.");
    updateRunTimeline("observe", "done", "Visible page content collected");
    updateRunTimeline("think", "done", "Response prepared");
    updateRunTimeline("tools", "skipped", "No tool execution");
    updateRunTimeline("actions", "skipped", "No page actions");
    updateRunTimeline("verify", "done", "Current-page evidence verified");
    updateRunTimeline("done", "done", "Summary completed");
    elements.settingsModal.hidden = true;
    elements.contextModal.hidden = true;
    elements.exportModal.hidden = true;
    document.body.classList.remove("settings-open");
    closeTransientMenus();
    hideApprovalPanel();
    state.externalApprovals = [];
    renderExternalApprovalPanel();
    hideRestrictedPage();
    updateStatusBadges();
    setStatusLine("Waiting for a request");
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return true;
  })()`);
  try {
    await capturePanelScreenshot(cdp, panelSessionId, "agent-panel.png");
  } finally {
    await evaluate(cdp, panelSessionId, `(() => {
      const snapshot = globalThis.__agentPanelCaptureSnapshot;
      state.settings = snapshot.settings;
      state.runtimeSettings = snapshot.runtimeSettings;
      state.activeTab = snapshot.activeTab;
      if (snapshot.activeTab) applyActiveTabSummary(snapshot.activeTab);
      state.conversation = snapshot.conversation;
      state.externalApprovals = snapshot.externalApprovals;
      state.selectedExternalOperationId = snapshot.selectedExternalOperationId;
      clearRunTimeline();
      elements.messageList.replaceChildren();
      for (const message of state.conversation) {
        appendChatMessage(message.role, message.text, { tone: message.tone || "", record: false });
      }
      elements.settingsModal.hidden = snapshot.settingsHidden;
      elements.contextModal.hidden = snapshot.contextHidden;
      elements.exportModal.hidden = snapshot.exportHidden;
      document.body.classList.toggle("settings-open", !snapshot.settingsHidden || !snapshot.contextHidden || !snapshot.exportHidden);
      setStatusLine(snapshot.statusText);
      updateStatusBadges();
      renderExternalApprovalPanel();
      delete globalThis.__agentPanelCaptureSnapshot;
      return true;
    })()`);
  }
}

async function captureSettingsOverviewDocs(cdp, panelSessionId) {
  await evaluate(cdp, panelSessionId, `(async () => {
    globalThis.__settingsCaptureSnapshot = {
      settings: structuredClone(state.settings),
      runtimeSettings: structuredClone(state.runtimeSettings),
      panelPresentation: structuredClone(state.panelPresentation),
      modalHidden: elements.settingsModal.hidden,
      activeTab: elements.settingsTabs.find((tab) => tab.classList.contains("active"))?.dataset.settingsTab || "general",
      status: elements.settingsStatus.textContent,
      statusTone: elements.settingsStatus.dataset.tone || "info"
    };
    state.settings = {
      ...state.settings,
      uiLanguage: "ko",
      panelOpenMode: "side-panel",
      apiProfile: "custom-json",
      model: "local-instruct-model",
      agentMode: "approve",
      includeScreenshot: true,
      mcpEnabled: false,
      bridgeEnabled: false,
      bridgeRequireApproval: true
    };
    state.runtimeSettings = { ...state.settings };
    applySettingsToForm();
    applyUiLanguage();
    openSettings();
    activateSettingsTab("general");
    setSettingsStatus("All changes have been saved.");
    renderSettingsOverview();
    document.querySelector(".settings-body")?.scrollTo({ top: 0 });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return true;
  })()`);
  try {
    await capturePanelScreenshot(cdp, panelSessionId, "settings-overview.png");
  } finally {
    await evaluate(cdp, panelSessionId, `(() => {
      const snapshot = globalThis.__settingsCaptureSnapshot;
      state.settings = snapshot.settings;
      state.runtimeSettings = snapshot.runtimeSettings;
      state.panelPresentation = snapshot.panelPresentation;
      applySettingsToForm();
      applyUiLanguage();
      activateSettingsTab(snapshot.activeTab);
      elements.settingsModal.hidden = snapshot.modalHidden;
      document.body.classList.toggle("settings-open", !snapshot.modalHidden);
      setSettingsStatus(snapshot.status, snapshot.statusTone);
      renderSettingsOverview();
      delete globalThis.__settingsCaptureSnapshot;
      return true;
    })()`);
  }
}

async function runLocalHarnessBridgeScenario({ cdp, companion, firstTargetId, panelSessionId }) {
  const automationValue = `local-harness-${randomUUID().slice(0, 8)}`;
  const mcpServerName = "my_assistant_web";
  const mcpConfigPath = path.join(temporaryRoot, "local-harness-mcp.json");
  const mcpConfig = {
    mcpServers: {
      [mcpServerName]: {
        type: "http",
        url: companion.endpoints.mcp,
        headers: {
          Authorization: `Bearer ${companion.mcpToken}`,
        },
      },
    },
  };
  await writeFile(mcpConfigPath, `${JSON.stringify(mcpConfig, null, 2)}\n`, { mode: 0o600 });
  await chmod(mcpConfigPath, 0o600);

  const toolPrefix = `mcp__${mcpServerName}__`;
  const allowedTools = [
    "browser_begin",
    "browser_act",
    "browser_continue",
    "browser_end",
  ].map((name) => `${toolPrefix}${name}`);
  const prompt = [
    "사용자는 MCP 도구를 지원하는 로컬 CLI 채팅만 사용하고 있습니다.",
    "my_assistant_web MCP 도구로 공유된 탭의 현재 보이는 화면만 관찰한 뒤 Name 입력란에 아래 테스트 값을 입력하세요.",
    `테스트 값: ${automationValue}`,
    "browser_begin으로 시작하고, 반환된 page에서 받은 최신 ref만 browser_act에 사용하세요.",
    "상태 변경 작업이 approval_required이면 새 작업을 만들지 말고 browser_continue로 기존 작업을 이어가세요.",
    "완료 뒤 browser_continue의 새 page로 결과를 확인하고 browser_end로 작업을 닫으세요.",
    "모든 단계가 끝나기 전에는 진행 설명만 출력해서 턴을 끝내지 말고, 필요한 다음 MCP 도구 호출을 계속 반환하세요.",
    "최종 답변에는 실제 관찰에서 보였던 제목과 상태, 입력한 테스트 값만 간단히 적고 관찰되지 않은 페이지 내용은 추측하지 마세요.",
  ].join("\n");
  const continuationSystemPrompt = [
    "For an explicit tool-driven task, an intermediate text-only answer ends the CLI run and is therefore a failure.",
    "While the objective is incomplete and a next tool call is possible, emit the next valid tool_use without progress narration.",
    "After every tool result, follow its next instruction and continue autonomously.",
    "The guided browser tools manage transaction identifiers internally; never invent or request them.",
    "Return user-facing text only after the objective is verified and browser_end has released the task.",
  ].join(" ");
  const harnessCommand = String(process.env.LOCAL_HARNESS_BIN || "").trim();
  assert.ok(
    harnessCommand,
    "LOCAL_HARNESS_BIN must point to a compatible local CLI when --local-harness is enabled.",
  );
  const harnessProcess = spawn(harnessCommand, [
    "--bare",
    "--no-chrome",
    "--tools",
    "",
    "--allowedTools",
    ...allowedTools,
    "--permission-mode",
    "dontAsk",
    "--append-system-prompt",
    continuationSystemPrompt,
    "--mcp-config",
    mcpConfigPath,
    "--strict-mcp-config",
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
    "--print",
    prompt,
  ], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const harnessResultPromise = collectProcessResult(harnessProcess, 180_000);

  let pendingOperation;
  try {
    pendingOperation = await Promise.race([
      poll(
        async () => extensionMessage(cdp, panelSessionId, { type: "LIST_EXTERNAL_APPROVALS" }),
        (response) => response?.ok && response.data.operations.some(
          (operation) => operation.status === "waiting_approval",
        ),
        120_000,
      ).then((response) => response.data.operations.find(
        (operation) => operation.status === "waiting_approval",
      )),
      harnessResultPromise.then((result) => {
        throw new Error(
          `The local CLI harness exited before requesting extension approval.\n${summarizeHarnessFailure(result)}`,
        );
      }),
    ]);
  } catch (error) {
    harnessProcess.kill("SIGTERM");
    throw error;
  }

  const approvedOperation = await extensionMessage(cdp, panelSessionId, {
    type: "APPROVE_EXTERNAL_OPERATION",
    operationId: pendingOperation.operation_id,
  });
  assert.equal(approvedOperation.ok, true);
  assert.equal(approvedOperation.data.operation.status, "completed");

  const harnessResult = await harnessResultPromise;
  assert.equal(harnessResult.code, 0, summarizeHarnessFailure(harnessResult));
  const events = parseNdjson(harnessResult.stdout);
  const initialization = events.find((event) => event.type === "system" && event.subtype === "init");
  assert.equal(initialization?.model, "default");
  assert.equal(initialization?.apiKeySource, "apiKeyHelper");
  assert.equal(
    initialization?.mcp_servers?.some(
      (server) => server.name === mcpServerName && server.status === "connected",
    ),
    true,
    `The local CLI harness did not connect the MCP server: ${JSON.stringify(initialization?.mcp_servers || [])}`,
  );

  const toolUses = events.flatMap((event) => (
    event.type === "assistant" && Array.isArray(event.message?.content)
      ? event.message.content.filter((item) => item.type === "tool_use")
      : []
  ));
  const calledTools = new Set(toolUses.map((toolUse) => toolUse.name));
  const harnessTraceSummary = [
    `called tools: ${Array.from(calledTools).join(", ")}`,
    `final result: ${events.findLast((event) => event.type === "result")?.result || ""}`,
  ].join("\n");
  for (const toolName of allowedTools) {
    assert.equal(
      calledTools.has(toolName),
      true,
      `The local CLI harness did not call ${toolName}.\n${harnessTraceSummary}`,
    );
  }
  const snapshotToolIds = new Set(
    toolUses
      .filter((toolUse) => [
        `${toolPrefix}browser_begin`,
        `${toolPrefix}browser_continue`,
      ].includes(toolUse.name))
      .map((toolUse) => toolUse.id),
  );
  const snapshotResults = events
    .filter((event) => (
      event.type === "user"
      && event.message?.content?.some(
        (item) => item.type === "tool_result" && snapshotToolIds.has(item.tool_use_id),
      )
    ))
    .map((event) => event.tool_use_result?.structuredContent)
    .filter((result) => result?.page);
  assert.ok(snapshotResults.length, "The local CLI harness did not receive a guided browser page snapshot.");
  for (const snapshot of snapshotResults) {
    assert.equal(
      Object.hasOwn(snapshot.page || {}, "browser"),
      false,
      "External browser observations must not expose unrelated tab inventory or browser IDs.",
    );
  }
  assert.equal(
    events
      .filter((event) => event.type === "assistant")
      .every((event) => event.message?.model === "default"),
    true,
    "Every local CLI assistant turn must be served by the vLLM model alias 'default'.",
  );

  const finalResult = events.findLast((event) => event.type === "result");
  assert.equal(finalResult?.subtype, "success");
  assert.match(finalResult?.result || "", new RegExp(automationValue));
  assert.doesNotMatch(finalResult?.result || "", /Hidden DOM fact|Offscreen viewport fact/);
  assert.equal(await readInputValue(cdp, firstTargetId), automationValue);

  process.stdout.write(
    `Local CLI + vLLM Bridge E2E passed: model=default, MCP tools=${calledTools.size}, value=${automationValue}.\n`,
  );
}

function collectProcessResult(child, timeoutMs) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Local CLI integration timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function parseNdjson(output) {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function summarizeHarnessFailure(result) {
  const stdoutTail = result.stdout.slice(-4_000);
  const stderrTail = result.stderr.slice(-4_000);
  return [
    `exit=${result.code ?? "unknown"} signal=${result.signal || "none"}`,
    stdoutTail && `stdout:\n${stdoutTail}`,
    stderrTail && `stderr:\n${stderrTail}`,
  ].filter(Boolean).join("\n");
}

async function navigateTarget(cdp, targetId, url) {
  const sessionId = await attach(cdp, targetId);
  await cdp.send("Page.navigate", { url }, sessionId);
  await waitForReady(cdp, sessionId);
}

async function evaluate(cdp, sessionId, expression) {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  }, sessionId);
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  }
  return response.result.value;
}

async function poll(operation, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (predicate(result)) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error(`Timed out after ${timeoutMs}ms.`);
}

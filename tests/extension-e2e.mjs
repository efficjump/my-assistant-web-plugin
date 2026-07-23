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
    assert.equal(verificationContracts.completionVerifierSawTurnIntent, true);
    assert.equal(verificationContracts.groundingVerifierSawTurnIntent, true);
    assert.equal(verificationContracts.promiseReplanOccurred, true);
    assert.equal(verificationContracts.promiseCompletionVerifierCalls, 2);
    assert.equal(verificationContracts.promiseFinalStatus, "completed");
    assert.match(verificationContracts.promiseFinalMessage, /다음과 같습니다/);
    assert.equal(verificationContracts.timelinePreservedEarlierAction, true);
    assert.equal(verificationContracts.successPayloadHiddenFromChat, true);
    assert.ok(
      verificationContracts.purposes.findIndex((purpose) => purpose === "answer-grounding-repair")
        < verificationContracts.purposes.findIndex((purpose) => purpose.startsWith("verifier-"))
    );
    assert.equal(verificationContracts.allVisualVerificationCallsReceivedScreenshot, true);
    assert.equal(verificationContracts.previousViewportEvidenceStatus, "rejected");
    assert.equal(verificationContracts.currentViewportEvidenceStatus, "verified");
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
    assert.equal(internalDiscovery.userHandoffSuppressed, true);

    const turnBoundaryContracts = await exerciseTurnBoundaryContracts({
      cdp,
      panelSessionId,
      tabId: firstTabId,
      context: firstContext.data
    });
    assert.equal(turnBoundaryContracts.intentMode, "standalone");
    assert.equal(turnBoundaryContracts.intentRepeatPolicy, "once");
    assert.equal(turnBoundaryContracts.standaloneObjectiveStayedExact, true);
    assert.equal(turnBoundaryContracts.resolverSawFailedPriorRun, true);
    assert.equal(turnBoundaryContracts.plannerExcludedRawConversation, true);
    assert.equal(turnBoundaryContracts.malformedRawHidden, true);
    assert.equal(turnBoundaryContracts.internalJsonRejected, true);
    assert.equal(turnBoundaryContracts.staleElementSearchCleared, true);
    assert.equal(turnBoundaryContracts.repeatBlockedAfterOneSuccess, true);
    assert.equal(turnBoundaryContracts.stateChangingToolRepeatBlocked, true);
    assert.equal(turnBoundaryContracts.readOnlyToolRepeatAllowed, true);
    assert.equal(turnBoundaryContracts.runtimeErrorStoppedSession, true);
    assert.equal(turnBoundaryContracts.runtimeErrorJsonHidden, true);

    const transitionContracts = await exerciseTabTransitionContracts({ cdp, panelSessionId });
    assert.equal(transitionContracts.preservedRunningSession, true);
    assert.equal(transitionContracts.deferredWhileBound, true);
    assert.equal(transitionContracts.resumedOnLatestTab, true);

    const pointerTarget = firstContext.data.interactiveElements.find((element) => element.label === "Pointer action");
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
    assert.ok(
      queriedElements.data.elementDiscovery.availableTotal > queriedElements.data.elementDiscovery.total
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
        { id: "fill-cross-frame", type: "fill", ref: crossFrameInput.ref, value: "cross-bound", reason: "cross-origin frame E2E" },
        { id: "click-cross-frame", type: "click", ref: crossFrameAction.ref, reason: "cross-origin action E2E" }
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
            reason: "공유된 테스트 페이지의 비민감성 입력란을 변경합니다."
          })),
          policy: {
            ...(operation.policy || {}),
            message: "확장 프로그램의 정책 검증 결과, 공유된 페이지의 상태 변경에 명시적인 승인이 필요합니다."
          }
        }));
        renderExternalApprovalPanel();
        closeSettings();
        hideRestrictedPage();
        elements.statusLine.textContent = "Bridge · 테스트 탭 공유 중";
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
      if (instructions.includes("immutable repetition boundary")) {
        visualAiCallCounts.intent += 1;
        payload = {
          version: "1.0",
          mode: "standalone",
          objective: "Click the visible Apply target once.",
          contextSummary: "",
          repeatPolicy: "once",
          repeatLimit: 1,
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
      #hidden-cross-frame { display: none; }
      #covered-frame-shell { position: fixed; left: 300px; bottom: 8px; z-index: 3; width: 180px; height: 70px; }
      #covered-frame-shell iframe { position: absolute; inset: 0; margin: 0; }
      #covered-frame-overlay { position: absolute; inset: 0 auto 0 0; z-index: 1; width: 70px; background: white; }
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
        utilityMenuOpen: elements.utilityMenu.open,
        templatePopoverOpen: elements.templatePopover.open
      };
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

        return { template, site };
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
        state.externalApprovals = original.externalApprovals;
        state.selectedExternalOperationId = original.selectedExternalOperationId;
        elements.messageList.replaceChildren();
        for (const message of state.conversation) {
          appendChatMessage(message.role, message.text, { tone: message.tone || "", record: false });
        }
        elements.chatInput.value = "";
        renderTemplateSelect();
        hideApprovalPanel();
        renderExternalApprovalPanel();
        updatePickedElementBadge();
        updateAgentButtons();
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
      state.agentRunUi = null;
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
      collectDecisionObservation = async (discovery = {}) => {
        requestedCursors.push(discovery.elementCursor || "");
        requestedSearches.push(discovery.elementQuery || "");
        const observed = discovery.elementQuery ? secondContext : firstContext;
        state.lastContext = observed;
        return { context: observed, screenshotDataUrl: "" };
      };
      loadMcpToolContext = async () => ({ enabled: false, tools: [], error: "" });
      loadMcpAssetContext = async () => ({ enabled: false, resources: [], prompts: [], error: "" });
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
      return {
        decisionStatus: decision.status,
        actionRef: decision.actions[0]?.ref || "",
        requestedCursors,
        requestedSearches,
        boundObservationSearch: {
          query: decision.observationRequest?.elementQuery || "",
          roles: decision.observationRequest?.elementRoles || [],
          nearText: decision.observationRequest?.elementNearText || ""
        },
        modelCalls,
        userHandoffSuppressed: !state.conversation.some(
          (message) => message.role === "assistant" && /직접|수동/.test(message.text || "")
        )
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
      state.agentRunUi = originalState.agentRunUi;
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
      state.agentRunUi = null;
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
      recordSuccessfulEffects(session, firstAction, [], [{
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
      recordSuccessfulEffects(session, writeToolDecision, [{ ok: true }], []);
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
      recordSuccessfulEffects(session, readToolDecision, [{ ok: true }], []);
      const repeatedReadToolDecision = structuredClone(readToolDecision);
      enforceTurnEffectBoundary(session, repeatedReadToolDecision, currentContext);

      await runBusy(async () => {
        throw new Error(JSON.stringify({
          error: { message: "Provider request failed without exposing its JSON envelope." }
        }));
      });
      const lastConversation = state.conversation.at(-1);

      return {
        intentMode: intent.mode,
        intentRepeatPolicy: intent.repeatPolicy,
        standaloneObjectiveStayedExact: intent.objective
          === "현재 페이지에서 다음 페이지로 한 번 이동해줘.",
        resolverSawFailedPriorRun: intentRequest?.system.includes("earlier error")
          && intentRequest?.user.includes('"taskStatus": "failed"'),
        plannerExcludedRawConversation: plannerPrompt.includes("Resolved turn intent JSON")
          && !plannerPrompt.includes("다음 페이지로 넘겨서 내용을 확인해줘."),
        malformedRawHidden: !malformedText.includes('{"status"')
          && malformedValidation.valid === false,
        internalJsonRejected: internalJsonValidation.valid === false,
        staleElementSearchCleared: firstValidation.valid === true
          && firstAction.elementSearch.query === "",
        repeatBlockedAfterOneSuccess: repeatedAction.status === "blocked"
          && repeatedAction.actions.length === 0,
        stateChangingToolRepeatBlocked: repeatedWriteToolDecision.status === "blocked"
          && repeatedWriteToolDecision.toolCalls.length === 0,
        readOnlyToolRepeatAllowed: repeatedReadToolDecision.status === "continue"
          && repeatedReadToolDecision.toolCalls.length === 1,
        runtimeErrorStoppedSession: session.status === "failed" && session.stopRequested === true,
        runtimeErrorJsonHidden: lastConversation?.kind === "run-error"
          && !lastConversation.text.includes("{")
          && lastConversation.text.includes("Provider request failed")
      };
    } finally {
      requestAiDecision = original.requestAiDecision;
      state.settings = original.settings;
      state.runtimeSettings = original.runtimeSettings;
      state.activeTab = original.activeTab;
      state.lastContext = original.lastContext;
      state.agentSession = original.agentSession;
      state.agentRunUi = original.agentRunUi;
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
            completionEvidence: [activeSession.currentPageEvidenceId],
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
        completionVerifierSawTurnIntent,
        groundingVerifierSawTurnIntent,
        promiseReplanOccurred: promisePurposes.includes("verification-replan"),
        promiseCompletionVerifierCalls: completionVerifierCalls,
        promiseFinalMessage: promiseRepairedDecision.message,
        promiseFinalStatus: promiseRepairedDecision.status,
        timelinePreservedEarlierAction,
        successPayloadHiddenFromChat,
        purposes,
        allVisualVerificationCallsReceivedScreenshot: screenshotChecks.length >= 4 && screenshotChecks.every(Boolean),
        previousViewportEvidenceStatus: previousViewportEvidence.status,
        currentViewportEvidenceStatus: currentViewportEvidence.status,
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
      state.agentRunUi = original.agentRunUi;
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
    elements.contextStatus.textContent = "실제 브라우저 검증 컨텍스트";
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
      title: "배포 전 점검",
      prompt: "현재 화면에서 배포 전 확인할 항목과 위험을 정리해줘."
    }];
    elements.chatInput.value = "";
    elements.statusLine.textContent = "선택한 템플릿 편집 중";
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
      { role: "user", text: "현재 화면에서 확인해야 할 항목을 정리해줘." },
      { role: "assistant", text: "현재 화면의 보이는 내용과 조작 가능한 요소를 기준으로 확인할 준비가 되었습니다." }
    ];
    elements.messageList.replaceChildren();
    for (const message of state.conversation) {
      appendChatMessage(message.role, message.text, { record: false });
    }
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
    setStatusLine("요청을 기다리는 중");
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
    openSettings();
    activateSettingsTab("general");
    setSettingsStatus("모든 변경 내용이 저장되었습니다.");
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

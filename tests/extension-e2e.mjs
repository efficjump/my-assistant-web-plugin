import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, readdir, rm, writeFile, cp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    const input = firstContext.data.interactiveElements.find((element) => element.label === "Name");
    assert.ok(input?.ref, "the real content script should expose a runtime element ref");
    const privateInput = firstContext.data.interactiveElements.find((element) => element.label === "Email");
    assert.equal(privateInput?.value, "[redacted]");
    const shadowInput = firstContext.data.interactiveElements.find((element) => element.label === "Shadow Name");
    const frameInput = firstContext.data.interactiveElements.find((element) => element.label === "Frame Name");
    const uploadInput = firstContext.data.interactiveElements.find((element) => element.label === "Upload document");
    assert.match(shadowInput?.scope || "", /shadow/);
    assert.match(frameInput?.scope || "", /frame/);
    assert.ok(uploadInput?.ref);

    const deepActionResult = await extensionMessage(cdp, panelSessionId, {
      type: "EXECUTE_PAGE_ACTIONS",
      targetTabId: firstTabId,
      actions: [
        { id: "fill-shadow", type: "fill", ref: shadowInput.ref, value: "shadow-value", reason: "Shadow DOM E2E" },
        { id: "fill-frame", type: "fill", ref: frameInput.ref, value: "frame-value", reason: "iframe E2E" }
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
        ref: uploadInput.ref,
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
      actions: [{ id: "fill-first", type: "fill", ref: input.ref, value: "bound-tab", reason: "E2E tab binding" }]
    });
    assert.equal(actionResult.ok, true);
    assert.equal(actionResult.data.results[0].ok, true);

    const secondTargetId = await createPage(cdp, `${origin}/page-b`);
    await cdp.send("Target.activateTarget", { targetId: secondTargetId });
    const secondTabId = await queryTabId(cdp, panelSessionId, `${origin}/page-b`);
    assert.notEqual(firstTabId, secondTabId);

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

    process.stdout.write("Real Chrome extension E2E passed: AI audits, empty-response guard, deep DOM, wait, files, tabs, identity, and worker restart.\n");
  } finally {
    cdp.close();
  }
} finally {
  if (browserProcess && browserProcess.exitCode === null) {
    browserProcess.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => browserProcess.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000))
    ]);
  }
  await new Promise((resolve) => server?.close(resolve) || resolve());
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
  manifest.host_permissions = ["http://127.0.0.1/*"];
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
  server = createServer((request, response) => {
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
    response.end(`<!doctype html><html><head><title>${second ? "Second" : "First"} tab</title></head><body>
      <h1>${second ? "Second" : "First"} page</h1>
      <label for="name">Name</label>
      <input id="name" value="${second ? "second-tab" : "first-tab"}">
      <label for="email">Email</label>
      <input id="email" type="email" value="private@example.com">
      <button id="save" type="button">Save</button>
      <div role="status">Ready</div>
      <div id="shadow-host"></div>
      <iframe title="Same-origin frame" src="/frame"></iframe>
      <label for="upload">Upload document</label>
      <input id="upload" type="file" accept="text/plain">
      <button id="async" type="button">Start async</button>
      <div id="async-status" role="status">Idle</div>
      <script>
        const root = document.querySelector('#shadow-host').attachShadow({mode:'open'});
        root.innerHTML = '<label for="shadow-name">Shadow Name</label><input id="shadow-name">';
        document.querySelector('#async').addEventListener('click', () => {
          setTimeout(() => { document.querySelector('#async-status').textContent = 'Async complete'; }, 180);
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

async function extensionMessage(cdp, sessionId, message) {
  return evaluate(cdp, sessionId, `chrome.runtime.sendMessage(${JSON.stringify(message)})`);
}

async function readInputValue(cdp, targetId) {
  const sessionId = await attach(cdp, targetId);
  return evaluate(cdp, sessionId, "document.querySelector('#name')?.value || ''");
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

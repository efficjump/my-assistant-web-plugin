import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  access,
  chmod,
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${message.error.message}: ${message.error.data || ""}`));
      } else {
        pending.resolve(message.result || {});
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
const requestedUrl = parseRequestedUrl(process.argv[2]);
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "my-assistant-live-bridge-"));
const extensionRoot = path.join(temporaryRoot, "extension");
const profileRoot = path.join(temporaryRoot, "profile");
const companionStatePath = path.join(temporaryRoot, "companion", "state.json");
const clientConfigPath = path.join(temporaryRoot, "mcp-client.json");
const silentLogger = Object.freeze({
  debug() {},
  error() {},
  info() {},
  log() {},
  warn() {},
});

let browserProcess;
let companion;
let cdp;

try {
  const chromePath = await resolveChromePath();
  const extensionId = await prepareTestExtension();
  companion = await createCompanionServer({
    port: 0,
    statePath: companionStatePath,
    logger: silentLogger,
    authenticationTimeoutMs: 15_000,
    toolCallTimeoutMs: 30_000,
  });

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
    "about:blank",
  ], { stdio: "ignore" });

  const debugPort = await readDebugPort(profileRoot);
  const version = await waitForJson(`http://127.0.0.1:${debugPort}/json/version`);
  cdp = await CdpClient.connect(version.webSocketDebuggerUrl);

  const targetId = await createPage(cdp, requestedUrl.href);
  const panelTargetId = await createPage(cdp, `chrome-extension://${extensionId}/panel.html`);
  const panelSessionId = await attach(cdp, panelTargetId);
  await waitForReady(cdp, panelSessionId);
  await waitForTarget(cdp, (target) => (
    target.type === "service_worker"
      && target.url === `chrome-extension://${extensionId}/background.js`
  ));
  const tabId = await queryTabId(cdp, panelSessionId, requestedUrl.href);
  if (!tabId) {
    throw new Error(`Unable to find the live test tab for ${requestedUrl.href}`);
  }
  const targetSessionId = await attach(cdp, targetId);
  const targetSummary = await evaluate(cdp, targetSessionId, `({
    title: document.title,
    url: location.href
  })`);

  await evaluate(cdp, panelSessionId, `(async () => {
    await loadSettings();
    state.settings = {
      ...state.settings,
      bridgeEnabled: false,
      bridgeEndpoint: "",
      bridgeRequireApproval: false,
      policyGuardEnabled: false,
      includeScreenshot: false
    };
    state.runtimeSettings = { ...state.settings };
    applySettingsToForm();
    applyActiveTabSummary({
      id: ${JSON.stringify(tabId)},
      title: ${JSON.stringify(targetSummary.title || "Live test page")},
      url: ${JSON.stringify(targetSummary.url || requestedUrl.href)}
    });
    elements.inputs.bridgeEndpoint.value = ${JSON.stringify(companion.extensionSetup)};
    openSettings();
    activateSettingsTab("bridge");
    renderBridgeStatus();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    elements.bridgeConnectButton.click();
    return true;
  })()`);

  await poll(
    async () => extensionMessage(cdp, panelSessionId, { type: "GET_BRIDGE_STATUS" }),
    (response) => response?.ok
      && response.data.connected
      && response.data.runtime.armed
      && response.data.runtime.sharedTab?.tabId === tabId
      && companion.extensionConnected,
    20_000,
  );
  await evaluate(cdp, panelSessionId, `(async () => {
    const tab = await chrome.tabs.update(${JSON.stringify(tabId)}, { active: true });
    return Boolean(tab?.active);
  })()`);

  const clientConfig = {
    type: "http",
    url: companion.endpoints.mcp,
    headers: {
      Authorization: `Bearer ${companion.mcpToken}`,
    },
  };
  await writeFile(clientConfigPath, `${JSON.stringify(clientConfig, null, 2)}\n`, { mode: 0o600 });
  await chmod(clientConfigPath, 0o600);

  process.stdout.write(`${JSON.stringify({
    event: "live_bridge_ready",
    configPath: clientConfigPath,
    page: targetSummary,
    approvalMode: "deterministic_consequential_actions_only",
  })}\n`);
  process.stdout.write("Commands: `status`, `approve`, `reject`, or `quit`. Review the MCP proposal before approving it.\n");
  await waitForControlInput((command) => handleControlCommand(cdp, panelSessionId, command));
} finally {
  cdp?.close();
  await terminateBrowser(browserProcess);
  await closeCompanion(companion);
  await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function terminateBrowser(child) {
  if (!child || child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}

async function closeCompanion(instance) {
  if (!instance) {
    return;
  }
  await Promise.race([
    instance.close().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  for (const client of instance.webSocketServer?.clients || []) {
    client.terminate();
  }
  instance.httpServer?.closeAllConnections?.();
  instance.httpServer?.closeIdleConnections?.();
  instance.webSocketServer?.close();
  instance.httpServer?.close();
}

function parseRequestedUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error("Pass one complete public http(s) URL to the live Bridge host.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("The live Bridge host accepts only http(s) URLs.");
  }
  return parsed;
}

async function prepareTestExtension() {
  await cp(root, extensionRoot, {
    recursive: true,
    filter(source) {
      const relative = path.relative(root, source);
      return !relative.startsWith(".git")
        && !relative.startsWith("node_modules")
        && !relative.startsWith(".idea");
    },
  });
  const manifestPath = path.join(extensionRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  manifest.key = publicKeyDer.toString("base64");
  manifest.host_permissions = [`${requestedUrl.origin}/*`];
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
    "/usr/bin/google-chrome-for-testing",
  ].filter(Boolean);
  const playwrightCache = path.join(homedir(), "Library", "Caches", "ms-playwright");
  const installs = await readdir(playwrightCache, { withFileTypes: true }).catch(() => []);
  for (const install of installs.filter((entry) => (
    entry.isDirectory() && entry.name.startsWith("chromium-")
  ))) {
    candidates.unshift(path.join(
      playwrightCache,
      install.name,
      "chrome-mac-arm64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing",
    ));
  }
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true).catch(() => false)) {
      return candidate;
    }
  }
  throw new Error("Chrome for Testing or Chromium is required. Set CHROME_PATH explicitly.");
}

async function readDebugPort(profile) {
  const file = path.join(profile, "DevToolsActivePort");
  const text = await poll(async () => readFile(file, "utf8").catch(() => ""), Boolean, 20_000);
  return Number(text.split(/\r?\n/)[0]);
}

async function waitForJson(url) {
  return poll(async () => {
    const response = await fetch(url).catch(() => null);
    return response?.ok ? response.json() : null;
  }, Boolean, 10_000);
}

async function waitForTarget(client, predicate) {
  return poll(async () => {
    const { targetInfos } = await client.send("Target.getTargets");
    return targetInfos.find(predicate) || null;
  }, Boolean, 20_000);
}

async function createPage(client, url) {
  const { targetId } = await client.send("Target.createTarget", { url });
  const sessionId = await attach(client, targetId);
  await waitForReady(client, sessionId);
  return targetId;
}

async function attach(client, targetId) {
  const { sessionId } = await client.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await client.send("Runtime.enable", {}, sessionId);
  await client.send("Page.enable", {}, sessionId).catch(() => {});
  return sessionId;
}

async function waitForReady(client, sessionId) {
  await poll(async () => {
    const readyState = await evaluate(client, sessionId, "document.readyState").catch(() => "");
    return readyState === "complete" ? readyState : "";
  }, Boolean, 20_000);
}

async function queryTabId(client, sessionId, url) {
  return evaluate(client, sessionId, `(async () => {
    const tabs = await chrome.tabs.query({});
    const exact = tabs.find((tab) => String(tab.url || "") === ${JSON.stringify(url)});
    const sameOrigin = tabs.find((tab) => {
      try {
        return new URL(String(tab.url || "")).origin === new URL(${JSON.stringify(url)}).origin;
      } catch {
        return false;
      }
    });
    return exact?.id || sameOrigin?.id || 0;
  })()`);
}

async function extensionMessage(client, sessionId, message) {
  return evaluate(client, sessionId, `chrome.runtime.sendMessage(${JSON.stringify(message)})`);
}

async function evaluate(client, sessionId, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description || response.exceptionDetails.text,
    );
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

async function handleControlCommand(client, panelSessionId, command) {
  if (!["status", "approve", "reject"].includes(command)) {
    process.stdout.write(`${JSON.stringify({ event: "unknown_command", command })}\n`);
    return;
  }
  const response = await extensionMessage(client, panelSessionId, {
    type: "LIST_EXTERNAL_APPROVALS",
  });
  const pending = (response?.data?.operations || []).find(
    (operation) => operation.status === "waiting_approval",
  );
  if (!pending) {
    process.stdout.write(`${JSON.stringify({ event: "no_pending_approval" })}\n`);
    return;
  }
  const summary = {
    operationId: pending.operation_id,
    actions: (pending.actions || []).map((action) => ({
      id: action.id || "",
      type: action.type || "",
      reason: action.reason || "",
    })),
    targets: (pending.targets || []).map((entry) => ({
      actionId: entry.actionId || "",
      label: entry.target?.label || "",
      role: entry.target?.role || "",
      href: entry.target?.href || "",
    })),
  };
  if (command === "status") {
    process.stdout.write(`${JSON.stringify({ event: "pending_approval", ...summary })}\n`);
    return;
  }
  const result = await extensionMessage(client, panelSessionId, {
    type: command === "approve" ? "APPROVE_EXTERNAL_OPERATION" : "REJECT_EXTERNAL_OPERATION",
    operationId: pending.operation_id,
  });
  process.stdout.write(`${JSON.stringify({
    event: command === "approve" ? "approval_completed" : "approval_rejected",
    ...summary,
    status: result?.data?.operation?.status || "",
    error: result?.data?.operation?.error || result?.error || "",
  })}\n`);
}

function waitForControlInput(onCommand) {
  return new Promise((resolve) => {
    let finished = false;
    let buffered = "";
    let commandQueue = Promise.resolve();
    const onData = (chunk) => {
      buffered += String(chunk);
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() || "";
      for (const line of lines) {
        const command = line.trim().toLowerCase();
        if (!command) {
          continue;
        }
        if (command === "quit") {
          finish();
          return;
        }
        commandQueue = commandQueue
          .then(() => onCommand(command))
          .catch((error) => {
            process.stdout.write(`${JSON.stringify({
              event: "control_command_failed",
              command,
              error: error.message || String(error),
            })}\n`);
          });
      }
    };
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      process.stdin.off("end", finish);
      process.stdin.off("close", finish);
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    process.stdin.once("end", finish);
    process.stdin.once("close", finish);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

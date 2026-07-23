import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocket } from "ws";
import {
  createCompanionServer,
  createExtensionSetupValue,
  createStdioClientConfig,
} from "../bridge/server.mjs";

const EXTENSION_ORIGIN = "chrome-extension://test-extension";
const TEST_TIMEOUT_MS = 5_000;

const silentLogger = Object.freeze({
  debug() {},
  error() {},
  info() {},
  log() {},
  warn() {},
});

test("companion creates a single extension setup value and a dynamic stdio client entry", () => {
  const endpoint = "ws://127.0.0.1:45678/extension";
  const setup = new URL(createExtensionSetupValue(endpoint, "PAIR_CODE_123"));
  assert.equal(`${setup.protocol}//${setup.host}${setup.pathname}`, endpoint);
  assert.equal(new URLSearchParams(setup.hash.slice(1)).get("pair"), "PAIR_CODE_123");

  const config = createStdioClientConfig({
    command: path.resolve("runtime-node"),
    serverPath: path.resolve("bridge-entry.mjs"),
  });
  assert.deepEqual(config, {
    mcpServers: {
      "my-assistant-web": {
        command: path.resolve("runtime-node"),
        args: [path.resolve("bridge-entry.mjs"), "--stdio"],
      },
    },
  });
});

test("companion reuses its remembered loopback port when no port is configured", async (t) => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "my-assistant-bridge-port-test-"),
  );
  const statePath = path.join(temporaryDirectory, "companion-state.json");
  let first;
  let second;
  t.after(async () => {
    await Promise.allSettled([first?.close(), second?.close()]);
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  first = await createCompanionServer({ port: 0, statePath, logger: silentLogger });
  const rememberedPort = first.port;
  await first.close();
  first = null;

  second = await createCompanionServer({ statePath, logger: silentLogger });
  assert.equal(second.port, rememberedPort);
  assert.equal(new URL(second.extensionSetup).port, String(rememberedPort));
});

test("stdio mode exposes guided tools and reports one extension setup value", async (t) => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "my-assistant-bridge-stdio-test-"),
  );
  const statePath = path.join(temporaryDirectory, "companion-state.json");
  const serverPath = fileURLToPath(new URL("../bridge/server.mjs", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, "--stdio", "--port", "0", "--state", statePath],
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const client = new Client(
    { name: "bridge-stdio-integration-test", version: "1.0.0" },
    { capabilities: {} },
  );
  t.after(async () => {
    await client.close().catch(() => {});
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  await client.connect(transport);
  const listedTools = await client.listTools();
  assert.deepEqual(listedTools.tools.map((tool) => tool.name).sort(), [
    "browser_act",
    "browser_begin",
    "browser_continue",
    "browser_elements",
    "browser_end",
    "browser_screenshot",
    "browser_visual_act",
  ]);

  const advancedOnlyInput = await client.callTool({
    name: "browser_screenshot",
    arguments: { session_id: "session-not-exposed" },
  });
  assert.equal(advancedOnlyInput.isError, true);
  assert.match(advancedOnlyInput.content[0].text, /invalid browser_screenshot input/i);

  const result = await client.callTool({
    name: "browser_begin",
    arguments: { goal: "Inspect the shared test page" },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Extension setup: ws:\/\/127\.0\.0\.1:\d+\/extension#pair=/i);
  assert.match(stderr, /Browser bridge MCP is ready over stdio/i);
  assert.match(stderr, /Extension setup: ws:\/\/127\.0\.0\.1:\d+\/extension#pair=/i);
});

function createMessageMailbox(endpoint) {
  const socket = new WebSocket(endpoint, {
    headers: { Origin: EXTENSION_ORIGIN },
  });
  const messages = [];
  const waiters = [];

  socket.on("message", (data, isBinary) => {
    const waiter = waiters.shift();
    let message;
    try {
      assert.equal(isBinary, false, "companion messages must use text frames");
      message = JSON.parse(data.toString("utf8"));
    } catch (error) {
      waiter?.reject(error);
      return;
    }

    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      messages.push(message);
    }
  });

  socket.on("close", (code, reason) => {
    while (waiters.length) {
      const waiter = waiters.shift();
      clearTimeout(waiter.timer);
      waiter.reject(
        new Error(`WebSocket closed before a message arrived (${code}: ${reason.toString()})`),
      );
    }
  });

  return {
    socket,
    async opened() {
      if (socket.readyState === WebSocket.OPEN) {
        return;
      }
      await once(socket, "open");
    },
    nextMessage() {
      if (messages.length) {
        return Promise.resolve(messages.shift());
      }
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          reject(new Error(`Timed out waiting for a companion message after ${TEST_TIMEOUT_MS} ms`));
        }, TEST_TIMEOUT_MS);
        waiters.push(waiter);
      });
    },
    expectNoMessage(durationMs = 150) {
      if (messages.length) {
        return Promise.reject(
          new Error(`Unexpected companion message: ${JSON.stringify(messages.shift())}`),
        );
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          reject,
          resolve(message) {
            reject(new Error(`Unexpected companion message: ${JSON.stringify(message)}`));
          },
          timer: null,
        };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          resolve();
        }, durationMs);
        waiters.push(waiter);
      });
    },
  };
}

async function closeSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  if (socket.readyState === WebSocket.CONNECTING) {
    socket.terminate();
    return;
  }
  const closed = once(socket, "close");
  socket.close(1000, "test cleanup");
  await closed;
}

async function waitFor(predicate, message, timeoutMs = TEST_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test("companion pairs the extension and relays authenticated MCP tool calls", async (t) => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "my-assistant-bridge-companion-test-"),
  );
  const statePath = path.join(temporaryDirectory, "companion-state.json");
  const sockets = new Set();
  let companion;
  let client;

  t.after(async () => {
    await client?.close().catch(() => {});
    await Promise.allSettled(Array.from(sockets, closeSocket));
    await companion?.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  companion = await createCompanionServer({
    port: 0,
    statePath,
    logger: silentLogger,
    authenticationTimeoutMs: TEST_TIMEOUT_MS,
    toolCallTimeoutMs: TEST_TIMEOUT_MS,
  });

  assert.notEqual(companion.port, 0, "port 0 must resolve to an ephemeral listening port");
  assert.ok(companion.pairingCode, "a fresh companion must expose a pairing code");
  const extensionSetup = new URL(companion.extensionSetup);
  assert.equal(`${extensionSetup.protocol}//${extensionSetup.host}${extensionSetup.pathname}`, companion.endpoints.extension);
  assert.equal(new URLSearchParams(extensionSetup.hash.slice(1)).get("pair"), companion.pairingCode);
  assert.doesNotMatch(companion.extensionSetup, new RegExp(companion.mcpToken));

  const unauthorizedResponse = await fetch(companion.endpoints.mcp, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer invalid-test-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  assert.equal(unauthorizedResponse.status, 401);
  assert.match(unauthorizedResponse.headers.get("www-authenticate") || "", /^Bearer\b/u);

  const pairingConnection = createMessageMailbox(companion.endpoints.extension);
  sockets.add(pairingConnection.socket);
  await pairingConnection.opened();
  const pairingHello = await pairingConnection.nextMessage();
  assert.equal(pairingHello.type, "hello");
  assert.equal(pairingHello.protocolVersion, companion.protocolVersion);

  pairingConnection.socket.send(
    JSON.stringify({
      type: "pair",
      code: companion.pairingCode,
      extension: {
        id: "test-extension",
        version: "1.0.0-test",
        protocolVersion: companion.protocolVersion,
      },
    }),
  );
  const paired = await pairingConnection.nextMessage();
  assert.equal(paired.type, "paired");
  assert.equal(paired.brokerId, companion.brokerId);
  assert.ok(paired.token, "pairing must return an extension credential");
  assert.equal(companion.pairingCode, null, "the one-time pairing code must be consumed");
  await closeSocket(pairingConnection.socket);

  const authenticatedConnection = createMessageMailbox(companion.endpoints.extension);
  sockets.add(authenticatedConnection.socket);
  await authenticatedConnection.opened();
  await authenticatedConnection.nextMessage();
  authenticatedConnection.socket.send(
    JSON.stringify({
      type: "authenticate",
      token: paired.token,
      extension: {
        id: "test-extension",
        version: "1.0.0-test",
        protocolVersion: companion.protocolVersion,
      },
    }),
  );
  const authenticated = await authenticatedConnection.nextMessage();
  assert.equal(authenticated.type, "authenticated");
  assert.equal(companion.extensionConnected, true);

  client = new Client(
    { name: "bridge-companion-integration-test", version: "1.0.0" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(new URL(companion.endpoints.mcp), {
    requestInit: {
      headers: { Authorization: `Bearer ${companion.mcpToken}` },
    },
  });
  await client.connect(transport);

  const listedTools = await client.listTools();
  assert.deepEqual(
    listedTools.tools.map(({ name }) => name),
    companion.tools.map(({ name }) => name),
  );
  assert.ok(listedTools.tools.some(({ name }) => name === "browser_begin"));

  const relayedRequestPromise = authenticatedConnection.nextMessage();
  const toolCallPromise = client.callTool({
    name: "browser_begin",
    arguments: { goal: "Inspect the shared integration page" },
  });
  const relayedRequest = await relayedRequestPromise;
  assert.equal(relayedRequest.type, "request");
  assert.equal(relayedRequest.toolName, "browser_begin");
  assert.deepEqual(relayedRequest.args, { goal: "Inspect the shared integration page" });
  assert.equal(typeof relayedRequest.client?.name, "string");
  assert.equal(typeof relayedRequest.client?.version, "string");

  const extensionResult = {
    connected: true,
    sharedTab: { attached: true, title: "Integration test tab" },
  };
  authenticatedConnection.socket.send(
    JSON.stringify({
      type: "response",
      id: relayedRequest.id,
      ok: true,
      result: extensionResult,
    }),
  );
  const toolResult = await toolCallPromise;
  assert.equal(toolResult.isError, undefined);
  assert.deepEqual(toolResult.structuredContent, extensionResult);
  assert.deepEqual(JSON.parse(toolResult.content[0].text), extensionResult);

  const forgedToolResult = await client.callTool({
    name: "browser_begin",
    arguments: { goal: "Inspect the page", approval: true },
  });
  assert.equal(forgedToolResult.isError, true);
  assert.match(forgedToolResult.content[0].text, /invalid browser_begin input/i);
  await authenticatedConnection.expectNoMessage();

  const revokedMessagePromise = authenticatedConnection.nextMessage();
  const revokedClosePromise = once(authenticatedConnection.socket, "close");
  authenticatedConnection.socket.send(JSON.stringify({ type: "revoke" }));
  assert.deepEqual(await revokedMessagePromise, { type: "revoked" });
  await revokedClosePromise;
  await waitFor(
    () => companion.extensionConnected === false,
    "the companion must observe the revoked extension disconnect",
  );

  const rejectedConnection = createMessageMailbox(companion.endpoints.extension);
  sockets.add(rejectedConnection.socket);
  await rejectedConnection.opened();
  await rejectedConnection.nextMessage();
  const rejectedClosePromise = once(rejectedConnection.socket, "close");
  rejectedConnection.socket.send(
    JSON.stringify({
      type: "authenticate",
      token: paired.token,
      extension: {
        id: "test-extension",
        version: "1.0.0-test",
        protocolVersion: companion.protocolVersion,
      },
    }),
  );
  const [closeCode] = await rejectedClosePromise;
  assert.equal(closeCode, 4003, "a revoked extension credential must not authenticate again");
});

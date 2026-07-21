import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocket } from "ws";
import { createCompanionServer } from "../bridge/server.mjs";

const EXTENSION_ORIGIN = "chrome-extension://test-extension";
const TEST_TIMEOUT_MS = 5_000;

const silentLogger = Object.freeze({
  debug() {},
  error() {},
  info() {},
  log() {},
  warn() {},
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
  assert.ok(listedTools.tools.some(({ name }) => name === "browser_status"));

  const relayedRequestPromise = authenticatedConnection.nextMessage();
  const toolCallPromise = client.callTool({ name: "browser_status", arguments: {} });
  const relayedRequest = await relayedRequestPromise;
  assert.equal(relayedRequest.type, "request");
  assert.equal(relayedRequest.toolName, "browser_status");
  assert.deepEqual(relayedRequest.args, {});
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
    name: "browser_status",
    arguments: { approval: true },
  });
  assert.equal(forgedToolResult.isError, true);
  assert.match(forgedToolResult.content[0].text, /invalid browser_status input/i);
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

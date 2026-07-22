#!/usr/bin/env node

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import process from "node:process";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocket, WebSocketServer } from "ws";
import {
  loadCompanionState,
  resolveStatePath,
  writeCompanionState,
} from "./state.mjs";

const require = createRequire(import.meta.url);
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SHARED_PROTOCOL_PATH = path.resolve(MODULE_DIRECTORY, "..", "bridge-protocol.js");
const SERVER_IMPLEMENTATION_NAME = "my-assistant-web-companion";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;
const DEFAULT_AUTHENTICATION_TIMEOUT_MS = 10 * 1000;
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 45 * 1000;
const DEFAULT_MAX_WEBSOCKET_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAX_PERSISTED_EXTENSION_CREDENTIALS = 16;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsePositiveInteger(value, label, { allowZero = false } = {}) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${label} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
  }
  return parsed;
}

function normalizeHostname(host) {
  if (typeof host !== "string" || !host.trim()) {
    throw new Error("Companion host must be a loopback hostname or address.");
  }
  const value = host.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1);
  }
  return value;
}

function isLoopbackHostname(host) {
  const hostname = normalizeHostname(host);
  if (hostname === "localhost" || hostname === "::1") {
    return true;
  }
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255) &&
    Number(octets[0]) === 127
  );
}

function isLoopbackRemoteAddress(address) {
  if (typeof address !== "string") {
    return false;
  }
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized === "::1") {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    return isLoopbackHostname(normalized.slice("::ffff:".length));
  }
  return isLoopbackHostname(normalized);
}

function formatUrlHost(host) {
  const normalized = normalizeHostname(host);
  return normalized.includes(":") ? `[${normalized}]` : normalized;
}

function parseRequestHost(hostHeader) {
  if (typeof hostHeader !== "string" || !hostHeader.trim()) {
    return null;
  }
  try {
    const url = new URL(`http://${hostHeader}`);
    return {
      hostname: normalizeHostname(url.hostname),
      port: url.port ? Number(url.port) : null,
    };
  } catch {
    return null;
  }
}

function secureEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function hashCredential(credential) {
  return createHash("sha256").update(credential, "utf8").digest("hex");
}

function generateCredential() {
  return randomBytes(32).toString("base64url");
}

function generatePairingCode() {
  return randomBytes(9).toString("base64url").toUpperCase();
}

export function createExtensionSetupValue(endpoint, pairingCode) {
  const url = new URL(endpoint);
  if (!["ws:", "wss:"].includes(url.protocol) || url.search || url.hash) {
    throw new Error("Extension setup requires a plain WebSocket endpoint.");
  }
  const code = typeof pairingCode === "string" ? pairingCode.trim() : "";
  if (code) {
    url.hash = new URLSearchParams({ pair: code }).toString();
  }
  return url.href;
}

export function createStdioClientConfig(options = {}) {
  const serverName = typeof options.serverName === "string" && options.serverName.trim()
    ? options.serverName.trim()
    : "my-assistant-web";
  const command = path.resolve(options.command || process.execPath);
  const serverPath = path.resolve(options.serverPath || fileURLToPath(import.meta.url));
  const args = [serverPath, "--stdio"];
  if (options.advancedTools) {
    args.push("--advanced-tools");
  }
  return {
    mcpServers: {
      [serverName]: {
        command,
        args,
      },
    },
  };
}

function normalizeOriginHeader(originHeader) {
  if (typeof originHeader !== "string" || !originHeader.trim()) {
    return null;
  }
  const trimmed = originHeader.trim();
  try {
    const url = new URL(trimmed);
    if (
      !["chrome-extension:", "moz-extension:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      (url.pathname && url.pathname !== "/") ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function loadSharedProtocol(protocolOverride, options = {}) {
  let protocol = protocolOverride;
  if (!protocol) {
    try {
      delete require.cache[require.resolve(SHARED_PROTOCOL_PATH)];
      protocol = require(SHARED_PROTOCOL_PATH);
    } catch (error) {
      throw new Error(
        `Unable to load the shared bridge protocol at ${SHARED_PROTOCOL_PATH}: ${error.message}`,
        { cause: error },
      );
    }
  }

  const definitions =
    typeof protocol.getToolDefinitions === "function"
      ? protocol.getToolDefinitions({ advanced: Boolean(options.advancedTools) })
      : protocol.MCP_TOOLS;
  if (!Array.isArray(definitions) || definitions.length === 0) {
    throw new Error("Shared bridge protocol did not provide any MCP tool definitions.");
  }
  if (typeof protocol.protocolVersion !== "string" || !protocol.protocolVersion.trim()) {
    throw new Error("Shared bridge protocol must provide a non-empty protocolVersion.");
  }
  if (typeof protocol.validateToolArguments !== "function") {
    throw new Error("Shared bridge protocol must provide validateToolArguments().");
  }

  const seenNames = new Set();
  const tools = definitions.map((definition) => {
    if (
      !isObject(definition) ||
      typeof definition.name !== "string" ||
      !definition.name.trim() ||
      !isObject(definition.inputSchema) ||
      definition.inputSchema.type !== "object"
    ) {
      throw new Error("Shared bridge protocol contains an invalid MCP tool definition.");
    }
    const name = definition.name.trim();
    if (seenNames.has(name)) {
      throw new Error(`Shared bridge protocol contains a duplicate tool: ${name}`);
    }
    seenNames.add(name);

    const tool = {
      name,
      inputSchema: structuredClone(definition.inputSchema),
    };
    for (const key of ["title", "description", "outputSchema", "annotations", "execution"]) {
      if (definition[key] !== undefined) {
        tool[key] = structuredClone(definition[key]);
      }
    }
    return tool;
  });

  return {
    tools,
    toolNames: seenNames,
    protocolVersion: protocol.protocolVersion.trim(),
    instructions: (
      typeof protocol.getInstructions === "function"
        ? protocol.getInstructions({ advanced: Boolean(options.advancedTools) })
        : protocol.instructions
    )?.trim?.() || "",
    validateToolArguments: (toolName, args) => protocol.validateToolArguments(toolName, args, {
      advanced: Boolean(options.advancedTools),
    }),
  };
}

function normalizeToolResult(result) {
  if (
    isObject(result) &&
    Array.isArray(result.content) &&
    result.content.every((item) => isObject(item) && typeof item.type === "string")
  ) {
    return result;
  }

  const text = JSON.stringify(result ?? null, null, 2);
  const response = {
    content: [{ type: "text", text }],
  };
  if (isObject(result)) {
    response.structuredContent = result;
  }
  return response;
}

function toolErrorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message || "The companion could not complete this tool call." }],
  };
}

function sendJson(socket, payload) {
  if (socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  socket.send(JSON.stringify(payload));
  return true;
}

function rejectUpgrade(socket, statusCode, message) {
  const body = `${message}\n`;
  socket.write(
    `HTTP/1.1 ${statusCode} ${message}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "\r\n" +
      body,
  );
  socket.destroy();
}

function parseBearerToken(authorization) {
  if (typeof authorization !== "string") {
    return null;
  }
  const match = authorization.match(/^Bearer[ \t]+([^ \t]+)[ \t]*$/iu);
  return match ? match[1] : null;
}

function listen(httpServer, port, host) {
  return new Promise((resolve, reject) => {
    const handleError = (error) => {
      httpServer.off("listening", handleListening);
      reject(error);
    };
    const handleListening = () => {
      httpServer.off("error", handleError);
      resolve();
    };
    httpServer.once("error", handleError);
    httpServer.once("listening", handleListening);
    httpServer.listen(port, host);
  });
}

function closeHttpServer(httpServer) {
  return new Promise((resolve, reject) => {
    if (!httpServer.listening) {
      resolve();
      return;
    }
    httpServer.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function closeWebSocketServer(webSocketServer) {
  return new Promise((resolve) => {
    webSocketServer.close(() => resolve());
  });
}

export async function createCompanionServer(options = {}) {
  const host = options.host || process.env.MY_ASSISTANT_BRIDGE_HOST || DEFAULT_HOST;
  if (!isLoopbackHostname(host)) {
    throw new Error(`Companion refuses to bind to a non-loopback host: ${host}`);
  }
  const normalizedHost = normalizeHostname(host);
  const { state, statePath } = await loadCompanionState(options);
  const configuredPort = options.port ?? process.env.MY_ASSISTANT_BRIDGE_PORT;
  const hasConfiguredPort = configuredPort !== undefined && String(configuredPort).trim() !== "";
  const requestedPort = parsePositiveInteger(
    hasConfiguredPort ? configuredPort : (state.preferredPort ?? 0),
    "Companion port",
    { allowZero: true },
  );
  if (requestedPort > 65535) {
    throw new Error("Companion port must be between 0 and 65535.");
  }
  const pairingTtlMs = parsePositiveInteger(
    options.pairingTtlMs ?? DEFAULT_PAIRING_TTL_MS,
    "Pairing TTL",
  );
  const authenticationTimeoutMs = parsePositiveInteger(
    options.authenticationTimeoutMs ?? DEFAULT_AUTHENTICATION_TIMEOUT_MS,
    "WebSocket authentication timeout",
  );
  const toolCallTimeoutMs = parsePositiveInteger(
    options.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
    "Tool call timeout",
  );
  const maxPayload = parsePositiveInteger(
    options.maxWebSocketPayloadBytes ?? DEFAULT_MAX_WEBSOCKET_PAYLOAD_BYTES,
    "WebSocket maximum payload",
  );
  const protocol = loadSharedProtocol(options.protocol, {
    advancedTools: Boolean(options.advancedTools),
  });
  const logger = options.logger || console;
  const allowedHttpOrigins = new Set(options.allowedHttpOrigins || []);
  const allowedExtensionOrigins = options.allowedExtensionOrigins
    ? new Set(options.allowedExtensionOrigins.map((origin) => normalizeOriginHeader(origin)).filter(Boolean))
    : null;

  let listeningPort = null;
  let closing = false;
  let pairingCode = generatePairingCode();
  let pairingExpiresAt = Date.now() + pairingTtlMs;
  let authenticatedExtension = null;
  const activeMcpResources = new Set();
  const pendingExtensionCalls = new Map();

  function getExtensionEndpoint() {
    return listeningPort
      ? `ws://${formatUrlHost(normalizedHost)}:${listeningPort}/extension`
      : "";
  }

  function getExtensionSetupValue() {
    const endpoint = getExtensionEndpoint();
    return endpoint ? createExtensionSetupValue(endpoint, pairingCode) : "";
  }

  const app = createMcpExpressApp({
    host: normalizedHost,
    allowedHosts: [formatUrlHost(normalizedHost)],
  });

  app.use((req, res, next) => {
    if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Loopback clients only." },
        id: null,
      });
      return;
    }
    const requestHost = parseRequestHost(req.headers.host);
    if (
      !requestHost ||
      requestHost.hostname !== normalizedHost ||
      requestHost.port !== listeningPort
    ) {
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid Host header." },
        id: null,
      });
      return;
    }
    const origin = req.headers.origin;
    if (typeof origin === "string" && !allowedHttpOrigins.has(origin)) {
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Browser origins are not allowed." },
        id: null,
      });
      return;
    }
    next();
  });

  app.use("/mcp", (req, res, next) => {
    const token = parseBearerToken(req.headers.authorization);
    if (!secureEqual(token, state.mcpToken)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="local-mcp"');
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Authentication required." },
        id: null,
      });
      return;
    }
    next();
  });

  async function callExtension(toolName, toolArguments, client) {
    const connection = authenticatedExtension;
    if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
      const setupValue = getExtensionSetupValue();
      throw new Error(
        setupValue
          ? `The browser extension is not connected. Paste this value into the Bridge settings, connect and share the intended tab, then retry.\nExtension setup: ${setupValue}`
          : "The browser extension is not connected. Reconnect it before calling browser tools.",
      );
    }
    const id = randomUUID();
    const payload = {
      type: "request",
      id,
      toolName,
      args: toolArguments || {},
      client: isObject(client)
        ? {
            name: typeof client.name === "string" ? client.name : "unknown",
            version: typeof client.version === "string" ? client.version : "unknown",
          }
        : { name: "unknown", version: "unknown" },
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingExtensionCalls.delete(id);
        reject(new Error(`Browser tool timed out after ${toolCallTimeoutMs} ms.`));
      }, toolCallTimeoutMs);
      timer.unref?.();
      pendingExtensionCalls.set(id, { resolve, reject, timer, connection });
      if (!sendJson(connection.socket, payload)) {
        clearTimeout(timer);
        pendingExtensionCalls.delete(id);
        reject(new Error("The browser extension disconnected before the tool call was sent."));
      }
    });
  }

  function createMcpServer() {
    const server = new McpServer(
      { name: SERVER_IMPLEMENTATION_NAME, version: protocol.protocolVersion },
      {
        capabilities: { tools: {} },
        instructions: protocol.instructions || undefined,
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: protocol.tools }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      if (!protocol.toolNames.has(name)) {
        return toolErrorResult(new Error(`Unknown browser tool: ${name}`));
      }
      try {
        const validation = protocol.validateToolArguments(name, request.params.arguments || {});
        if (!validation?.valid) {
          return toolErrorResult(new Error(
            `Invalid ${name} input: ${Array.isArray(validation?.errors) ? validation.errors.join(" ") : "schema validation failed"}`,
          ));
        }
        return normalizeToolResult(
          await callExtension(name, request.params.arguments || {}, server.getClientVersion()),
        );
      } catch (error) {
        return toolErrorResult(error);
      }
    });
    return server;
  }

  async function connectMcpTransport(transport) {
    if (closing) {
      throw new Error("Companion is shutting down.");
    }
    if (!transport || typeof transport.start !== "function") {
      throw new Error("A valid MCP server transport is required.");
    }
    const server = createMcpServer();
    const resource = { server, transport, closed: false };
    activeMcpResources.add(resource);
    const close = async () => {
      if (resource.closed) return;
      resource.closed = true;
      activeMcpResources.delete(resource);
      await Promise.allSettled([transport.close(), server.close()]);
    };
    try {
      await server.connect(transport);
    } catch (error) {
      await close();
      throw error;
    }
    return { server, transport, close };
  }

  app.post("/mcp", async (req, res) => {
    if (closing) {
      res.status(503).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Companion is shutting down." },
        id: null,
      });
      return;
    }
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const resource = { server, transport, closed: false };
    activeMcpResources.add(resource);
    const cleanup = async () => {
      if (resource.closed) {
        return;
      }
      resource.closed = true;
      activeMcpResources.delete(resource);
      await Promise.allSettled([transport.close(), server.close()]);
    };
    res.once("close", cleanup);
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error?.("MCP request failed:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error." },
          id: null,
        });
      }
      await cleanup();
    }
  });

  app.all("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  const httpServer = createHttpServer(app);
  const webSocketServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload,
    clientTracking: true,
  });

  function extensionOriginAllowed(origin) {
    if (!origin) {
      return false;
    }
    if (allowedExtensionOrigins && !allowedExtensionOrigins.has(origin)) {
      return false;
    }
    if (typeof options.extensionOriginValidator === "function") {
      return Boolean(options.extensionOriginValidator(origin));
    }
    return true;
  }

  httpServer.on("upgrade", (request, socket, head) => {
    if (closing) {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    let requestUrl;
    try {
      requestUrl = new URL(request.url, "http://loopback.invalid");
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    if (requestUrl.pathname !== "/extension" || requestUrl.search || requestUrl.hash) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    const requestHost = parseRequestHost(request.headers.host);
    const origin = normalizeOriginHeader(request.headers.origin);
    if (
      !isLoopbackRemoteAddress(socket.remoteAddress) ||
      !requestHost ||
      requestHost.hostname !== normalizedHost ||
      requestHost.port !== listeningPort ||
      !extensionOriginAllowed(origin)
    ) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request, origin);
    });
  });

  async function persistCredential(origin, credential) {
    const record = {
      id: randomUUID(),
      hash: hashCredential(credential),
      origin,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    state.extensionCredentials = state.extensionCredentials
      .filter((item) => item.origin !== origin)
      .concat(record)
      .slice(-MAX_PERSISTED_EXTENSION_CREDENTIALS);
    await writeCompanionState(statePath, state);
    return record;
  }

  async function touchCredential(record) {
    record.lastUsedAt = new Date().toISOString();
    await writeCompanionState(statePath, state);
  }

  function findCredential(origin, credential) {
    const candidateHash = hashCredential(credential);
    return state.extensionCredentials.find(
      (record) => record.origin === origin && secureEqual(record.hash, candidateHash),
    );
  }

  function authenticateConnection(connection, credentialId) {
    if (authenticatedExtension && authenticatedExtension.socket !== connection.socket) {
      authenticatedExtension.socket.close(4001, "Replaced by a newer authenticated connection");
    }
    connection.authenticated = true;
    connection.credentialId = credentialId;
    authenticatedExtension = connection;
  }

  function rejectCallsForConnection(connection, reason) {
    for (const [id, pending] of pendingExtensionCalls) {
      if (pending.connection !== connection) {
        continue;
      }
      clearTimeout(pending.timer);
      pendingExtensionCalls.delete(id);
      pending.reject(new Error(reason));
    }
  }

  webSocketServer.on("connection", (socket, _request, origin) => {
    const connection = {
      socket,
      origin,
      authenticated: false,
      credentialId: null,
    };
    const authenticationTimer = setTimeout(() => {
      if (!connection.authenticated) {
        socket.close(4003, "Authentication timeout");
      }
    }, authenticationTimeoutMs);
    authenticationTimer.unref?.();

    sendJson(socket, {
      type: "hello",
      protocolVersion: protocol.protocolVersion,
      brokerId: state.brokerId,
      pairingAvailable: Boolean(pairingCode) && Date.now() <= pairingExpiresAt,
      pairingExpiresAt: pairingExpiresAt ? new Date(pairingExpiresAt).toISOString() : null,
    });

    socket.on("message", async (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, "Text messages only");
        return;
      }
      let message;
      try {
        message = JSON.parse(data.toString("utf8"));
      } catch {
        socket.close(1007, "Invalid JSON");
        return;
      }
      if (!isObject(message) || typeof message.type !== "string") {
        socket.close(1008, "Invalid message");
        return;
      }

      if (!connection.authenticated) {
        const extension = message.extension;
        if (
          !isObject(extension) ||
          typeof extension.id !== "string" ||
          !extension.id.trim() ||
          typeof extension.version !== "string" ||
          !extension.version.trim() ||
          !secureEqual(extension.protocolVersion, protocol.protocolVersion)
        ) {
          socket.close(4002, "Protocol version mismatch");
          return;
        }

        if (message.type === "pair") {
          if (
            Date.now() > pairingExpiresAt ||
            !secureEqual(message.code, pairingCode)
          ) {
            socket.close(4003, "Pairing code is invalid or expired");
            return;
          }
          pairingCode = null;
          pairingExpiresAt = 0;
          const credential = generateCredential();
          try {
            const record = await persistCredential(origin, credential);
            authenticateConnection(connection, record.id);
            clearTimeout(authenticationTimer);
            sendJson(socket, {
              type: "paired",
              protocolVersion: protocol.protocolVersion,
              brokerId: state.brokerId,
              token: credential,
            });
          } catch (error) {
            logger.error?.("Could not persist extension pairing:", error);
            socket.close(1011, "Pairing could not be persisted");
          }
          return;
        }

        if (message.type === "authenticate" && typeof message.token === "string") {
          const record = findCredential(origin, message.token);
          if (!record) {
            socket.close(4003, "Extension credential is invalid");
            return;
          }
          try {
            await touchCredential(record);
            authenticateConnection(connection, record.id);
            clearTimeout(authenticationTimer);
            sendJson(socket, {
              type: "authenticated",
              protocolVersion: protocol.protocolVersion,
              brokerId: state.brokerId,
            });
          } catch (error) {
            logger.error?.("Could not update extension credential:", error);
            socket.close(1011, "Authentication could not be persisted");
          }
          return;
        }

        socket.close(4003, "The first message must pair or authenticate");
        return;
      }

      if (message.type === "response" && typeof message.id === "string") {
        const pending = pendingExtensionCalls.get(message.id);
        if (!pending || pending.connection !== connection) {
          return;
        }
        clearTimeout(pending.timer);
        pendingExtensionCalls.delete(message.id);
        if (message.ok !== true) {
          let errorMessage = "The browser extension rejected the tool call.";
          if (isObject(message.error) && typeof message.error.message === "string") {
            errorMessage = message.error.message;
          } else if (typeof message.error === "string" && message.error) {
            errorMessage = message.error;
          }
          pending.reject(new Error(errorMessage));
        } else {
          pending.resolve(message.result);
        }
        return;
      }

      if (message.type === "revoke") {
        try {
          await revokeExtensionCredential(connection.credentialId, { disconnect: false });
          sendJson(socket, { type: "revoked" });
          socket.close(1000, "Credential revoked");
        } catch (error) {
          logger.error?.("Could not revoke extension credential:", error);
          socket.close(1011, "Credential could not be revoked");
        }
        return;
      }

      if (message.type === "ping") {
        sendJson(socket, { type: "pong", timestamp: new Date().toISOString() });
        return;
      }

      socket.close(1008, "Unsupported authenticated message");
    });

    socket.on("close", () => {
      clearTimeout(authenticationTimer);
      if (authenticatedExtension === connection) {
        authenticatedExtension = null;
      }
      rejectCallsForConnection(connection, "The browser extension disconnected during the tool call.");
    });

    socket.on("error", (error) => {
      logger.warn?.("Extension WebSocket error:", error.message);
    });
  });

  try {
    await listen(httpServer, requestedPort, normalizedHost);
  } catch (error) {
    const canSelectAnotherPort = (
      !hasConfiguredPort
      && requestedPort !== 0
      && error?.code === "EADDRINUSE"
    );
    if (!canSelectAnotherPort) {
      throw error;
    }
    logger.warn?.(`Remembered companion port ${requestedPort} is unavailable; selecting a new loopback port.`);
    await listen(httpServer, 0, normalizedHost);
  }
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    await closeHttpServer(httpServer);
    throw new Error("Companion did not receive a TCP listening address.");
  }
  listeningPort = address.port;
  if (state.preferredPort !== listeningPort) {
    state.preferredPort = listeningPort;
    try {
      await writeCompanionState(statePath, state);
    } catch (error) {
      await closeHttpServer(httpServer);
      throw error;
    }
  }
  const endpointHost = formatUrlHost(normalizedHost);

  async function rotatePairingCode() {
    pairingCode = generatePairingCode();
    pairingExpiresAt = Date.now() + pairingTtlMs;
    return {
      pairingCode,
      expiresAt: new Date(pairingExpiresAt).toISOString(),
    };
  }

  async function revokeExtensionCredential(credentialId, { disconnect = true } = {}) {
    const previousLength = state.extensionCredentials.length;
    state.extensionCredentials = state.extensionCredentials.filter(
      (record) => record.id !== credentialId,
    );
    if (state.extensionCredentials.length === previousLength) {
      return false;
    }
    await writeCompanionState(statePath, state);
    if (disconnect && authenticatedExtension?.credentialId === credentialId) {
      authenticatedExtension.socket.close(4004, "Credential revoked");
    }
    return true;
  }

  async function close() {
    if (closing) {
      return;
    }
    closing = true;
    pairingCode = null;
    pairingExpiresAt = 0;
    for (const [id, pending] of pendingExtensionCalls) {
      clearTimeout(pending.timer);
      pendingExtensionCalls.delete(id);
      pending.reject(new Error("Companion is shutting down."));
    }
    for (const client of webSocketServer.clients) {
      client.close(1001, "Companion is shutting down");
      client.terminate();
    }
    await Promise.allSettled(
      Array.from(activeMcpResources, ({ transport, server }) =>
        Promise.allSettled([transport.close(), server.close()]),
      ),
    );
    activeMcpResources.clear();
    await Promise.allSettled([
      closeWebSocketServer(webSocketServer),
      closeHttpServer(httpServer),
    ]);
  }

  return {
    app,
    httpServer,
    webSocketServer,
    host: normalizedHost,
    port: listeningPort,
    statePath,
    brokerId: state.brokerId,
    mcpToken: state.mcpToken,
    protocolVersion: protocol.protocolVersion,
    advancedTools: Boolean(options.advancedTools),
    tools: protocol.tools,
    endpoints: {
      mcp: `http://${endpointHost}:${listeningPort}/mcp`,
      extension: getExtensionEndpoint(),
    },
    get extensionSetup() {
      return getExtensionSetupValue();
    },
    get pairingCode() {
      return pairingCode;
    },
    get pairingExpiresAt() {
      return pairingExpiresAt ? new Date(pairingExpiresAt).toISOString() : null;
    },
    get extensionConnected() {
      return Boolean(authenticatedExtension);
    },
    rotatePairingCode,
    revokeExtensionCredential,
    connectMcpTransport,
    close,
  };
}

function parseCliArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--stdio") {
      options.stdio = true;
      continue;
    }
    if (argument === "--print-config") {
      options.printConfig = true;
      continue;
    }
    if (argument === "--advanced-tools") {
      options.advancedTools = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}.`);
    }
    index += 1;
    if (argument === "--host") {
      options.host = value;
    } else if (argument === "--port") {
      options.port = value;
    } else if (argument === "--state") {
      options.statePath = value;
    } else if (argument === "--state-dir") {
      options.stateDir = value;
    } else if (argument === "--pairing-ttl-ms") {
      options.pairingTtlMs = value;
    } else if (argument === "--tool-timeout-ms") {
      options.toolCallTimeoutMs = value;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

async function runCli() {
  const cliOptions = parseCliArguments(process.argv.slice(2));
  if (cliOptions.printConfig) {
    process.stdout.write(`${JSON.stringify(createStdioClientConfig({
      advancedTools: cliOptions.advancedTools,
    }), null, 2)}\n`);
    return;
  }
  if (cliOptions.stdio && cliOptions.json) {
    throw new Error("--stdio reserves stdout for MCP messages and cannot be combined with --json.");
  }
  const server = await createCompanionServer(cliOptions);
  const startup = {
    mcpEndpoint: server.endpoints.mcp,
    extensionEndpoint: server.endpoints.extension,
    extensionSetup: server.extensionSetup,
    mcpBearerToken: server.mcpToken,
    pairingCode: server.pairingCode,
    pairingExpiresAt: server.pairingExpiresAt,
    statePath: server.statePath,
    transport: cliOptions.stdio ? "stdio" : "streamable-http",
    toolMode: server.advancedTools ? "advanced" : "guided",
  };
  if (cliOptions.stdio) {
    await server.connectMcpTransport(new StdioServerTransport());
    process.stderr.write(
      [
        "Browser bridge MCP is ready over stdio.",
        `Extension setup: ${startup.extensionSetup}`,
        "Paste that single value into Settings → Bridge, then connect and share the current tab.",
        `Tool mode: ${startup.toolMode}`,
      ].join("\n") + "\n",
    );
  } else if (cliOptions.json) {
    process.stdout.write(`${JSON.stringify(startup)}\n`);
  } else {
    process.stdout.write(
      [
        "Browser bridge is ready.",
        `Extension setup: ${startup.extensionSetup}`,
        `MCP endpoint: ${startup.mcpEndpoint}`,
        `MCP bearer token: ${startup.mcpBearerToken}`,
        `Pairing code expires: ${startup.pairingExpiresAt}`,
        `State file: ${startup.statePath}`,
        `Tool mode: ${startup.toolMode}`,
        "For the simplest MCP client setup, use the JSON from --print-config instead of configuring the HTTP endpoint and token manually.",
      ].join("\n") + "\n",
    );
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await server.close();
  };
  process.once("SIGINT", async () => {
    await shutdown();
    process.exit(0);
  });
  process.once("SIGTERM", async () => {
    await shutdown();
    process.exit(0);
  });
  if (cliOptions.stdio) {
    process.stdin.once("end", shutdown);
    process.stdin.once("close", shutdown);
  }
}

const isCli = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  runCli().catch((error) => {
    process.stderr.write(`${error.stack || error.message || String(error)}\n`);
    process.exitCode = 1;
  });
}

export { resolveStatePath };

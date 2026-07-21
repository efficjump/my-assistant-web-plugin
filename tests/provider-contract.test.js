const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Core = require("../agent-core.js");

function loadBackgroundFunctions(fetchImplementation = globalThis.fetch) {
  const listeners = { installed: [], clicked: [], message: [] };
  const chrome = {
    runtime: {
      onInstalled: { addListener: (listener) => listeners.installed.push(listener) },
      onMessage: { addListener: (listener) => listeners.message.push(listener) },
      getURL: (value) => `chrome-extension://test/${value}`,
      getManifest: () => ({ version: "0.4.0" }),
      lastError: null
    },
    action: { onClicked: { addListener: (listener) => listeners.clicked.push(listener) } },
    sidePanel: {},
    tabs: {},
    scripting: {}
  };
  const sandbox = {
    chrome,
    console,
    crypto: globalThis.crypto,
    fetch: fetchImplementation,
    Headers,
    URL,
    TextDecoder,
    AbortController,
    URLSearchParams,
    TextEncoder,
    Uint8Array,
    btoa,
    structuredClone,
    setTimeout,
    clearTimeout,
    Map,
    Math
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  vm.runInContext(source, sandbox, { filename: "background.js" });
  return sandbox;
}

test("builds a stateless OpenAI Responses request with strict structured output", () => {
  const runtime = loadBackgroundFunctions();
  const body = runtime.buildRequestBody({
    apiProfile: "openai-responses",
    model: "dynamic-model",
    maxOutputTokens: 2500,
    structuredOutput: true
  }, {
    system: "system",
    user: "user",
    screenshotDataUrl: "data:image/jpeg;base64,AAAA",
    responseSchema: Core.DECISION_SCHEMA
  });

  assert.equal(body.store, false);
  assert.equal(body.model, "dynamic-model");
  assert.equal(body.input[0].content[0].type, "input_text");
  assert.equal(body.input[0].content[1].type, "input_image");
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.strict, true);
  assert.deepEqual(JSON.parse(JSON.stringify(body.text.format.schema)), Core.DECISION_SCHEMA);
});

test("builds the Chat Completions structured-output contract", () => {
  const runtime = loadBackgroundFunctions();
  const body = runtime.buildRequestBody({
    apiProfile: "openai-chat",
    structuredOutput: true,
    maxOutputTokens: 800
  }, {
    system: "system",
    user: "user",
    responseSchema: Core.DECISION_SCHEMA
  });
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.max_tokens, 800);
});

test("wires OpenAI built-in tools only into Responses requests", () => {
  const runtime = loadBackgroundFunctions();
  const body = runtime.buildRequestBody({
    apiProfile: "openai-responses",
    model: "dynamic-model"
  }, {
    system: "tool executor",
    user: "current facts",
    providerTools: [{ type: "web_search", search_context_size: "medium" }],
    providerToolChoice: "required",
    include: ["web_search_call.action.sources"]
  });
  assert.deepEqual(JSON.parse(JSON.stringify(body.tools)), [{ type: "web_search", search_context_size: "medium" }]);
  assert.equal(body.tool_choice, "required");
  assert.deepEqual(JSON.parse(JSON.stringify(body.include)), ["web_search_call.action.sources"]);
});

test("derives MCP OAuth discovery URLs without putting tokens in settings", () => {
  const runtime = loadBackgroundFunctions();
  assert.equal(
    runtime.buildProtectedResourceMetadataUrl("https://mcp.example.test/team/server"),
    "https://mcp.example.test/.well-known/oauth-protected-resource/team/server"
  );
  assert.equal(
    runtime.parseResourceMetadataUrl('Bearer resource_metadata="https://mcp.example.test/auth/resource"'),
    "https://mcp.example.test/auth/resource"
  );
  assert.match(runtime.getMcpOAuthStorageKey({ mcpEndpoint: "https://mcp.example.test/server" }), /^mcpOAuth:/);
  assert.doesNotThrow(() => runtime.assertSecureOAuthEndpoint("http://127.0.0.1:8787/mcp", "local MCP"));
  assert.throws(
    () => runtime.assertSecureOAuthEndpoint("http://mcp.example.test/server", "remote MCP"),
    /must use https/
  );
  assert.equal(
    runtime.normalizeOAuthIssuer("https://auth.example.test/"),
    runtime.normalizeOAuthIssuer("https://auth.example.test")
  );
});

test("adds provider citation URLs to display text without exposing opaque tokens", () => {
  const runtime = loadBackgroundFunctions();
  const text = runtime.appendProviderArtifactReferences("Current result", [
    { type: "url_citation", title: "Primary source", url: "https://example.test/fact" },
    { type: "url_citation", title: "Duplicate", url: "https://example.test/fact" },
    { type: "container_file_citation", filename: "analysis.csv", file_id: "opaque-file-id" }
  ]);
  assert.match(text, /Primary source: https:\/\/example\.test\/fact/);
  assert.equal((text.match(/https:\/\/example\.test\/fact/g) || []).length, 1);
  assert.match(text, /analysis\.csv/);
  assert.doesNotMatch(text, /opaque-file-id/);
});

test("extracts raw Responses API output text", () => {
  const runtime = loadBackgroundFunctions();
  const text = runtime.extractResponseText({
    output: [{
      type: "message",
      content: [{ type: "output_text", text: "{\"status\":\"answer\"}" }]
    }]
  }, "");
  assert.equal(text, "{\"status\":\"answer\"}");
});

test("auto MCP version resolves to the current stable client preference", () => {
  const runtime = loadBackgroundFunctions();
  assert.equal(runtime.resolveMcpProtocolVersion({ mcpProtocolVersion: "auto" }), "2025-11-25");
  assert.equal(runtime.resolveMcpProtocolVersion({ mcpProtocolVersion: "2025-06-18" }), "2025-06-18");
});

test("falls back once when a compatible endpoint rejects structured output", async () => {
  const requestBodies = [];
  const fetchImplementation = async (_url, init) => {
    requestBodies.push(JSON.parse(init.body));
    if (requestBodies.length === 1) {
      return {
        ok: false,
        status: 400,
        headers: { get: () => null },
        text: async () => JSON.stringify({ error: { message: "response_format unsupported" } })
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        id: "chatcmpl-test",
        model: "dynamic-model",
        choices: [{ message: { content: "ok" } }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 3,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 4 },
          completion_tokens_details: { reasoning_tokens: 1 }
        }
      })
    };
  };
  const runtime = loadBackgroundFunctions(fetchImplementation);
  const requestState = { controller: new AbortController() };
  const result = await runtime.fetchAiWithRetry({
    endpoint: "https://api.example.test/v1/chat/completions",
    headers: { "Content-Type": "application/json" },
    body: {
      messages: [{ role: "user", content: "test" }],
      response_format: { type: "json_schema", json_schema: { name: "test", schema: Core.DECISION_SCHEMA } }
    },
    profile: "openai-chat",
    settings: { maxApiRetries: 0 },
    requestId: "test-request",
    requestState
  });

  assert.equal(requestBodies.length, 2);
  assert.equal(Boolean(requestBodies[0].response_format), true);
  assert.equal(Boolean(requestBodies[1].response_format), false);
  assert.equal(result.structuredFallbackUsed, true);
  assert.equal(result.text, "ok");
  assert.equal(result.audit.outcome, "success");
  assert.equal(result.audit.attempts, 2);
  assert.equal(result.audit.responseId, "chatcmpl-test");
  assert.deepEqual(JSON.parse(JSON.stringify(result.audit.usage)), {
    inputTokens: 12,
    outputTokens: 3,
    totalTokens: 15,
    cachedTokens: 4,
    reasoningTokens: 1
  });
});

test("fails closed and records diagnostics when a successful response has no usable output", async () => {
  const runtime = loadBackgroundFunctions(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({
      id: "resp-empty",
      status: "completed",
      model: "dynamic-model",
      output: [],
      usage: { input_tokens: 21, output_tokens: 0, total_tokens: 21 }
    })
  }));
  await assert.rejects(
    runtime.fetchAiWithRetry({
      endpoint: "https://api.example.test/v1/responses",
      headers: { "Content-Type": "application/json" },
      body: { input: "test" },
      profile: "openai-responses",
      settings: { maxApiRetries: 0, model: "dynamic-model" },
      taskType: "chat-agent-decision",
      requestId: "empty-test",
      requestState: { controller: new AbortController() }
    }),
    (error) => {
      assert.equal(error.name, "EmptyAiResponseError");
      assert.equal(error.audit.outcome, "empty_response");
      assert.equal(error.audit.emptyOutput, true);
      assert.equal(error.audit.responseId, "resp-empty");
      assert.equal(error.audit.responseBytes > 0, true);
      assert.equal(error.audit.usage.totalTokens, 21);
      return true;
    }
  );
});

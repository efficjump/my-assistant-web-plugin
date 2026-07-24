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

test("treats an MCP isError tool result as an execution failure", async () => {
  const runtime = loadBackgroundFunctions();
  runtime.ensureMcpInitialized = async () => {};
  runtime.sendMcpRequest = async () => ({
    result: {
      isError: true,
      content: [{ type: "text", text: "Tool rejected the request." }]
    }
  });

  await assert.rejects(
    runtime.callMcpTool(
      { mcpEnabled: true },
      { toolName: "dynamic-tool", arguments: {} }
    ),
    (error) => (
      error?.name === "McpToolError"
      && error?.code === "mcp_tool_error"
      && /rejected/i.test(error.message)
    )
  );
});

test("execution bindings are an exact fail-closed action-ID map", async () => {
  const runtime = loadBackgroundFunctions();
  const action = (id) => ({ id, type: "click", ref: "e1" });
  const binding = (actionId) => ({
    actionId,
    frameId: 0,
    documentId: "document-1",
    targetBinding: `binding-${actionId}`
  });

  const indexed = runtime.indexExecutionBindings(
    [action("first"), action("second")],
    [binding("second"), binding("first")]
  );
  assert.equal(indexed.get("first").targetBinding, "binding-first");
  assert.equal(indexed.get("second").targetBinding, "binding-second");

  await assert.rejects(
    runtime.executePageActionsInFrames(
      1,
      [action("duplicate"), action("duplicate")],
      [binding("duplicate")]
    ),
    /duplicate action ID/i
  );
  await assert.rejects(
    runtime.executePageActionsInFrames(
      1,
      [action("first")],
      [binding("first"), binding("first")]
    ),
    /duplicate execution binding ID/i
  );
  await assert.rejects(
    runtime.executePageActionsInFrames(
      1,
      [action("first"), action("second")],
      [binding("first")]
    ),
    /no matching execution binding: second/i
  );
  await assert.rejects(
    runtime.executePageActionsInFrames(
      1,
      [action("first")],
      [binding("unexpected")]
    ),
    /no matching action: unexpected/i
  );
});

test("frame routing uses bindings and localizes condition refs without crossing frames", () => {
  const runtime = loadBackgroundFunctions();
  const selectorBinding = {
    actionId: "selector-action",
    frameId: 7,
    documentId: "frame-document-7",
    targetBinding: "target-7",
    targetStateBinding: "state-7"
  };
  const selectorRoute = runtime.routeFrameAction({
    id: "selector-action",
    type: "click",
    selector: "#bound-target"
  }, selectorBinding);
  assert.equal(selectorRoute.frameId, 7);
  assert.equal(selectorRoute.executionBinding.frameId, 7);
  assert.equal(selectorRoute.executionBinding.targetStateBinding, "state-7");

  const conditionRoute = runtime.routeFrameAction({
    id: "condition-action",
    type: "wait_for",
    conditionJson: JSON.stringify({
      all: [
        { type: "element_state", ref: "f7:e3", state: "checked" },
        { type: "element", ref: "f7:e4", operator: "exists" }
      ]
    })
  }, {
    actionId: "condition-action",
    frameId: 7,
    documentId: "frame-document-7",
    targetBinding: "",
    conditionBindings: [
      {
        ref: "f7:e3",
        selector: "#first",
        text: "",
        frameId: 7,
        documentId: "frame-document-7",
        targetBinding: "condition-1",
        targetStateBinding: "state-1"
      },
      {
        ref: "f7:e4",
        selector: "#second",
        text: "",
        frameId: 7,
        documentId: "frame-document-7",
        targetBinding: "condition-2",
        targetStateBinding: "state-2"
      }
    ]
  });
  const routedCondition = JSON.parse(conditionRoute.action.conditionJson);
  assert.equal(conditionRoute.frameId, 7);
  assert.equal(routedCondition.all[0].ref, "e3");
  assert.equal(routedCondition.all[1].ref, "e4");
  assert.deepEqual(
    Array.from(conditionRoute.executionBinding.conditionBindings, (item) => item.ref),
    ["e3", "e4"]
  );

  assert.throws(
    () => runtime.routeFrameAction(
      { id: "conflict", type: "click", ref: "f8:e1" },
      { ...selectorBinding, actionId: "conflict" }
    ),
    /different frames/i
  );
  assert.throws(
    () => runtime.routeFrameAction(
      { id: "condition-conflict", type: "wait_for", conditionJson: "{}" },
      {
        ...selectorBinding,
        actionId: "condition-conflict",
        conditionBindings: [{
          ref: "f8:e1",
          frameId: 8,
          documentId: "frame-document-8",
          targetBinding: "condition-8",
          targetStateBinding: "state-8"
        }]
      }
    ),
    /different frame/i
  );
});

test("the external page driver forwards execution bindings", async () => {
  const runtime = loadBackgroundFunctions();
  let driver = null;
  const storageArea = {
    get: async () => ({}),
    set: async () => {},
    setAccessLevel: async () => {}
  };
  runtime.chrome.storage = { local: storageArea, session: storageArea };
  runtime.chrome.runtime.sendMessage = async () => ({});
  runtime.WebExternalControlRuntime = {
    createExternalControlRuntime(options) {
      driver = options.driver;
      return { initialize: async () => {} };
    }
  };
  await runtime.initializeExternalControlBridge();
  assert.ok(driver);

  await assert.rejects(
    driver.executePage(
      1,
      [{ id: "bound-action", type: "click", ref: "e1" }],
      [{
        actionId: "different-action",
        frameId: 0,
        documentId: "document-1",
        targetBinding: "target-1"
      }]
    ),
    /no matching action: different-action/i
  );
});

test("legacy main-world anchors must match both selector and observed point", () => {
  const runtime = loadBackgroundFunctions();
  class FakeAnchor {
    constructor(name) {
      this.name = name;
      this.clicked = false;
    }

    getAttribute(name) {
      return name === "href" ? "javascript:activate()" : "";
    }

    click() {
      this.clicked = true;
    }
  }
  class FakeArea {}
  runtime.HTMLAnchorElement = FakeAnchor;
  runtime.HTMLAreaElement = FakeArea;

  const first = new FakeAnchor("first");
  const second = new FakeAnchor("second");
  runtime.document = {
    querySelectorAll: () => [first, second],
    elementFromPoint: () => ({
      closest: () => second
    })
  };

  const activated = runtime.activateBoundJavascriptAnchor({
    selector: "a[data-action='repeat']",
    declaredHref: "javascript:activate()",
    point: { x: 120, y: 80 }
  });
  assert.equal(activated.activated, true);
  assert.equal(first.clicked, false);
  assert.equal(second.clicked, true);

  const replacement = new FakeAnchor("replacement");
  runtime.document.elementFromPoint = () => ({
    closest: () => replacement
  });
  const rejected = runtime.activateBoundJavascriptAnchor({
    selector: "a[data-action='repeat']",
    declaredHref: "javascript:activate()",
    point: { x: 120, y: 80 }
  });
  assert.equal(rejected.activated, false);
  assert.match(rejected.error, /activation point/i);
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

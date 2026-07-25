const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Core = require("../agent-core.js");
const AgentRuntimeV2 = require("../agent-v2/runtime.js");
const AgentProviderDriverV2 = require("../agent-v2/provider-driver.js");
const AgentRunStoreV2 = require("../agent-v2/run-store.js");

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
    ReadableStream,
    Response,
    btoa,
    structuredClone,
    setTimeout,
    clearTimeout,
    Map,
    Math,
    WebAgentCore: Core,
    WebAgentRuntimeV2: AgentRuntimeV2,
    WebAgentProviderDriverV2: AgentProviderDriverV2,
    WebAgentRunStoreV2: AgentRunStoreV2
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
  assert.deepEqual(
    JSON.parse(JSON.stringify(body.include)),
    ["reasoning.encrypted_content"]
  );
  assert.deepEqual(JSON.parse(JSON.stringify(body.text.format.schema)), Core.DECISION_SCHEMA);
});

test("replays stateless Responses output items instead of restarting every planner turn", () => {
  const runtime = loadBackgroundFunctions();
  const body = runtime.buildRequestBody({
    apiProfile: "openai-responses",
    model: "dynamic-model",
    structuredOutput: true
  }, {
    system: "system",
    user: "continue from the tool result",
    providerState: {
      profile: "openai-responses",
      items: [{
        id: "reasoning-1",
        type: "reasoning",
        encrypted_content: "encrypted"
      }, {
        id: "message-1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Prior decision" }]
      }]
    },
    responseSchema: Core.DECISION_SCHEMA
  });

  assert.equal(body.input[0].type, "reasoning");
  assert.equal(body.input[1].type, "message");
  assert.equal(body.input.at(-1).role, "user");
  assert.equal(body.include.includes("reasoning.encrypted_content"), true);
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

test("uses the per-request output budget when a runtime stage needs a different ceiling", () => {
  const runtime = loadBackgroundFunctions();
  const body = runtime.buildRequestBody({
    apiProfile: "openai-responses",
    maxOutputTokens: 2000
  }, {
    user: "bounded stage",
    maxOutputTokens: 7200
  });

  assert.equal(body.max_output_tokens, 7200);
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
  assert.deepEqual(
    JSON.parse(JSON.stringify(body.include)),
    ["reasoning.encrypted_content", "web_search_call.action.sources"]
  );
});

test("builds a streamed native decision request with a per-stage model override", () => {
  const runtime = loadBackgroundFunctions();
  const body = runtime.buildRequestBody({
    apiProfile: "openai-responses",
    model: "primary-model",
    structuredOutput: true
  }, {
    model: "stage-model",
    system: "runtime",
    user: "choose",
    stream: true,
    providerTools: [{
      type: "function",
      name: "browser_agent_step",
      description: "Return one decision.",
      parameters: Core.DECISION_SCHEMA,
      strict: true
    }],
    providerToolChoice: "required"
  });

  assert.equal(body.model, "stage-model");
  assert.equal(body.stream, true);
  assert.equal(body.tool_choice, "required");
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.tools[0].name, "browser_agent_step");
  assert.equal(body.text, undefined);
});

test("adds low-latency Responses controls without replacing the structured format", () => {
  const runtime = loadBackgroundFunctions();
  const body = runtime.buildRequestBody({
    apiProfile: "openai-responses",
    model: "dynamic-model",
    structuredOutput: true
  }, {
    system: "stable instructions",
    user: "current request",
    responseSchema: Core.DECISION_SCHEMA,
    reasoningEffort: "low",
    textVerbosity: "low",
    serviceTier: "priority",
    promptCache: true,
    promptCacheScope: "planner-contract"
  });

  assert.equal(body.reasoning.effort, "low");
  assert.equal(body.text.verbosity, "low");
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.service_tier, "priority");
  assert.match(body.prompt_cache_key, /^pc-[a-z0-9]+$/);
});

test("custom JSON templates receive the per-stage model override", () => {
  const runtime = loadBackgroundFunctions();
  const body = runtime.buildRequestBody({
    apiProfile: "custom-json",
    model: "primary-model",
    customBodyTemplate: JSON.stringify({
      model: "{{model}}",
      prompt: "{{prompt}}"
    })
  }, {
    model: "stage-model",
    user: "bounded stage"
  });

  assert.equal(body.model, "stage-model");
  assert.equal(body.prompt, "bounded stage");
});

test("streamed Responses function calls are accepted without fake output text", async () => {
  const completedResponse = {
    id: "response-streamed-tool",
    status: "completed",
    model: "dynamic-model",
    output: [{
      type: "function_call",
      id: "function-item",
      call_id: "function-call",
      name: "browser_agent_step",
      arguments: JSON.stringify({
        version: "1.0",
        status: "continue"
      })
    }],
    usage: {
      input_tokens: 100,
      output_tokens: 25,
      total_tokens: 125
    }
  };
  const sse = [
    `event: response.created\ndata: ${JSON.stringify({
      type: "response.created",
      response: { id: completedResponse.id, status: "in_progress", output: [] }
    })}`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: completedResponse
    })}`,
    ""
  ].join("\n\n");
  const runtime = loadBackgroundFunctions(async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.stream, true);
    return new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  });
  const result = await runtime.callAiApi({
    apiProfile: "openai-responses",
    apiEndpoint: "https://api.example.test/responses",
    model: "dynamic-model",
    maxOutputTokens: 1000,
    maxApiRetries: 0,
    requestTimeoutMs: 10000,
    structuredOutput: true
  }, {
    requestId: "stream-function-test",
    system: "runtime",
    user: "choose a step",
    stream: true,
    providerTools: [{
      type: "function",
      name: "browser_agent_step",
      description: "Return one decision.",
      parameters: Core.DECISION_SCHEMA,
      strict: true
    }],
    providerToolChoice: "required"
  });

  assert.equal(result.text, "");
  assert.equal(result.functionCalls.length, 1);
  assert.equal(result.functionCalls[0].callId, "function-call");
  assert.equal(result.functionCalls[0].arguments.status, "continue");
  assert.equal(result.audit.streamed, true);
  assert.ok(result.audit.firstByteMs >= 0);
});

test("compatible Responses endpoints fall back from streaming and native steps to structured JSON", async () => {
  const bodies = [];
  const runtime = loadBackgroundFunctions(async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (body.stream === true) {
      return new Response(JSON.stringify({ error: { message: "stream unsupported" } }), {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    }
    if (body.tools?.some((tool) => tool.name === "browser_agent_step")) {
      return new Response(JSON.stringify({ error: { message: "function tools unsupported" } }), {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({
      id: "structured-fallback",
      status: "completed",
      output: [{
        type: "message",
        role: "assistant",
        content: [{
          type: "output_text",
          text: JSON.stringify({ status: "answer", message: "Fallback worked." })
        }]
      }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });
  const settings = {
    apiProfile: "openai-responses",
    apiEndpoint: "https://compatible.example.test/responses",
    model: "dynamic-model",
    maxOutputTokens: 1000,
    maxApiRetries: 0,
    requestTimeoutMs: 10000,
    structuredOutput: true
  };
  const request = {
    requestId: "native-fallback-test",
    user: "choose",
    stream: true,
    fallbackResponseSchema: Core.DECISION_SCHEMA,
    providerTools: [{
      type: "function",
      name: "browser_agent_step",
      description: "Return one decision.",
      parameters: Core.DECISION_SCHEMA,
      strict: true
    }],
    providerToolChoice: "required"
  };
  const result = await runtime.callAiApi(settings, request);

  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].stream, true);
  assert.equal(bodies[1].stream, false);
  assert.equal(bodies[2].tools, undefined);
  assert.equal(bodies[2].parallel_tool_calls, undefined);
  assert.equal(bodies[2].text.format.type, "json_schema");
  assert.match(result.text, /Fallback worked/);
  assert.equal(result.audit.streamingFallbackUsed, true);
  assert.equal(result.audit.nativeToolFallbackUsed, true);

  const cachedResult = await runtime.callAiApi(settings, {
    ...request,
    requestId: "native-fallback-cache-test"
  });
  assert.equal(bodies.length, 4);
  assert.equal(bodies[3].stream, false);
  assert.equal(bodies[3].tools, undefined);
  assert.equal(cachedResult.audit.compatibilityCacheHit, true);
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
    cacheWriteTokens: null,
    reasoningTokens: 1
  });
});

test("falls back without losing the request when a Responses-compatible endpoint rejects encrypted reasoning", async () => {
  const requestBodies = [];
  const runtime = loadBackgroundFunctions(async (_url, init) => {
    const body = JSON.parse(init.body);
    requestBodies.push(body);
    if (requestBodies.length === 1) {
      return {
        ok: false,
        status: 400,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          error: { message: "unsupported include value" }
        })
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        id: "resp-compatible",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ok" }]
        }]
      })
    };
  });
  const result = await runtime.fetchAiWithRetry({
    endpoint: "https://api.example.test/v1/responses",
    headers: { "Content-Type": "application/json" },
    body: {
      store: false,
      input: [{ role: "user", content: [{ type: "input_text", text: "test" }] }],
      include: ["reasoning.encrypted_content"],
      max_output_tokens: 2000
    },
    profile: "openai-responses",
    settings: { maxApiRetries: 0 },
    request: { user: "test" },
    requestId: "reasoning-fallback",
    requestState: { controller: new AbortController() }
  });

  assert.equal(requestBodies.length, 2);
  assert.deepEqual(requestBodies[0].include, ["reasoning.encrypted_content"]);
  assert.equal(Object.hasOwn(requestBodies[1], "include"), false);
  assert.equal(result.text, "ok");
});

test("negotiates unsupported low-latency hints independently and preserves structured output", async () => {
  const requestBodies = [];
  const rejectedFields = [
    "reasoning.effort is unsupported",
    "text.verbosity is unsupported",
    "prompt_cache_key is unsupported",
    "service_tier priority is unsupported"
  ];
  const runtime = loadBackgroundFunctions(async (_url, init) => {
    const body = JSON.parse(init.body);
    requestBodies.push(body);
    const rejection = rejectedFields[requestBodies.length - 1];
    if (rejection) {
      return {
        ok: false,
        status: 400,
        headers: { get: () => null },
        text: async () => JSON.stringify({ error: { message: rejection } })
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        id: "resp-latency-fallback",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ok" }]
        }]
      })
    };
  });
  const result = await runtime.fetchAiWithRetry({
    endpoint: "https://api.example.test/v1/responses",
    headers: { "Content-Type": "application/json" },
    body: {
      store: false,
      input: [{ role: "user", content: [{ type: "input_text", text: "test" }] }],
      reasoning: { effort: "low" },
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "decision",
          strict: true,
          schema: Core.DECISION_SCHEMA
        }
      },
      prompt_cache_key: "pc-test",
      service_tier: "priority",
      max_output_tokens: 1200
    },
    profile: "openai-responses",
    settings: { maxApiRetries: 0 },
    request: { user: "test", serviceTier: "priority" },
    requestId: "latency-hint-fallback",
    requestState: { controller: new AbortController() }
  });

  assert.equal(requestBodies.length, 5);
  assert.equal(Boolean(requestBodies[0].reasoning), true);
  assert.equal(Boolean(requestBodies[1].reasoning), false);
  assert.equal(requestBodies[1].text.verbosity, "low");
  assert.equal(requestBodies[2].text.verbosity, undefined);
  assert.equal(requestBodies[2].text.format.type, "json_schema");
  assert.equal(requestBodies[3].prompt_cache_key, undefined);
  assert.equal(requestBodies[4].service_tier, undefined);
  assert.equal(requestBodies[4].text.format.type, "json_schema");
  assert.equal(result.audit.reasoningEffortFallbackUsed, true);
  assert.equal(result.audit.textVerbosityFallbackUsed, true);
  assert.equal(result.audit.promptCachingFallbackUsed, true);
  assert.equal(result.audit.priorityProcessingFallbackUsed, true);
});

test("a generic compatible-endpoint error removes latency hints in one bounded retry", async () => {
  const requestBodies = [];
  const runtime = loadBackgroundFunctions(async (_url, init) => {
    const body = JSON.parse(init.body);
    requestBodies.push(body);
    if (requestBodies.length === 1) {
      return {
        ok: false,
        status: 400,
        headers: { get: () => null },
        text: async () => JSON.stringify({ error: { message: "unsupported request option" } })
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        id: "resp-generic-latency-fallback",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ok" }]
        }]
      })
    };
  });
  const result = await runtime.fetchAiWithRetry({
    endpoint: "https://compatible.example.test/v1/responses",
    headers: { "Content-Type": "application/json" },
    body: {
      store: false,
      input: [{ role: "user", content: [{ type: "input_text", text: "test" }] }],
      reasoning: { effort: "low" },
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "decision",
          strict: true,
          schema: Core.DECISION_SCHEMA
        }
      },
      prompt_cache_key: "pc-test",
      service_tier: "priority",
      max_output_tokens: 1200
    },
    profile: "openai-responses",
    settings: { maxApiRetries: 0 },
    request: { user: "test", serviceTier: "priority" },
    requestId: "generic-latency-hint-fallback",
    requestState: { controller: new AbortController() },
    compatibility: {
      reasoningEffort: null,
      textVerbosity: null,
      promptCaching: null,
      priorityProcessing: null,
      updatedAt: 0
    }
  });

  assert.equal(requestBodies.length, 2);
  assert.equal(requestBodies[1].reasoning, undefined);
  assert.equal(requestBodies[1].text.verbosity, undefined);
  assert.equal(requestBodies[1].prompt_cache_key, undefined);
  assert.equal(requestBodies[1].service_tier, undefined);
  assert.equal(requestBodies[1].text.format.type, "json_schema");
  assert.equal(result.audit.reasoningEffortFallbackUsed, true);
  assert.equal(result.audit.textVerbosityFallbackUsed, true);
  assert.equal(result.audit.promptCachingFallbackUsed, true);
  assert.equal(result.audit.priorityProcessingFallbackUsed, true);
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

test("retries one incomplete Responses result with a larger output budget", async () => {
  const requestBodies = [];
  const runtime = loadBackgroundFunctions(async (_url, init) => {
    const body = JSON.parse(init.body);
    requestBodies.push(body);
    if (requestBodies.length === 1) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          id: "resp-incomplete",
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [],
          usage: { input_tokens: 20, output_tokens: body.max_output_tokens, total_tokens: 2020 }
        })
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        id: "resp-complete",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "{\"status\":\"answer\"}" }]
        }],
        usage: { input_tokens: 20, output_tokens: 50, total_tokens: 70 }
      })
    };
  });

  const result = await runtime.fetchAiWithRetry({
    endpoint: "https://api.example.test/v1/responses",
    headers: { "Content-Type": "application/json" },
    body: { input: [], max_output_tokens: 2000 },
    profile: "openai-responses",
    settings: {
      maxApiRetries: 0,
      maxRecoveryOutputTokens: 12000,
      model: "dynamic-model"
    },
    request: { user: "test" },
    taskType: "chat-agent-decision",
    requestId: "incomplete-test",
    requestState: { controller: new AbortController() }
  });

  assert.equal(requestBodies.length, 2);
  assert.ok(requestBodies[1].max_output_tokens > requestBodies[0].max_output_tokens);
  assert.equal(result.responseId, "resp-complete");
  assert.equal(result.audit.attempts, 2);
  assert.equal(result.continuation.profile, "openai-responses");
});

test("fails closed when an incomplete Responses result cannot be recovered", async () => {
  const runtime = loadBackgroundFunctions(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({
      id: "resp-filtered",
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "partial output" }]
      }]
    })
  }));

  await assert.rejects(
    runtime.fetchAiWithRetry({
      endpoint: "https://api.example.test/v1/responses",
      headers: { "Content-Type": "application/json" },
      body: { input: [], max_output_tokens: 2000 },
      profile: "openai-responses",
      settings: { maxApiRetries: 0, model: "dynamic-model" },
      request: { user: "test" },
      taskType: "chat-agent-decision",
      requestId: "filtered-test",
      requestState: { controller: new AbortController() }
    }),
    (error) => {
      assert.equal(error.name, "IncompleteAiResponseError");
      assert.equal(error.audit.outcome, "incomplete_response");
      return true;
    }
  );
});

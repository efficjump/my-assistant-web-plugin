const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../agent-core.js");
const Runtime = require("../agent-v2/runtime.js");
const Provider = require("../agent-v2/provider-driver.js");
const Latency = require("../agent-v2/latency-strategy.js");

test("fast stage profiles lower reasoning and use the fast model for normal interactive planning", () => {
  const settings = {
    apiProfile: "openai-responses",
    structuredOutput: true,
    streamAiResponses: true,
    latencyMode: "fast",
    agentMode: "approve",
    model: "primary-dynamic-model",
    fastModel: "fast-dynamic-model",
    maxOutputTokens: 6000,
    maxTextChars: 16000,
    providerContinuationMaxChars: 64000
  };
  const planner = Latency.resolveStageProfile({
    purpose: "intent-and-decision",
    settings,
    responseSchema: Core.INITIAL_DECISION_SCHEMA,
    inputChars: 30000
  });
  const policy = Latency.resolveStageProfile({
    purpose: "policy-runtime",
    settings,
    responseSchema: Core.POLICY_SCHEMA,
    inputChars: 8000
  });
  const visual = Latency.resolveStageProfile({
    purpose: "visual-action-verifier-runtime",
    settings,
    responseSchema: Core.VERIFIER_SCHEMA,
    inputChars: 12000
  });
  const answerRepair = Latency.resolveStageProfile({
    purpose: "answer-grounding-repair",
    settings,
    responseSchema: Core.DECISION_SCHEMA,
    inputChars: 25000
  });

  assert.ok(planner.maxOutputTokens < settings.maxOutputTokens);
  assert.ok(policy.maxOutputTokens < planner.maxOutputTokens);
  assert.equal(planner.model, settings.fastModel);
  assert.equal(planner.modelRole, "fast");
  assert.equal(planner.fastPlanner, true);
  assert.equal(planner.reasoningEffort, "low");
  assert.equal(planner.textVerbosity, "low");
  assert.equal(planner.promptCache, true);
  assert.equal(policy.model, settings.fastModel);
  assert.equal(visual.model, settings.model);
  assert.equal(answerRepair.kind, "repair");
  assert.equal(answerRepair.model, settings.model);
  assert.equal(planner.nativeTools, true);
  assert.equal(policy.nativeTools, false);
  assert.ok(planner.continuationChars < settings.providerContinuationMaxChars);
});

test("automatic, visual, repair, and forced-primary planning preserve the primary model", () => {
  const settings = {
    apiProfile: "openai-responses",
    structuredOutput: true,
    latencyMode: "fast",
    agentMode: "auto",
    model: "primary-dynamic-model",
    fastModel: "fast-dynamic-model"
  };
  const automatic = Latency.resolveStageProfile({
    purpose: "intent-and-decision",
    settings,
    responseSchema: Core.INITIAL_DECISION_SCHEMA
  });
  const visual = Latency.resolveStageProfile({
    purpose: "decision",
    settings: { ...settings, agentMode: "approve" },
    responseSchema: Core.DECISION_SCHEMA,
    hasScreenshot: true
  });
  const repair = Latency.resolveStageProfile({
    purpose: "repair",
    settings: { ...settings, agentMode: "approve" },
    responseSchema: Core.DECISION_SCHEMA
  });
  const forced = Latency.resolveStageProfile({
    purpose: "decision",
    settings: { ...settings, agentMode: "approve" },
    responseSchema: Core.DECISION_SCHEMA,
    forcePrimaryModel: true
  });

  assert.equal(automatic.modelRole, "primary");
  assert.equal(visual.kind, "visual");
  assert.equal(visual.modelRole, "primary");
  assert.equal(repair.modelRole, "primary");
  assert.equal(forced.modelRole, "primary");
});

test("fast planner escalation is reserved for uncertain or primary-only effects", () => {
  const validation = { valid: true };
  assert.deepEqual(
    Latency.evaluateFastPlannerEscalation({
      fastPlanner: true,
      validation,
      decision: { status: "continue", actions: [{ type: "click" }], toolCalls: [] }
    }),
    { required: false, reason: "" }
  );
  assert.equal(
    Latency.evaluateFastPlannerEscalation({
      fastPlanner: true,
      validation,
      decision: { status: "blocked", actions: [], toolCalls: [] }
    }).required,
    true
  );
  assert.equal(
    Latency.evaluateFastPlannerEscalation({
      fastPlanner: true,
      validation,
      decision: { status: "continue", actions: [{ type: "upload" }], toolCalls: [] }
    }).reason,
    "fast-planner-primary-only-effect"
  );
  assert.equal(
    Latency.evaluateFastPlannerEscalation({
      fastPlanner: true,
      validation,
      decision: { status: "continue", actions: [], toolCalls: [{ toolName: "dynamic" }] }
    }).reason,
    "fast-planner-external-tool"
  );
});

test("fast route acceptance requires a bounded strategy, confidence, and matching contract", () => {
  assert.deepEqual(
    Latency.evaluateFastRoute({
      route: {
        strategy: "direct",
        confidence: 0.91,
        actions: [{ type: "click" }]
      },
      intent: { deliverable: { kind: "effect" } }
    }),
    {
      accepted: true,
      reason: "fast-route-accepted"
    }
  );
  assert.equal(
    Latency.evaluateFastRoute({
      route: { strategy: "agent", confidence: 1, actions: [] },
      intent: { deliverable: { kind: "effect" } }
    }).accepted,
    false
  );
  assert.equal(
    Latency.evaluateFastRoute({
      route: { strategy: "answer", confidence: 0.6, actions: [] },
      intent: { deliverable: { kind: "answer" } }
    }).reason,
    "fast-route-confidence-below-threshold"
  );
  assert.equal(
    Latency.evaluateFastRoute({
      route: { strategy: "collection", confidence: 0.95, actions: [] },
      intent: { deliverable: { kind: "answer" } }
    }).reason,
    "fast-route-collection-contract-mismatch"
  );
});

test("native Responses steps keep function calls and exact function outputs in one continuation", () => {
  const tool = Latency.buildNativeDecisionTool(Core.DECISION_SCHEMA);
  assert.equal(tool.type, "function");
  assert.equal(tool.name, "browser_agent_step");
  assert.deepEqual(tool.parameters.properties.status.enum, Core.DECISION_SCHEMA.properties.status.enum);

  const firstInput = Provider.buildOpenAiResponsesInput({
    user: "Choose a page action."
  });
  const continuation = Provider.buildContinuation({
    profile: "openai-responses",
    request: {
      providerSummary: JSON.stringify({ objective: "Open settings." })
    },
    body: { input: firstInput },
    response: {
      id: "response-with-function",
      output: [{
        type: "function_call",
        id: "function-item",
        call_id: "function-call-id",
        name: "browser_agent_step",
        arguments: "{\"status\":\"continue\"}"
      }]
    }
  });
  const secondInput = Provider.buildOpenAiResponsesInput({
    providerState: continuation,
    providerToolOutputs: [{
      callId: "function-call-id",
      output: { status: "executed", evidenceIds: ["evidence-action"] }
    }],
    user: "Use the refreshed observation to finish."
  });
  const outputIndex = secondInput.findIndex((item) => item.type === "function_call_output");
  const currentInputIndex = secondInput.findLastIndex((item) => item.role === "user");

  assert.ok(secondInput.some((item) => item.type === "function_call"));
  assert.ok(outputIndex >= 0);
  assert.ok(outputIndex < currentInputIndex);
  assert.equal(secondInput[outputIndex].call_id, "function-call-id");
});

test("a directly cited current-page answer passes the deterministic gate without a second model", () => {
  const evidence = [{
    id: "page-current",
    source: "page_observation",
    payload: { visibleText: "Current account status: active" }
  }];
  const result = Latency.evaluateLocalTerminalDecision({
    runtime: Runtime,
    goal: Runtime.normalizeGoalContract({
      objective: "Report the visible account status.",
      deliverable: { kind: "answer" },
      successCriteria: ["The answer states the visible status."]
    }),
    candidate: {
      status: "answer",
      message: "The current account status is active.",
      completionEvidence: ["page-current"],
      verification: {
        required: false,
        expectedChange: "",
        successCriteria: ["The answer states the visible status."]
      }
    },
    evidence,
    currentPageEvidenceId: "page-current",
    requireCurrentPageEvidence: true
  });

  assert.equal(result.verified, true);
  assert.equal(result.useRemoteVerifier, false);
  assert.equal(result.verifier.source, "deterministic-runtime");
});

test("ambiguous or tool-grounded answers retain independent semantic verification", () => {
  const evidence = [{
    id: "tool-result",
    source: "tool_result",
    payload: { ok: true, text: "Untrusted external result" }
  }];
  const result = Latency.evaluateLocalTerminalDecision({
    runtime: Runtime,
    goal: Runtime.normalizeGoalContract({
      objective: "Explain an external result.",
      deliverable: { kind: "answer" }
    }),
    candidate: {
      status: "answer",
      message: "External result",
      completionEvidence: ["tool-result"],
      verification: {
        required: false,
        expectedChange: "",
        successCriteria: []
      }
    },
    evidence,
    currentPageEvidenceId: ""
  });

  assert.equal(result.verified, false);
  assert.equal(result.useRemoteVerifier, true);
  assert.equal(result.reason, "answer-needs-semantic-verification");
});

test("a page citation cannot locally verify a promise that omits the requested result", () => {
  const result = Latency.evaluateLocalTerminalDecision({
    runtime: Runtime,
    goal: Runtime.normalizeGoalContract({
      objective: "Report the current account status.",
      deliverable: { kind: "answer" },
      successCriteria: ["The response includes the actual status."]
    }),
    candidate: {
      status: "completed",
      message: "I checked the status and will summarize it next.",
      completionEvidence: ["page-current"],
      verification: {
        required: true,
        expectedChange: "The current page was observed.",
        successCriteria: ["The response includes the actual status."]
      }
    },
    evidence: [{
      id: "page-current",
      source: "page_observation",
      payload: { visibleText: "Current account status: active" }
    }],
    currentPageEvidenceId: "page-current",
    requireCurrentPageEvidence: true
  });

  assert.equal(result.verified, false);
  assert.equal(result.useRemoteVerifier, true);
  assert.equal(result.reason, "terminal-status-needs-semantic-verification");
});

test("page-evidence field names cannot masquerade as an answer result", () => {
  const result = Latency.evaluateLocalTerminalDecision({
    runtime: Runtime,
    goal: Runtime.normalizeGoalContract({
      objective: "Report the current heading.",
      deliverable: { kind: "answer" }
    }),
    candidate: {
      status: "answer",
      message: "The title is available.",
      completionEvidence: ["page-current"],
      verification: {
        required: false,
        expectedChange: "",
        successCriteria: []
      }
    },
    evidence: [{
      id: "page-current",
      source: "page_observation",
      payload: { title: "Dashboard", visibleText: "" }
    }],
    currentPageEvidenceId: "page-current"
  });

  assert.equal(result.verified, false);
  assert.equal(result.reason, "answer-needs-semantic-verification");
});

test("structural DOM metadata cannot masquerade as a page answer", () => {
  const result = Latency.evaluateLocalTerminalDecision({
    runtime: Runtime,
    goal: Runtime.normalizeGoalContract({
      objective: "Report the current heading.",
      deliverable: { kind: "answer" }
    }),
    candidate: {
      status: "answer",
      message: "A button is available.",
      completionEvidence: ["page-current"],
      verification: {
        required: false,
        expectedChange: "",
        successCriteria: []
      }
    },
    evidence: [{
      id: "page-current",
      source: "page_observation",
      payload: {
        title: "Dashboard",
        visibleText: "",
        interactiveElements: [{
          ref: "e1",
          tag: "button",
          role: "button",
          type: "button",
          label: ""
        }]
      }
    }],
    currentPageEvidenceId: "page-current"
  });

  assert.equal(result.verified, false);
  assert.equal(result.reason, "answer-needs-semantic-verification");
});

test("an exact material page effect completes from runtime evidence without an LLM verifier", () => {
  const evidence = [{
    id: "action-effect",
    source: "action_result",
    payload: {
      ok: true,
      transport: { dispatched: true, acknowledged: true },
      effect: { changed: true }
    }
  }, {
    id: "page-after",
    source: "page_observation",
    payload: { visibleText: "Settings dialog" }
  }];
  const result = Latency.evaluateLocalTerminalDecision({
    runtime: Runtime,
    goal: Runtime.normalizeGoalContract({
      objective: "Open settings.",
      deliverable: { kind: "effect" },
      successCriteria: ["Settings is visible."],
      requiresCurrentPageEvidence: true
    }),
    candidate: {
      status: "completed",
      message: "Settings are open.",
      completionEvidence: ["action-effect", "page-after"],
      verification: {
        required: true,
        expectedChange: "Settings becomes visible.",
        successCriteria: ["Settings is visible."]
      }
    },
    evidence,
    currentPageEvidenceId: "page-after",
    requireCurrentPageEvidence: true
  });

  assert.equal(result.verified, true);
  assert.equal(result.useRemoteVerifier, false);
});

test("semantic continuation compaction preserves recent tool state and adds a runtime summary", () => {
  const items = Array.from({ length: 20 }, (_, index) => ({
    role: "user",
    content: `old planner prompt ${index} ${"x".repeat(800)}`
  }));
  items.push({
    type: "function_call",
    call_id: "latest-call",
    name: "browser_agent_step",
    arguments: "{}"
  });
  const compacted = Provider.compactConversationItems(items, 5000, {
    profile: "openai-responses",
    summary: JSON.stringify({
      objective: "Open settings.",
      evidenceIds: ["page-after"]
    })
  });

  assert.ok(JSON.stringify(compacted).length <= 5200);
  assert.ok(compacted.some((item) => item.type === "function_call"));
  assert.match(compacted[0].content[0].text, /^\[runtime-state-summary\]/);
});

test("continuation compaction never keeps an orphaned function call or output", () => {
  const compacted = Provider.compactConversationItems([{
    type: "function_call",
    call_id: "old-call",
    name: "browser_agent_step",
    arguments: JSON.stringify({ status: "continue", detail: "x".repeat(1800) })
  }, {
    type: "function_call_output",
    call_id: "old-call",
    output: JSON.stringify({ status: "executed", detail: "y".repeat(1800) })
  }, {
    role: "user",
    content: `latest observation ${"z".repeat(1400)}`
  }], 2200, {
    profile: "openai-responses",
    summary: JSON.stringify({ objective: "Continue safely." })
  });
  const callIds = new Set(
    compacted
      .filter((item) => item.type === "function_call")
      .map((item) => item.call_id)
  );
  const outputIds = new Set(
    compacted
      .filter((item) => item.type === "function_call_output")
      .map((item) => item.call_id)
  );

  assert.deepEqual(callIds, outputIds);
});

test("run latency summaries expose first-useful-action milestones, call budgets, and percentile regressions", () => {
  const summary = Latency.summarizeRunLatency([
    {
      kind: "ai-request",
      purpose: "intent-and-decision",
      durationMs: 1200,
      firstByteMs: 300,
      usage: { inputTokens: 1000, outputTokens: 300 }
    },
    {
      kind: "ai-request",
      purpose: "decision",
      durationMs: 1800,
      firstByteMs: 450,
      usage: { inputTokens: 1200, outputTokens: 260 }
    }
  ], {
    callBudget: 2,
    wallClockDurationMs: 2800,
    milestones: {
      firstDecisionReadyMs: 1250,
      firstApprovalReadyMs: 1280,
      firstEffectStartedMs: 1300,
      firstEffectCompletedMs: 1900,
      completedMs: 2800
    }
  });

  assert.equal(summary.requestCount, 2);
  assert.equal(summary.withinCallBudget, true);
  assert.equal(summary.p50RequestMs, 1200);
  assert.equal(summary.p95RequestMs, 1800);
  assert.equal(summary.p95FirstByteMs, 450);
  assert.equal(summary.byStage.planner.calls, 2);
  assert.equal(summary.wallClockDurationMs, 2800);
  assert.equal(summary.milestones.firstDecisionReadyMs, 1250);
  assert.equal(summary.milestones.firstApprovalReadyMs, 1280);
  assert.equal(summary.milestones.firstEffectCompletedMs, 1900);

  const localReplay = Latency.summarizeRunLatency([], {
    callBudget: 0,
    wallClockDurationMs: 45,
    milestones: {
      firstDecisionReadyMs: 12,
      firstEffectCompletedMs: 40,
      completedMs: 45
    }
  });
  assert.equal(localReplay.callBudget, 0);
  assert.equal(localReplay.withinCallBudget, true);
  assert.equal(localReplay.requestCount, 0);
});

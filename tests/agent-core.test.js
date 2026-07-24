const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../agent-core.js");

function baseDecision(overrides = {}) {
  return {
    version: "1.0",
    status: "continue",
    message: "진행합니다.",
    summary: "검색창 입력",
    progress: "검색창을 확인함",
    doneReason: "",
    completionEvidence: [],
    needsUserApproval: false,
    plan: ["검색어 입력", "결과 확인"],
    elementSearch: {
      query: "",
      roles: [],
      nearText: "",
      reason: ""
    },
    toolCalls: [],
    actions: [{
      id: "a1",
      type: "fill",
      ref: "e1",
      selector: null,
      text: null,
      value: "agent",
      checked: null,
      key: null,
      code: null,
      direction: null,
      amount: null,
      url: null,
      ms: null,
      reason: "검색어 입력"
    }],
    verification: {
      required: true,
      expectedChange: "검색창 값 변경",
      successCriteria: ["검색창 값이 agent임"]
    },
    ...overrides
  };
}

const context = {
  url: "https://example.com/search",
  title: "Search",
  visibleText: "Search documents",
  viewport: { width: 1000, height: 700, scrollX: 0, scrollY: 0 },
  interactiveElements: [{
    ref: "e1",
    tag: "input",
    role: "textbox",
    type: "search",
    label: "Search",
    selector: "input[name='q']"
  }]
};

test("parses fenced model JSON", () => {
  const value = Core.parseJsonFromText(`\`\`\`json\n${JSON.stringify(baseDecision())}\n\`\`\``);
  assert.equal(value.status, "continue");
});

test("normalizes a decision and validates an observed element ref", () => {
  const decision = Core.normalizeDecision(baseDecision(), { step: 2, maxEffects: 3 });
  const validation = Core.validateDecision(decision, { context, availableTools: [], maxEffects: 3 });
  assert.equal(decision.step, 2);
  assert.equal(validation.valid, true);
  assert.equal(decision.actions[0].ref, "e1");
});

test("rejects duplicate action ids before execution bindings are built", () => {
  const decision = Core.normalizeDecision(baseDecision({
    actions: [
      baseDecision().actions[0],
      {
        id: "a1",
        type: "focus",
        ref: "e1",
        reason: "Use a different effect with the same invalid ID"
      }
    ]
  }), { maxEffects: 3 });
  const validation = Core.validateDecision(decision, {
    context,
    availableTools: [],
    maxEffects: 3
  });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(" "), /서로 다른 id/);
});

test("rejects invented refs and completion without evidence", () => {
  const invented = Core.normalizeDecision(baseDecision({
    actions: [{ ...baseDecision().actions[0], ref: "e99" }]
  }), { maxEffects: 3 });
  assert.equal(Core.validateDecision(invented, { context }).valid, false);

  const completed = Core.normalizeDecision(baseDecision({
    status: "completed",
    actions: [],
    completionEvidence: []
  }), { maxEffects: 3 });
  const validation = Core.validateDecision(completed, { context });
  assert.match(validation.errors.join(" "), /completionEvidence/);

  const verifierBoundValidation = Core.validateDecision(completed, {
    context,
    allowVerifierEvidenceBinding: true
  });
  assert.equal(verifierBoundValidation.valid, true);
  assert.match(verifierBoundValidation.warnings.join(" "), /verifier/);
});

test("rejects actions against controls that are visibly disabled", () => {
  const disabledContext = {
    ...context,
    interactiveElements: [{ ...context.interactiveElements[0], disabled: true, actionability: "disabled" }]
  };
  const decision = Core.normalizeDecision(baseDecision(), { maxEffects: 3 });
  const validation = Core.validateDecision(decision, { context: disabledContext });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(" "), /비활성화/);

  const ariaDisabledContext = {
    ...context,
    interactiveElements: [{ ...context.interactiveElements[0], ariaDisabled: true, actionability: "disabled" }]
  };
  const ariaValidation = Core.validateDecision(decision, { context: ariaDisabledContext });
  assert.equal(ariaValidation.valid, false);
  assert.match(ariaValidation.errors.join(" "), /aria-disabled/);
});

test("decision contract distinguishes the visual viewport from hidden DOM metadata", () => {
  const contract = Core.buildDecisionContractText();
  assert.match(contract, /visual viewport/i);
  assert.match(contract, /offscreen, clipped, occluded, or hidden DOM/i);
});

test("accepts local element search and removes stale search metadata from executable decisions", () => {
  const discovery = Core.normalizeDecision(baseDecision({
    status: "discover",
    message: "",
    summary: "관련 페이지 이동 버튼 검색",
    actions: [],
    elementSearch: {
      query: "next page",
      roles: ["BUTTON", "button"],
      nearText: "issue grid",
      reason: "현재 요소 묶음에 대상 ref가 없음"
    },
    verification: {
      required: false,
      expectedChange: "",
      successCriteria: []
    }
  }));
  assert.deepEqual(discovery.elementSearch.roles, ["button"]);
  assert.equal(Core.validateDecision(discovery, { context }).valid, true);

  const mixed = Core.normalizeDecision(baseDecision({
    status: "discover",
    elementSearch: discovery.elementSearch
  }));
  const mixedValidation = Core.validateDecision(mixed, { context });
  assert.equal(mixed.status, "continue");
  assert.deepEqual(mixed.elementSearch, {
    query: "",
    roles: [],
    nearText: "",
    reason: ""
  });
  assert.equal(mixedValidation.valid, true);

  const searchOnlyContinue = Core.normalizeDecision(baseDecision({
    status: "continue",
    actions: [],
    elementSearch: discovery.elementSearch
  }));
  assert.equal(searchOnlyContinue.status, "discover");
  assert.equal(Core.validateDecision(searchOnlyContinue, { context }).valid, true);

  const empty = Core.normalizeDecision(baseDecision({
    status: "discover",
    actions: [],
    elementSearch: { query: "", roles: [], nearText: "", reason: "" }
  }));
  assert.equal(Core.validateDecision(empty, { context }).valid, false);
});

test("visual actions are bound to one current screenshot and an observed visual surface", () => {
  const visualContext = {
    ...context,
    visualObservation: { id: "visual-observation-1", screenshotBound: true },
    visualSurfaces: [{
      ref: "v1",
      kind: "canvas",
      tag: "canvas",
      label: "Visual command surface",
      selector: "#visual-canvas",
      rect: { x: 20, y: 120, width: 240, height: 80 },
      actionability: "visual-coordinate-only"
    }]
  };
  const decision = Core.normalizeDecision(baseDecision({
    actions: [{
      id: "visual-action",
      type: "visual_click",
      ref: "v1",
      visualObservationId: "visual-observation-1",
      xNormalized: 750,
      yNormalized: 500,
      targetDescription: "green Apply area",
      reason: "The canvas has no equivalent DOM control"
    }]
  }), { maxEffects: 3 });

  assert.equal(Core.validateDecision(decision, { context: visualContext }).valid, true);
  const staleDecision = Core.normalizeDecision({
    ...baseDecision(),
    actions: [{ ...decision.actions[0], visualObservationId: "visual-observation-old" }]
  }, { maxEffects: 3 });
  assert.equal(Core.validateDecision(staleDecision, { context: visualContext }).valid, false);
  assert.equal(Core.validateDecision(decision, {
    context: { ...visualContext, visualObservation: null }
  }).valid, false);
  assert.equal(Core.validateDecision(decision, {
    context: { ...visualContext, visualSurfaces: [] }
  }).valid, false);
  const bypass = Core.normalizeDecision(baseDecision({
    actions: [{
      id: "visual-bypass",
      type: "click",
      ref: "v1",
      reason: "Attempt to bypass screenshot binding"
    }]
  }), { maxEffects: 3 });
  assert.equal(Core.validateDecision(bypass, { context: visualContext }).valid, false);
});

test("rejects terminal decisions without an exact user-facing message", () => {
  for (const status of ["answer", "clarify", "completed", "blocked"]) {
    const decision = Core.normalizeDecision({
      version: "1.0",
      status,
      message: "",
      summary: "내부 요약만 있음",
      doneReason: "내부 완료 사유만 있음",
      completionEvidence: status === "completed" ? ["ev-terminal"] : [],
      toolCalls: [],
      actions: []
    });
    const validation = Core.validateDecision(decision, {
      context,
      availableTools: [],
      availableEvidenceIds: ["ev-terminal"]
    });
    assert.equal(validation.valid, false, `${status} should require a message`);
    assert.match(validation.errors.join("\n"), /message/);
  }
});

test("decision contract requires terminal responses to deliver accepted conversational work", () => {
  const contract = Core.buildDecisionContractText();
  assert.match(contract, /runtime-resolved immutable turn intent/i);
  assert.match(contract, /do not re-expand it from raw conversation history/i);
  assert.match(contract, /include the requested result itself/i);
  assert.match(contract, /never end with a promise/i);
});

test("turn intent defaults to a standalone single-effect boundary and validates explicit repetition", () => {
  const fallback = Core.normalizeTurnIntent(null, {
    latestUserMessage: "Move to the next page"
  });
  assert.deepEqual(fallback, {
    version: "1.0",
    mode: "standalone",
    objective: "Move to the next page",
    contextSummary: "",
    repeatPolicy: "once",
    repeatLimit: 1,
    completionCriteria: [],
    reason: ""
  });

  const bounded = Core.normalizeTurnIntent({
    version: "1.0",
    mode: "standalone",
    objective: "Check the next three pages",
    contextSummary: "must be discarded",
    repeatPolicy: "bounded",
    repeatLimit: 3,
    completionCriteria: ["Three additional pages were inspected."],
    reason: "The latest request contains an explicit numeric bound."
  });
  assert.equal(Core.validateTurnIntent(bounded).valid, true);
  assert.equal(bounded.contextSummary, "");
  assert.equal(bounded.repeatLimit, 3);

  const invalidContinuation = Core.normalizeTurnIntent({
    ...bounded,
    mode: "continue_prior",
    contextSummary: ""
  });
  assert.equal(Core.validateTurnIntent(invalidContinuation).valid, false);
});

test("accepts only runtime-issued completion evidence IDs", () => {
  const completed = Core.normalizeDecision(baseDecision({
    status: "completed",
    actions: [],
    completionEvidence: ["ev-2-page_observation-abc"]
  }), { maxEffects: 3 });
  assert.equal(Core.validateDecision(completed, {
    context,
    availableEvidenceIds: ["ev-2-page_observation-abc"]
  }).valid, true);
  const invented = Core.validateDecision(completed, {
    context,
    availableEvidenceIds: ["ev-2-page_observation-other"]
  });
  assert.equal(invented.valid, false);
  assert.match(invented.errors.join(" "), /ledger/);
});

test("validates independent verifier evidence and policy approval reasons", () => {
  const verifier = Core.normalizeVerifier({
    version: "1.0",
    status: "verified",
    message: "근거 확인",
    evidenceIds: ["ev-1-page_observation-abc"],
    missingEvidence: [],
    confidence: 0.92
  });
  assert.equal(Core.validateVerifier(verifier, {
    availableEvidenceIds: ["ev-1-page_observation-abc"]
  }).valid, true);
  assert.equal(Core.validateVerifier(verifier, { availableEvidenceIds: [] }).valid, false);

  const policy = Core.normalizePolicy({
    version: "1.0",
    verdict: "approval",
    message: "외부 전송",
    risks: ["external side effect"],
    sensitiveData: [],
    approvalReasons: []
  });
  assert.equal(Core.validatePolicy(policy).valid, false);
});

test("normalizes and validates extension-owned visual target localization", () => {
  const target = Core.normalizeVisualTarget({
    version: "1.0",
    status: "found",
    message: "The requested next-page control is visible.",
    targetDescription: "Next page",
    xNormalized: 944,
    yNormalized: 918,
    confidence: 0.96
  });
  assert.equal(Core.validateVisualTarget(target).valid, true);

  const guessed = Core.normalizeVisualTarget({
    status: "found",
    message: "Guess",
    targetDescription: "Next page",
    xNormalized: null,
    yNormalized: null,
    confidence: 0.1
  });
  assert.equal(Core.validateVisualTarget(guessed).valid, false);
});

test("uses each MCP tool input schema dynamically", () => {
  const decision = Core.normalizeDecision(baseDecision({
    actions: [],
    toolCalls: [{
      toolName: "search",
      argumentsJson: JSON.stringify({ limit: "many" }),
      reason: "자료 검색"
    }]
  }), { maxEffects: 3 });
  const validation = Core.validateDecision(decision, {
    context,
    availableTools: [{
      name: "search",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { query: { type: "string" }, limit: { type: "integer" } },
        required: ["query"]
      }
    }]
  });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(" "), /query/);
  assert.match(validation.errors.join(" "), /integer/);
});

test("prevents tool calls and page actions from sharing one stale plan", () => {
  const decision = Core.normalizeDecision(baseDecision({
    toolCalls: [{ toolName: "search", argumentsJson: "{}", reason: "search" }]
  }), { maxEffects: 4 });
  const validation = Core.validateDecision(decision, {
    context,
    availableTools: [{ name: "search", inputSchema: { type: "object" } }]
  });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(" "), /한 턴/);
});

test("validates event-driven wait conditions and separates browser-level effects", () => {
  const waitDecision = Core.normalizeDecision(baseDecision({
    actions: [{
      id: "wait-ready",
      type: "wait_for",
      conditionJson: JSON.stringify({ type: "text", operator: "contains", value: "Ready" }),
      ms: 5000,
      reason: "wait for the page result"
    }]
  }), { maxEffects: 3 });
  assert.equal(Core.validateDecision(waitDecision, { context }).valid, true);

  const mixed = Core.normalizeDecision(baseDecision({
    actions: [
      baseDecision().actions[0],
      { id: "tab", type: "tab_adopt", tabId: 12, reason: "adopt popup" }
    ]
  }), { maxEffects: 3 });
  const validation = Core.validateDecision(mixed, { context });
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(" "), /브라우저 수준 액션/);
});

test("detects repeated decisions on an unchanged observation", () => {
  const session = {};
  const decision = Core.normalizeDecision(baseDecision(), { maxEffects: 3 });
  assert.equal(Core.updateProgressGuard(session, context, decision, { limit: 2 }).stalled, false);
  assert.equal(Core.updateProgressGuard(session, context, decision, { limit: 2 }).stalled, false);
  const third = Core.updateProgressGuard(session, context, decision, { limit: 2 });
  assert.equal(third.stalled, true);
  assert.equal(third.count, 2);
});

test("treats planner-only ids and reasons as the same semantic decision", () => {
  const session = {};
  const first = Core.normalizeDecision(baseDecision(), { maxEffects: 3 });
  const second = Core.normalizeDecision(baseDecision({
    actions: [{
      ...baseDecision().actions[0],
      id: "rewritten-id",
      reason: "같은 입력을 다른 문장으로 설명"
    }]
  }), { maxEffects: 3 });

  Core.updateProgressGuard(session, context, first, { limit: 2 });
  const repeated = Core.updateProgressGuard(session, context, second, { limit: 2 });
  assert.equal(repeated.repeatedDecision, true);
  assert.equal(repeated.count, 1);
});

test("starts a fresh repeat count when the semantic decision changes", () => {
  const session = {};
  const first = Core.normalizeDecision(baseDecision(), { maxEffects: 3 });
  const second = Core.normalizeDecision(baseDecision({
    actions: [{
      ...baseDecision().actions[0],
      value: "different"
    }]
  }), { maxEffects: 3 });

  Core.updateProgressGuard(session, context, first, { limit: 2 });
  Core.updateProgressGuard(session, context, first, { limit: 2 });
  const changed = Core.updateProgressGuard(session, context, second, { limit: 2 });
  const repeated = Core.updateProgressGuard(session, context, second, { limit: 2 });

  assert.equal(changed.count, 0);
  assert.equal(repeated.count, 1);
  assert.equal(repeated.stalled, false);
});

test("ignores raw revision churn when visible evidence is unchanged", () => {
  const session = {};
  const decision = Core.normalizeDecision(baseDecision(), { maxEffects: 3 });
  const firstContext = {
    ...context,
    documentId: "document-1",
    pageState: { readyState: "complete", domRevision: 1, visualRevision: 3 }
  };
  const secondContext = {
    ...firstContext,
    pageState: { ...firstContext.pageState, domRevision: 9, visualRevision: 12 }
  };

  Core.updateProgressGuard(session, firstContext, decision, { limit: 2 });
  const repeated = Core.updateProgressGuard(session, secondContext, decision, { limit: 2 });
  assert.equal(repeated.unchangedObservation, true);
  assert.equal(repeated.count, 1);
});

test("context fingerprints are stable across object key order", () => {
  const left = Core.fingerprintContext(context);
  const right = Core.fingerprintContext({
    interactiveElements: context.interactiveElements,
    viewport: context.viewport,
    visibleText: context.visibleText,
    title: context.title,
    url: context.url
  });
  assert.equal(left, right);
});

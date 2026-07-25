const test = require("node:test");
const assert = require("node:assert/strict");
const Runtime = require("../agent-v2/runtime.js");
const Provider = require("../agent-v2/provider-driver.js");
const ToolRegistry = require("../agent-v2/tool-registry.js");
const RunStore = require("../agent-v2/run-store.js");

function createRun() {
  return Runtime.createRun({
    runId: "run-v2-test",
    targetTabId: 7,
    request: "Open settings.",
    goal: {
      objective: "Open settings.",
      deliverable: { kind: "effect" },
      successCriteria: ["The settings dialog is visible."]
    },
    createdAt: "2026-07-25T00:00:00.000Z"
  });
}

function event(type, payload = {}, id = type) {
  return Runtime.createEvent(type, payload, {
    id,
    runId: "run-v2-test",
    createdAt: "2026-07-25T00:00:01.000Z"
  });
}

test("runtime reducer persists one resumable transition at a time", () => {
  let run = createRun();
  run = Runtime.reduceRun(run, event("run_started"));
  assert.equal(run.status, "observing");

  run = Runtime.reduceRun(run, event("observation_recorded", {
    evidenceId: "ev-page",
    documentId: "document-1",
    url: "https://example.test/",
    fingerprint: "page-fingerprint",
    evidence: {
      id: "ev-page",
      source: "page_observation",
      documentId: "document-1"
    }
  }));
  assert.equal(run.status, "thinking");
  assert.equal(run.latestObservation.evidenceId, "ev-page");

  run = Runtime.reduceRun(run, event("tool_started", {
    effectId: "effect-1",
    kind: "browser_action"
  }));
  assert.equal(Runtime.hasUnknownEffect(run), true);
  assert.equal(run.status, "executing");

  run = Runtime.reduceRun(run, event("tool_finished", {
    effectId: "effect-1",
    result: {
      ok: true,
      verification: { changed: true, materialChanged: true },
      evidence: [{
        id: "ev-action",
        source: "action_result",
        payload: { ok: true }
      }]
    }
  }));
  assert.equal(Runtime.hasUnknownEffect(run), false);
  assert.equal(run.status, "verifying");
  assert.equal(run.effectLedger.length, 1);
  assert.ok(run.evidenceLedger.some((item) => item.id === "ev-action"));
});

test("duplicate event delivery is idempotent", () => {
  const started = event("run_started");
  const once = Runtime.reduceRun(createRun(), started);
  const twice = Runtime.reduceRun(once, started);
  assert.equal(twice.events.length, 1);
});

test("resolved goal updates are part of the durable event stream", () => {
  const run = Runtime.reduceRun(createRun(), event("goal_updated", {
    goal: {
      objective: "Report the current settings state.",
      deliverable: { kind: "answer" },
      successCriteria: ["The response contains the visible state."]
    }
  }));

  assert.equal(run.goal.deliverable.kind, "answer");
  assert.deepEqual(
    run.goal.successCriteria,
    ["The response contains the visible state."]
  );
  assert.equal(run.events[0].type, "goal_updated");
});

test("completion gate distinguishes transport, effect evidence, and goal completion", () => {
  const goal = Runtime.normalizeGoalContract({
    objective: "Open settings.",
    deliverable: { kind: "effect" },
    successCriteria: ["The settings dialog is visible."],
    requiresCurrentPageEvidence: true
  });
  const evidence = [
    {
      id: "ev-action",
      source: "action_result",
      payload: { ok: true, verification: { changed: true } }
    },
    {
      id: "ev-page",
      source: "page_observation",
      payload: { visibleText: "Settings" }
    }
  ];
  const verified = Runtime.evaluateCompletion({
    goal,
    candidate: {
      status: "completed",
      completionEvidence: ["ev-action", "ev-page"]
    },
    verifier: {
      status: "verified",
      evidenceIds: ["ev-action", "ev-page"]
    },
    evidence,
    currentPageEvidenceId: "ev-page"
  });
  assert.equal(verified.verified, true);

  const transportOnly = Runtime.evaluateCompletion({
    goal,
    candidate: {
      status: "completed",
      completionEvidence: ["ev-page"]
    },
    verifier: {
      status: "verified",
      evidenceIds: ["ev-page"]
    },
    evidence,
    currentPageEvidenceId: "ev-page"
  });
  assert.equal(transportOnly.verified, false);
  assert.match(transportOnly.errors.join(" "), /action or tool result/i);

  const acknowledgedNoOp = Runtime.evaluateCompletion({
    goal,
    candidate: {
      status: "completed",
      completionEvidence: ["ev-no-op", "ev-page"]
    },
    verifier: {
      status: "verified",
      evidenceIds: ["ev-no-op", "ev-page"]
    },
    evidence: [
      {
        id: "ev-no-op",
        source: "action_result",
        payload: {
          ok: true,
          transport: { dispatched: true, acknowledged: true },
          effect: { changed: false }
        }
      },
      evidence[1]
    ],
    currentPageEvidenceId: "ev-page"
  });
  assert.equal(acknowledgedNoOp.verified, false);
  assert.match(acknowledgedNoOp.errors.join(" "), /action or tool result/i);

  const pending = Runtime.evaluateCompletion({
    goal,
    candidate: {
      status: "completed",
      completionEvidence: ["ev-action", "ev-page"]
    },
    verifier: {
      status: "verified",
      evidenceIds: ["ev-action", "ev-page"]
    },
    evidence,
    currentPageEvidenceId: "ev-page",
    pendingEffects: { "effect-unknown": {} }
  });
  assert.equal(pending.verified, false);
  assert.match(pending.errors.join(" "), /unknown execution outcome/i);
});

test("completion gate verifies every ordinal in a page-bounded collection", () => {
  const goal = Runtime.normalizeGoalContract({
    objective: "Collect pages 1 through 3.",
    deliverable: {
      kind: "collection",
      targetCount: null,
      pageRange: { start: 1, end: 3 },
      formats: []
    },
    successCriteria: ["Pages 1 through 3 are represented in the collection ledger."],
    requiresCurrentPageEvidence: false
  });
  const makeEvidence = (ordinals) => [{
    id: "ev-collection",
    source: "collection_result",
    payload: {
      status: "reached",
      uniqueCount: ordinals.length,
      pages: ordinals.map((ordinal) => ({
        ordinal,
        repeated: false
      }))
    }
  }];
  const evaluate = (evidence) => Runtime.evaluateCompletion({
    goal,
    candidate: {
      status: "completed",
      completionEvidence: ["ev-collection"]
    },
    verifier: {
      status: "verified",
      evidenceIds: ["ev-collection"]
    },
    evidence
  });

  assert.equal(evaluate(makeEvidence([1, 2, 3])).verified, true);
  const missingMiddle = evaluate(makeEvidence([1, 3]));
  assert.equal(missingMiddle.verified, false);
  assert.match(missingMiddle.errors.join(" "), /range 1-3/i);
});

test("context selection uses a token budget and preserves relevant evidence", () => {
  const items = Array.from({ length: 20 }, (_, index) => ({
    id: `ev-${index}`,
    step: index,
    summary: "x".repeat(300)
  }));
  const selected = Runtime.selectContextItems(items, {
    tokenBudget: 500,
    reserveTokens: 50,
    relevantIds: ["ev-2"]
  });
  assert.ok(selected.estimatedTokens <= 450);
  assert.ok(selected.items.some((item) => item.id === "ev-2"));
  assert.ok(selected.omittedCount > 0);
});

test("Responses continuation replays prior output items and strips old screenshots", () => {
  const firstInput = Provider.buildOpenAiResponsesInput({
    user: "Inspect the page.",
    screenshotDataUrl: "data:image/png;base64,AAAA"
  });
  const continuation = Provider.buildContinuation({
    profile: "openai-responses",
    request: {},
    body: { input: firstInput },
    response: {
      id: "resp-1",
      output: [{
        id: "reasoning-1",
        type: "reasoning",
        encrypted_content: "encrypted"
      }, {
        id: "message-1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Observed." }]
      }]
    }
  });
  assert.equal(continuation.items.some((item) => (
    item.role === "user"
    && item.content.some((entry) => entry.type === "input_image")
  )), false);
  assert.ok(continuation.items.some((item) => item.type === "reasoning"));

  const secondInput = Provider.buildOpenAiResponsesInput({
    user: "Continue.",
    providerState: continuation
  });
  assert.ok(secondInput.some((item) => item.type === "reasoning"));
  assert.equal(secondInput.at(-1).role, "user");
});

test("incomplete Responses output receives one larger dynamic recovery budget", () => {
  const next = Provider.buildIncompleteRecoveryBody({
    max_output_tokens: 2000,
    input: []
  }, {
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    usage: { output_tokens: 1900 }
  }, {
    maxRecoveryOutputTokens: 12000
  });
  assert.ok(next.max_output_tokens > 2000);
  assert.ok(next.max_output_tokens <= 12000);
  assert.equal(
    Provider.buildIncompleteRecoveryBody(
      { max_output_tokens: 2000 },
      { status: "incomplete", incomplete_details: { reason: "content_filter" } },
      {}
    ),
    null
  );
});

test("tool registry selects dynamically relevant tools when the catalog exceeds budget", () => {
  const tools = [
    { name: "calendar.create", description: "Create a calendar event." },
    { name: "documents.search", description: "Search documents and pages." },
    { name: "browser.click", description: "Click a visible browser control." },
    { name: "weather.lookup", description: "Look up weather." }
  ];
  const result = ToolRegistry.selectTools(tools, {
    objective: "Search the documents for the deployment plan.",
    maxTools: 2,
    maxChars: 5000
  });
  assert.equal(result.tools.some((tool) => tool.name === "documents.search"), true);
  assert.equal(result.tools.length, 2);
});

test("run store serializes concurrent updates and finds the active tab run", async () => {
  const values = {};
  const storage = {
    async get(key) {
      return { [key]: values[key] };
    },
    async set(next) {
      Object.assign(values, next);
    }
  };
  const store = RunStore.createRunStore({ storage });
  await store.put(createRun());
  await Promise.all([
    store.applyEvent("run-v2-test", event("run_started", {}, "start")),
    store.applyEvent("run-v2-test", event("observation_recorded", {
      evidenceId: "ev-page"
    }, "observe"))
  ]);
  const active = await store.getActiveForTab(7);
  assert.equal(active.runId, "run-v2-test");
  assert.equal(active.events.length, 2);
});

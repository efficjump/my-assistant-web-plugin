const test = require("node:test");
const assert = require("node:assert/strict");

const Core = require("../agent-core.js");
const Contract = require("../execution-contract.js");
const Protocol = require("../bridge-protocol.js");
const { ExternalControlRuntime } = require("../external-control-runtime.js");

const GOAL = "Update the shared page after checking the current state";

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function pageContext(overrides = {}) {
  const elementOverrides = overrides.element || {};
  const contextOverrides = { ...overrides };
  delete contextOverrides.element;
  return {
    url: "https://example.test/settings",
    title: "Settings",
    documentId: "document-1",
    domRevision: 1,
    visibleText: "Save settings",
    interactiveElements: [{
      ref: "e1",
      scope: "main",
      tag: "button",
      role: "button",
      type: "button",
      label: "Save settings",
      name: "save",
      selector: "button[data-action='save']",
      autocomplete: "",
      href: "",
      formAction: "",
      formMethod: "",
      disabled: false,
      readOnly: false,
      sensitive: false,
      value: "",
      options: [],
      ...elementOverrides
    }],
    forms: [],
    browser: { tabs: [], downloads: [] },
    ...contextOverrides
  };
}

function sensitiveContext() {
  return pageContext({
    element: {
      tag: "input",
      role: "textbox",
      type: "password",
      label: "Current password",
      name: "password",
      selector: "input[name='password']",
      autocomplete: "current-password",
      sensitive: true,
      value: "page-secret"
    }
  });
}

function clickAction(overrides = {}) {
  return {
    type: "click",
    ref: "e1",
    reason: "Save the requested setting",
    ...overrides
  };
}

class MemoryStorage {
  constructor(initial = {}) {
    this.data = clone(initial);
  }

  async get(key) {
    return { [key]: clone(this.data[key]) };
  }

  async set(values) {
    Object.assign(this.data, clone(values));
  }

  snapshot() {
    return clone(this.data);
  }
}

class FakeDriver {
  constructor(options = {}) {
    this.tabs = new Map((options.tabs || [defaultTab()]).map((tab) => [Number(tab.id), clone(tab)]));
    this.observations = (options.observations || [pageContext()]).map(clone);
    this.observeCalls = [];
    this.pageExecutions = [];
    this.browserExecutions = [];
    this.screenshotCalls = [];
    this.visualResolutions = (options.visualResolutions || []).map(clone);
    this.visualResolutionCalls = [];
  }

  async getTab(tabId) {
    const tab = this.tabs.get(Number(tabId));
    if (!tab) {
      throw new Error("tab not found");
    }
    return clone(tab);
  }

  async observe(tabId, options) {
    this.observeCalls.push({ tabId, options: clone(options) });
    const index = Math.min(this.observeCalls.length - 1, this.observations.length - 1);
    return clone(this.observations[index]);
  }

  async executePage(tabId, actions) {
    this.pageExecutions.push({ tabId, actions: clone(actions) });
    return { ok: true, actionCount: actions.length };
  }

  async executeBrowser(tabId, actions) {
    this.browserExecutions.push({ tabId, actions: clone(actions) });
    return { ok: true, actionCount: actions.length };
  }

  async screenshot(tabId) {
    this.screenshotCalls.push(tabId);
    return "data:image/png;base64,ZmFrZQ==";
  }

  async resolveVisualAction(tabId, request) {
    this.visualResolutionCalls.push({ tabId, request: clone(request) });
    const index = Math.min(
      this.visualResolutionCalls.length - 1,
      Math.max(0, this.visualResolutions.length - 1)
    );
    if (!this.visualResolutions.length) {
      throw new Error("visual resolution unavailable");
    }
    return clone(this.visualResolutions[index]);
  }
}

function defaultTab(overrides = {}) {
  return {
    id: 41,
    windowId: 7,
    title: "Settings",
    url: "https://example.test/settings",
    ...overrides
  };
}

function createIdFactory() {
  const counts = new Map();
  return (prefix) => {
    const count = (counts.get(prefix) || 0) + 1;
    counts.set(prefix, count);
    return `${prefix}-${count}`;
  };
}

function visualContext(overrides = {}) {
  return pageContext({
    interactiveElements: [],
    visualSurfaces: [{
      ref: "v1",
      kind: "canvas",
      tag: "canvas",
      role: "img",
      label: "Nexacro grid",
      selector: "#grid",
      actionability: "visual-coordinate-only",
      rect: { x: 20, y: 80, width: 600, height: 400 }
    }],
    visualObservation: {
      id: "visual-observation-1",
      screenshotBound: true,
      coordinateSystem: "surface-relative-0-1000",
      surfaceRefs: ["v1"]
    },
    ...overrides
  });
}

function visualResolution(xNormalized) {
  const context = visualContext({
    visualObservation: {
      id: `visual-observation-${xNormalized}`,
      screenshotBound: true,
      coordinateSystem: "surface-relative-0-1000",
      surfaceRefs: ["v1"]
    }
  });
  return {
    context,
    action: {
      id: `visual-${xNormalized}`,
      type: "visual_click",
      ref: "v1",
      visualObservationId: context.visualObservation.id,
      xNormalized,
      yNormalized: 920,
      targetDescription: "다음 페이지 버튼",
      reason: "문제점 조회 그리드의 다음 페이지로 이동"
    },
    attestation: {
      evidenceId: `visual-evidence-${xNormalized}`,
      verifier: { message: "verified", confidence: 0.99 }
    }
  };
}

async function createRuntime(options = {}) {
  const storage = options.storage || new MemoryStorage();
  const driver = options.driver || new FakeDriver();
  const clock = options.clock || { value: 1_700_000_000_000 };
  const runtime = new ExternalControlRuntime({
    storage,
    driver,
    now: () => clock.value,
    randomId: options.randomId || createIdFactory(),
    sessionTtlMs: options.sessionTtlMs || 60_000,
    approvalTtlMs: options.approvalTtlMs || 30_000,
    getSettings: options.getSettings || (async () => ({
      bridgeRequireApproval: true,
      stopOnSensitiveInput: true,
      redactSensitiveData: true,
      maxActionsPerTurn: 8
    })),
    evaluatePolicy: options.evaluatePolicy || (async () => ({
      version: "1.0",
      verdict: "allow",
      message: "The proposal is within the shared-tab objective.",
      risks: [],
      sensitiveData: [],
      approvalReasons: []
    })),
    resolveGoalIntent: options.resolveGoalIntent
  });
  await runtime.initialize();
  return { runtime, storage, driver, clock };
}

async function armAndStart(runtime, tab = defaultTab()) {
  await runtime.armTab(tab);
  return runtime.dispatch("browser_session_start", { goal: GOAL }, {
    id: "mcp-client-1",
    name: "Test MCP client"
  });
}

async function observe(runtime, sessionId) {
  return runtime.dispatch("browser_observe", { session_id: sessionId });
}

function executionArgs(sessionId, observationId, overrides = {}) {
  return {
    session_id: sessionId,
    observation_id: observationId,
    idempotency_key: "request-1",
    actions: [clickAction()],
    ...overrides
  };
}

test("a session requires explicit tab arming and holds a single expiring lease", async () => {
  const { runtime, clock } = await createRuntime({ sessionTtlMs: 2_000 });

  await assert.rejects(
    runtime.dispatch("browser_session_start", { goal: GOAL }),
    /No browser tab is shared/
  );

  const first = await armAndStart(runtime);
  assert.equal(first.goal, GOAL);
  assert.match(first.next, /browser_observe now/i);
  assert.equal(first.shared_tab.url, defaultTab().url);
  assert.equal(runtime.getStatus().sharedTab.tabId, defaultTab().id);
  assert.equal(runtime.getStatus().activeSessionCount, 1);

  await assert.rejects(
    runtime.dispatch("browser_session_start", { goal: "Competing lease" }),
    /already has an active external-control session/
  );

  clock.value += 2_001;
  const replacement = await runtime.dispatch("browser_session_start", { goal: "Lease after expiry" });
  assert.notEqual(replacement.session_id, first.session_id);

  await runtime.disarmTab();
  assert.equal(runtime.getStatus().armed, false);
  await assert.rejects(
    runtime.dispatch("browser_observe", { session_id: replacement.session_id }),
    /session is closed/
  );
});

test("guided MCP tools manage session, observation, retry, and operation identifiers internally", async () => {
  const driver = new FakeDriver({
    observations: [
      pageContext({ domRevision: 1 }),
      pageContext({ domRevision: 2 }),
      pageContext({ domRevision: 3, visibleText: "Settings saved" }),
      pageContext({ domRevision: 4, visibleText: "Settings saved" })
    ]
  });
  const { runtime } = await createRuntime({ driver });
  const client = { name: "Guided MCP client", version: "1.0.0" };
  await runtime.armTab(defaultTab());

  const begun = await runtime.dispatch("browser_begin", { goal: GOAL }, client);
  assert.equal(begun.status, "ready");
  assert.equal(begun.goal, GOAL);
  assert.equal(begun.intent.repeatPolicy, "once");
  assert.equal(begun.page.interactiveElements[0].ref, "e1");
  assert.equal(Object.hasOwn(begun, "session_id"), false);
  assert.equal(Object.hasOwn(begun, "observation_id"), false);

  const resumed = await runtime.dispatch("browser_begin", { goal: GOAL }, client);
  assert.equal(resumed.status, "ready");
  assert.equal(driver.observeCalls.length, 1, "resuming the same goal should reuse its current snapshot");
  await assert.rejects(
    runtime.dispatch("browser_continue", {}, { name: "Different MCP client" }),
    /belongs to another MCP client/
  );

  const screenshot = await runtime.dispatch("browser_screenshot", {}, client);
  assert.match(screenshot.data_url, /^data:image\/png/);

  const proposed = await runtime.dispatch("browser_act", { actions: [clickAction()] }, client);
  assert.equal(proposed.status, "approval_required");
  assert.equal(Object.hasOwn(proposed.operation, "session_id"), false);
  assert.equal(Object.hasOwn(proposed.operation, "operation_id"), false);

  const retried = await runtime.dispatch("browser_act", { actions: [clickAction()] }, client);
  assert.deepEqual(retried, proposed, "a retry must return the current proposal instead of duplicating it");
  assert.equal(runtime.listPendingOperations().length, 1);

  const pendingId = runtime.getStatus().pendingOperationIds[0];
  await runtime.approveOperation(pendingId);
  const continued = await runtime.dispatch("browser_continue", {}, client);
  assert.equal(continued.status, "ready");
  assert.match(continued.page.visibleText, /Settings saved/);
  assert.equal(driver.pageExecutions.length, 1);

  const secondProposed = await runtime.dispatch("browser_act", { actions: [clickAction()] }, client);
  assert.equal(secondProposed.status, "blocked");
  assert.match(secondProposed.next, /browser_end/i);
  const secondContinued = await runtime.dispatch("browser_continue", {}, client);
  assert.equal(secondContinued.status, "blocked");
  assert.match(secondContinued.next, /do not submit another action/i);
  assert.equal(runtime.listPendingOperations().length, 0);

  const ended = await runtime.dispatch("browser_end", {}, client);
  assert.deepEqual(ended.closed, true);
  assert.equal(ended.status, "closed");
  assert.equal(runtime.getStatus().sessionActive, false);
  const endedAgain = await runtime.dispatch("browser_end", {}, client);
  assert.equal(endedAgain.status, "idle");
});

test("an explicit repeated-effect intent allows the same semantic action up to its bound", async () => {
  const driver = new FakeDriver({
    observations: [
      pageContext({ domRevision: 1 }),
      pageContext({ domRevision: 2 }),
      pageContext({ domRevision: 3 }),
      pageContext({ domRevision: 4 }),
      pageContext({ domRevision: 5 })
    ]
  });
  const { runtime } = await createRuntime({
    driver,
    resolveGoalIntent: async ({ goal }) => ({
      version: "1.0",
      mode: "continue_prior",
      objective: `${goal} and repeat any unfinished earlier browser work`,
      contextSummary: "External goals have no prior task to continue.",
      repeatPolicy: "bounded",
      repeatLimit: 2,
      completionCriteria: ["The same requested effect succeeds twice."],
      reason: "The supplied test goal explicitly authorizes two occurrences."
    })
  });
  const client = { name: "Bounded repeat client" };
  await runtime.armTab(defaultTab());
  const begun = await runtime.dispatch("browser_begin", {
    goal: "Apply the same visible setting exactly twice"
  }, client);
  assert.equal(begun.intent.mode, "standalone");
  assert.equal(begun.intent.contextSummary, "");
  assert.equal(begun.intent.objective, "Apply the same visible setting exactly twice");
  assert.equal(begun.intent.repeatPolicy, "bounded");
  assert.equal(begun.intent.repeatLimit, 2);

  const first = await runtime.dispatch("browser_act", { actions: [clickAction()] }, client);
  await runtime.approveOperation(runtime.getStatus().pendingOperationIds[0]);
  assert.equal(first.status, "approval_required");
  await runtime.dispatch("browser_continue", {}, client);

  const second = await runtime.dispatch("browser_act", { actions: [clickAction()] }, client);
  assert.equal(second.status, "approval_required");
  await runtime.approveOperation(runtime.getStatus().pendingOperationIds[0]);
  await runtime.dispatch("browser_continue", {}, client);

  const third = await runtime.dispatch("browser_act", { actions: [clickAction()] }, client);
  assert.equal(third.status, "blocked");
  assert.equal(driver.pageExecutions.length, 2);
});

test("a failed guided operation is terminal and cannot inherit a later action request", async () => {
  const driver = new FakeDriver({
    observations: [
      pageContext({ domRevision: 1 }),
      pageContext({ domRevision: 2 })
    ]
  });
  let executionAttempts = 0;
  driver.executePage = async () => {
    executionAttempts += 1;
    throw new Error(JSON.stringify({
      error: { message: "Synthetic page execution failure" }
    }));
  };
  const { runtime } = await createRuntime({ driver });
  const client = { name: "Terminal failure client" };
  await runtime.armTab(defaultTab());
  await runtime.dispatch("browser_begin", { goal: "Save the visible setting once" }, client);

  const proposed = await runtime.dispatch("browser_act", { actions: [clickAction()] }, client);
  assert.equal(proposed.status, "approval_required");
  const failed = await runtime.approveOperation(runtime.getStatus().pendingOperationIds[0]);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "Synthetic page execution failure");
  assert.doesNotMatch(failed.error, /[{}]/);
  assert.equal(executionAttempts, 1);

  const continued = await runtime.dispatch("browser_continue", {}, client);
  assert.equal(continued.status, "failed");
  assert.match(continued.next, /browser_end/i);
  const laterAction = await runtime.dispatch("browser_act", {
    actions: [clickAction({ reason: "A later request must not revive the failed task" })]
  }, client);
  assert.equal(laterAction.status, "failed");
  assert.equal(executionAttempts, 1);

  const ended = await runtime.dispatch("browser_end", {}, client);
  assert.equal(ended.status, "closed");
});

test("the advanced workflow also rejects new proposals after a terminal failure", async () => {
  const driver = new FakeDriver({
    observations: [
      pageContext({ domRevision: 1 }),
      pageContext({ domRevision: 2 }),
      pageContext({ domRevision: 3 })
    ]
  });
  let executionAttempts = 0;
  driver.executePage = async () => {
    executionAttempts += 1;
    throw new Error("Synthetic advanced execution failure");
  };
  const { runtime } = await createRuntime({ driver });
  const session = await armAndStart(runtime);
  const firstObservation = await observe(runtime, session.session_id);
  const proposed = await runtime.dispatch("browser_execute", executionArgs(
    session.session_id,
    firstObservation.observation_id
  ));
  const failed = await runtime.approveOperation(proposed.operation_id);
  assert.equal(failed.status, "failed");
  assert.equal(executionAttempts, 1);

  const nextObservation = await observe(runtime, session.session_id);
  await assert.rejects(
    runtime.dispatch("browser_execute", executionArgs(
      session.session_id,
      nextObservation.observation_id,
      { idempotency_key: "request-after-terminal-failure" }
    )),
    /terminal state failed/
  );
  assert.equal(executionAttempts, 1);
});

test("bridge dispatch never exposes a structured internal error payload", async () => {
  const driver = new FakeDriver();
  driver.screenshot = async () => {
    throw new Error(JSON.stringify({
      status: "continue",
      actions: [{ type: "click", ref: "e1" }],
      elementSearch: { query: "next", roles: ["button"] }
    }));
  };
  const { runtime } = await createRuntime({ driver });
  const client = { name: "Structured error client" };
  await runtime.armTab(defaultTab());
  await runtime.dispatch("browser_begin", { goal: "Inspect the visible page once" }, client);

  await assert.rejects(
    runtime.dispatch("browser_screenshot", {}, client),
    (error) => {
      assert.match(error.message, /internal decision payload/);
      assert.doesNotMatch(error.message, /[{}]/);
      return true;
    }
  );
});

test("guided element discovery pages through every visible control and supports dynamic queries", async () => {
  const driver = new FakeDriver({
    observations: [
      pageContext({
        interactiveElements: [{ ...pageContext().interactiveElements[0], ref: "e1", label: "Grid row 1" }],
        interactiveElementStats: { total: 121, included: 80, visited: 80, truncated: true },
        elementDiscovery: {
          query: "",
          pageSize: 80,
          returned: 80,
          total: 121,
          visited: 80,
          remaining: 41,
          hasMore: true,
          nextCursor: "cursor-page-2"
        }
      }),
      pageContext({
        interactiveElements: [{ ...pageContext().interactiveElements[0], ref: "e121", label: "Next page" }],
        interactiveElementStats: { total: 121, included: 41, visited: 121, truncated: false },
        elementDiscovery: {
          query: "",
          pageSize: 80,
          returned: 41,
          total: 121,
          visited: 121,
          remaining: 0,
          hasMore: false,
          nextCursor: ""
        }
      }),
      pageContext({
        interactiveElements: [{ ...pageContext().interactiveElements[0], ref: "e1", label: "Next page" }],
        interactiveElementStats: { total: 1, availableTotal: 121, included: 1, visited: 1, truncated: false },
        elementDiscovery: {
          query: "next page",
          search: {
            query: "next page",
            roles: ["button"],
            nearText: "issue grid"
          },
          pageSize: 80,
          returned: 1,
          total: 1,
          availableTotal: 121,
          visited: 1,
          remaining: 0,
          hasMore: false,
          nextCursor: ""
        }
      })
    ]
  });
  const { runtime } = await createRuntime({ driver });
  const client = { name: "Discovery client", version: "1.0.0" };
  await runtime.armTab(defaultTab());

  const first = await runtime.dispatch("browser_begin", { goal: GOAL }, client);
  assert.equal(first.page.elementDiscovery.hasMore, true);
  assert.match(first.next, /browser_elements/i);

  const second = await runtime.dispatch("browser_elements", {}, client);
  assert.equal(second.page.interactiveElements[0].ref, "e121");
  assert.equal(second.page.elementDiscovery.hasMore, false);
  assert.equal(driver.observeCalls[1].options.elementCursor, "cursor-page-2");

  const searched = await runtime.dispatch("browser_elements", {
    query: "next page",
    roles: ["button"],
    near_text: "issue grid"
  }, client);
  assert.equal(searched.page.elementDiscovery.query, "next page");
  assert.equal(driver.observeCalls[2].options.elementQuery, "next page");
  assert.deepEqual(driver.observeCalls[2].options.elementRoles, ["button"]);
  assert.equal(driver.observeCalls[2].options.elementNearText, "issue grid");
  await assert.rejects(
    runtime.dispatch("browser_elements", { cursor: "forged-cursor" }, client),
    /must use nextCursor|No additional visible-element window/
  );

  const proposed = await runtime.dispatch("browser_act", {
    actions: [clickAction({ reason: "Open the searched next-page control" })]
  }, client);
  assert.equal(proposed.status, "approval_required");
  const operationId = runtime.getStatus().pendingOperationIds[0];
  const approved = await runtime.approveOperation(operationId);
  assert.equal(approved.status, "completed");
  assert.equal(driver.observeCalls[3].options.elementQuery, "next page");
  assert.deepEqual(driver.observeCalls[3].options.elementRoles, ["button"]);
  assert.equal(driver.observeCalls[3].options.elementNearText, "issue grid");
  assert.equal(
    driver.observeCalls[4].options.elementQuery,
    "",
    "post-action outcome observation should return to the complete viewport"
  );
});

test("browser_continue can force refresh and automatically invalidates snapshots after observation settings change", async () => {
  let maxElements = 80;
  const driver = new FakeDriver({
    observations: [
      pageContext({ visibleText: "first snapshot" }),
      pageContext({ visibleText: "forced snapshot" }),
      pageContext({ visibleText: "settings snapshot" })
    ]
  });
  const { runtime } = await createRuntime({
    driver,
    getSettings: async () => ({
      bridgeRequireApproval: true,
      stopOnSensitiveInput: true,
      redactSensitiveData: true,
      maxActionsPerTurn: 8,
      maxElements,
      maxTextChars: 16000
    })
  });
  const client = { name: "Refresh client", version: "1.0.0" };
  await runtime.armTab(defaultTab());

  await runtime.dispatch("browser_begin", { goal: GOAL }, client);
  await runtime.dispatch("browser_continue", {}, client);
  assert.equal(driver.observeCalls.length, 1, "an unchanged snapshot should remain cached");

  const forced = await runtime.dispatch("browser_continue", { refresh: true }, client);
  assert.match(forced.page.visibleText, /forced snapshot/);
  assert.equal(driver.observeCalls.length, 2);

  maxElements = 180;
  const settingsRefreshed = await runtime.dispatch("browser_continue", {}, client);
  assert.match(settingsRefreshed.page.visibleText, /settings snapshot/);
  assert.equal(driver.observeCalls.length, 3);
});

test("verified visual actions are extension-located, approved, and re-resolved on the latest screenshot", async () => {
  const initial = visualContext({
    visualObservation: undefined,
    automationCapabilities: {
      visualTargeting: { availableInObservation: false }
    }
  });
  const driver = new FakeDriver({
    observations: [initial, visualContext({ visibleText: "Page 2" })],
    visualResolutions: [visualResolution(930), visualResolution(940)]
  });
  const { runtime } = await createRuntime({ driver });
  const client = { name: "Visual client", version: "1.0.0" };
  await runtime.armTab(defaultTab());
  await runtime.dispatch("browser_begin", { goal: "Open page 2 of the grid" }, client);

  const proposed = await runtime.dispatch("browser_visual_act", {
    surface_ref: "v1",
    target_description: "문제점 조회 그리드 하단의 다음 페이지 버튼",
    reason: "2페이지를 조회"
  }, client);
  assert.equal(proposed.status, "approval_required");
  assert.equal(driver.pageExecutions.length, 0);
  assert.equal(driver.visualResolutionCalls.length, 1);
  assert.equal(driver.visualResolutionCalls[0].request.targetDescription, "문제점 조회 그리드 하단의 다음 페이지 버튼");

  const pendingId = runtime.getStatus().pendingOperationIds[0];
  const completed = await runtime.approveOperation(pendingId);
  assert.equal(completed.status, "completed");
  assert.equal(driver.visualResolutionCalls.length, 2, "approval must trigger a fresh screenshot-bound resolution");
  assert.equal(driver.pageExecutions.length, 1);
  assert.equal(driver.pageExecutions[0].actions[0].type, "visual_click");
  assert.equal(driver.pageExecutions[0].actions[0].xNormalized, 940);
});

test("a changed visual surface invalidates approval instead of clicking a re-bound ref", async () => {
  const changedResolution = visualResolution(950);
  changedResolution.context.visualSurfaces[0].label = "Different application surface";
  const driver = new FakeDriver({
    observations: [visualContext({ visualObservation: undefined })],
    visualResolutions: [visualResolution(930), changedResolution]
  });
  const { runtime } = await createRuntime({ driver });
  const client = { name: "Visual stale client", version: "1.0.0" };
  await runtime.armTab(defaultTab());
  await runtime.dispatch("browser_begin", { goal: "Open page 2 of the grid" }, client);
  await runtime.dispatch("browser_visual_act", {
    surface_ref: "v1",
    target_description: "다음 페이지 버튼"
  }, client);

  const result = await runtime.approveOperation(runtime.getStatus().pendingOperationIds[0]);
  assert.equal(result.status, "stale");
  assert.match(result.error, /visual surface changed/i);
  assert.equal(driver.pageExecutions.length, 0);
});

test("browser status returns a state-derived next step for MCP clients", async () => {
  const { runtime } = await createRuntime();
  const disconnected = await runtime.dispatch("browser_status", {});
  assert.match(disconnected.next, /share the intended tab/i);

  await runtime.armTab(defaultTab());
  const ready = await runtime.dispatch("browser_status", {});
  assert.match(ready.next, /browser_session_start now/i);

  await runtime.dispatch("browser_session_start", { goal: GOAL });
  const leased = await runtime.dispatch("browser_status", {});
  assert.match(leased.next, /session is already active/i);
});

test("shared-tab status and session startup redact URL credentials and secret parameters", async () => {
  const secret = "private-runtime-token";
  const privateTab = defaultTab({
    title: `Dashboard token=${secret}`,
    url: `https://user:password@example.test/settings?token=${secret}&view=main`
  });
  const { runtime, storage } = await createRuntime({
    driver: new FakeDriver({ tabs: [privateTab] })
  });
  await runtime.armTab(privateTab);

  const status = runtime.getStatus();
  const session = await runtime.dispatch("browser_session_start", { goal: GOAL });
  const serialized = JSON.stringify({ status, session, storage: storage.snapshot() });

  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, /user:password/);
  assert.match(status.sharedTab.url, /token=%5Bredacted%5D/);
  assert.equal(session.goal, GOAL);
  assert.equal(session.shared_tab.url, status.sharedTab.url);
});

test("browser observations expose only the shared page and omit unrelated tab inventory", async () => {
  const sharedSecret = "shared-runtime-token-value-1234567890";
  const unrelatedSecret = "unrelated-runtime-token-value-1234567890";
  const sharedUrl = `https://example.test/settings?token=${sharedSecret}`;
  const unrelatedUrl = `https://private.example.test/account;jsessionid=${unrelatedSecret}`;
  const observationContext = pageContext({
    url: sharedUrl,
    browser: {
      windowId: 8,
      targetTabId: defaultTab().id,
      tabs: [
        { tabId: defaultTab().id, title: "Shared settings", url: sharedUrl },
        { tabId: 99, title: `Private account ${unrelatedSecret}`, url: unrelatedUrl }
      ],
      downloads: [{ id: 7, filename: "private-report.pdf" }]
    }
  });
  const storage = new MemoryStorage();
  const { runtime } = await createRuntime({
    storage,
    driver: new FakeDriver({ observations: [observationContext] })
  });
  const session = await armAndStart(runtime);
  const observation = await observe(runtime, session.session_id);
  const serializedClient = JSON.stringify(observation);
  const serializedStorage = JSON.stringify(storage.snapshot());

  assert.equal(Object.hasOwn(observation.context, "browser"), false);
  assert.match(observation.context.url, /token=%5Bredacted%5D/);
  for (const serialized of [serializedClient, serializedStorage]) {
    assert.doesNotMatch(serialized, new RegExp(sharedSecret));
    assert.doesNotMatch(serialized, new RegExp(unrelatedSecret));
    assert.doesNotMatch(serialized, /private-report\.pdf/);
    assert.doesNotMatch(serialized, /private\.example\.test/);
  }
});

test("browser_execute must bind to the latest observation", async () => {
  const { runtime } = await createRuntime({
    driver: new FakeDriver({ observations: [pageContext(), pageContext({ domRevision: 2 })] })
  });
  const session = await armAndStart(runtime);

  await assert.rejects(
    runtime.dispatch("browser_execute", executionArgs(session.session_id, "observation-never-issued")),
    /must reference the latest observation/
  );

  const first = await observe(runtime, session.session_id);
  const second = await observe(runtime, session.session_id);
  assert.notEqual(first.observation_id, second.observation_id);

  await assert.rejects(
    runtime.dispatch("browser_execute", executionArgs(session.session_id, first.observation_id)),
    /must reference the latest observation/
  );
});

test("a state-changing proposal waits for trusted approval and re-observes before execution", async () => {
  const driver = new FakeDriver({
    observations: [
      pageContext({ domRevision: 1 }),
      pageContext({ domRevision: 2 }),
      pageContext({ domRevision: 3, visibleText: "Settings saved" })
    ]
  });
  const { runtime } = await createRuntime({ driver });
  const session = await armAndStart(runtime);
  const observation = await observe(runtime, session.session_id);

  const proposed = await runtime.dispatch(
    "browser_execute",
    executionArgs(session.session_id, observation.observation_id)
  );

  assert.equal(proposed.status, "waiting_approval");
  assert.equal(proposed.approval.required, true);
  assert.equal(driver.pageExecutions.length, 0);
  assert.deepEqual(runtime.getStatus().pendingOperationIds, [proposed.operation_id]);

  const completed = await runtime.approveOperation(proposed.operation_id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.approval.required, false);
  assert.ok(completed.evidence.id);
  assert.equal(driver.observeCalls.length, 3, "initial, pre-execution, and post-execution observations are required");
  assert.equal(driver.pageExecutions.length, 1);
  assert.equal(driver.pageExecutions[0].tabId, defaultTab().id);
  assert.equal(driver.pageExecutions[0].actions[0].type, "click");

  const verified = await observe(runtime, session.session_id);
  assert.match(verified.next, /browser_session_close now/i);
  const closed = await runtime.dispatch("browser_session_close", { session_id: session.session_id });
  assert.match(closed.next, /final answer now/i);
});

test("a changed target makes an approved operation stale without executing it", async () => {
  const driver = new FakeDriver({
    observations: [
      pageContext(),
      pageContext({ element: { label: "Delete account", disabled: true } })
    ]
  });
  const { runtime } = await createRuntime({ driver });
  const session = await armAndStart(runtime);
  const observation = await observe(runtime, session.session_id);
  const proposed = await runtime.dispatch(
    "browser_execute",
    executionArgs(session.session_id, observation.observation_id)
  );

  const result = await runtime.approveOperation(proposed.operation_id);

  assert.equal(result.status, "stale");
  assert.match(result.error, /target changed or disappeared/);
  assert.equal(driver.pageExecutions.length, 0);
  assert.equal(driver.browserExecutions.length, 0);
});

test("idempotency returns the original operation and rejects mismatched key reuse", async () => {
  let policyCalls = 0;
  const driver = new FakeDriver({ observations: [pageContext(), pageContext(), pageContext()] });
  const { runtime } = await createRuntime({
    driver,
    evaluatePolicy: async () => {
      policyCalls += 1;
      return {
        version: "1.0",
        verdict: "allow",
        message: "Allowed",
        risks: [],
        sensitiveData: [],
        approvalReasons: []
      };
    }
  });
  const session = await armAndStart(runtime);
  const observation = await observe(runtime, session.session_id);
  const args = executionArgs(session.session_id, observation.observation_id);

  const first = await runtime.dispatch("browser_execute", args);
  const retryWhilePending = await runtime.dispatch("browser_execute", clone(args));
  assert.equal(retryWhilePending.operation_id, first.operation_id);
  assert.equal(policyCalls, 1);

  await assert.rejects(
    runtime.dispatch("browser_execute", {
      ...clone(args),
      actions: [clickAction({ reason: "A different material proposal" })]
    }),
    /idempotency key was already used for a different proposal/
  );

  const completed = await runtime.approveOperation(first.operation_id);
  assert.equal(completed.status, "completed");
  assert.equal(driver.pageExecutions.length, 1);

  const retryAfterCompletion = await runtime.dispatch("browser_execute", clone(args));
  assert.equal(retryAfterCompletion.operation_id, first.operation_id);
  assert.equal(retryAfterCompletion.status, "completed");
  assert.equal(driver.pageExecutions.length, 1, "a completed request must never be replayed");
  assert.equal(policyCalls, 1);
});

test("sensitive fill is blocked and plaintext is not retained in runtime state", async () => {
  const storage = new MemoryStorage();
  const driver = new FakeDriver({ observations: [sensitiveContext()] });
  const { runtime } = await createRuntime({ storage, driver });
  const session = await armAndStart(runtime);
  const observation = await observe(runtime, session.session_id);
  const secret = "replacement-secret-that-must-not-persist";

  const result = await runtime.dispatch("browser_execute", executionArgs(
    session.session_id,
    observation.observation_id,
    {
      actions: [{
        type: "fill",
        ref: "e1",
        value: secret,
        reason: "Enter the current password"
      }]
    }
  ));

  assert.equal(result.status, "blocked");
  assert.match(result.error, /Sensitive input is blocked/);
  assert.equal(result.actions[0].value, "[redacted]");
  assert.equal(driver.pageExecutions.length, 0);
  assert.doesNotMatch(JSON.stringify(storage.snapshot()), new RegExp(secret));
});

test("external approval and policy fields are rejected by the schema and action normalizer", async () => {
  const executeTool = Protocol.getToolDefinitions({ advanced: true })
    .find((tool) => tool.name === "browser_execute");
  for (const field of ["approval", "approved", "needsUserApproval", "policy", "preconditions", "safety"] ) {
    assert.equal(Object.hasOwn(executeTool.inputSchema.properties, field), false);
  }
  assert.equal(executeTool.inputSchema.additionalProperties, false);

  const forgedTopLevelInput = {
    session_id: "session-forged",
    observation_id: "observation-forged",
    idempotency_key: "request-forged",
    actions: [clickAction()],
    approved: true,
    policy: { verdict: "allow" }
  };
  const schemaErrors = Core.validateJsonAgainstSchema(
    forgedTopLevelInput,
    executeTool.inputSchema,
    "browser_execute arguments"
  );
  assert.ok(schemaErrors.some((error) => error.includes("approved")));
  assert.ok(schemaErrors.some((error) => error.includes("policy")));

  for (const field of ["approval", "approved", "needsUserApproval", "policy", "preconditions"] ) {
    assert.throws(
      () => Contract.normalizeExternalActions([clickAction({ [field]: true })]),
      /external clients cannot set/
    );
  }

  const { runtime } = await createRuntime();
  const session = await armAndStart(runtime);
  const observation = await observe(runtime, session.session_id);

  const forgedTopLevelFields = {
    approval: { granted: true },
    approved: true,
    needsUserApproval: false,
    policy: { verdict: "allow" },
    settings: { bridgeRequireApproval: false },
    preconditions: [],
    safety: { blocked: false }
  };
  for (const [field, forgedValue] of Object.entries(forgedTopLevelFields)) {
    await assert.rejects(
      runtime.dispatch("browser_execute", {
        ...executionArgs(session.session_id, observation.observation_id),
        [field]: forgedValue
      }),
      new RegExp(field),
      `runtime dispatch must reject forged top-level ${field}`
    );
  }

  await assert.rejects(
    runtime.dispatch("browser_execute", executionArgs(session.session_id, observation.observation_id, {
      actions: [clickAction({ approved: true })]
    })),
    /approved/
  );
});

test("restart marks an executing operation unknown and never replays it", async () => {
  const storage = new MemoryStorage();
  const firstDriver = new FakeDriver({ observations: [pageContext()] });
  const first = await createRuntime({ storage, driver: firstDriver });
  const session = await armAndStart(first.runtime);
  const observation = await observe(first.runtime, session.session_id);
  const args = executionArgs(session.session_id, observation.observation_id);
  const proposed = await first.runtime.dispatch("browser_execute", args);

  const persisted = storage.data.externalControlRuntimeV1;
  persisted.operations[proposed.operation_id].status = "executing";
  persisted.operations[proposed.operation_id].startedAt = first.clock.value;

  const restartedDriver = new FakeDriver({ observations: [pageContext()] });
  const restarted = await createRuntime({
    storage,
    driver: restartedDriver,
    clock: first.clock,
    randomId: createIdFactory()
  });
  const recovered = await restarted.runtime.dispatch("browser_operation_get", {
    session_id: session.session_id,
    operation_id: proposed.operation_id
  });

  assert.equal(recovered.status, "unknown_after_restart");
  assert.match(recovered.error, /was not retried/);
  assert.equal(restartedDriver.pageExecutions.length, 0);
  assert.equal(restartedDriver.browserExecutions.length, 0);

  const retry = await restarted.runtime.dispatch("browser_execute", clone(args));
  assert.equal(retry.operation_id, proposed.operation_id);
  assert.equal(retry.status, "unknown_after_restart");
  assert.equal(restartedDriver.pageExecutions.length, 0);
  await assert.rejects(
    restarted.runtime.approveOperation(proposed.operation_id),
    /not waiting for approval/
  );
});

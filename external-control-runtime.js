(function initializeExternalControlRuntime(globalScope) {
  "use strict";

  const Contract = globalScope.WebExecutionContract
    || (typeof require === "function" ? require("./execution-contract.js") : null);
  const Protocol = globalScope.WebBridgeProtocol
    || (typeof require === "function" ? require("./bridge-protocol.js") : null);
  if (!Contract || !Protocol) {
    throw new Error("Execution contract and bridge protocol must load before external-control-runtime.js.");
  }

  const DEFAULT_STORAGE_KEY = "externalControlRuntimeV1";
  const PAGE_ACTION_TYPES = new Set(
    Contract.EXTERNAL_ACTION_TYPES.filter((type) => type !== "tab_open")
  );

  class ExternalControlRuntime {
    constructor(options = {}) {
      if (!options.storage || !options.driver) {
        throw new Error("ExternalControlRuntime requires storage and a browser driver.");
      }
      this.storage = options.storage;
      this.driver = options.driver;
      this.evaluatePolicy = options.evaluatePolicy || (async () => ({
        version: "1.0",
        verdict: "approval",
        message: "No independent policy evaluator is configured.",
        risks: [],
        sensitiveData: [],
        approvalReasons: ["Policy evaluation is unavailable, so approval is required."]
      }));
      this.getSettings = options.getSettings || (async () => ({}));
      this.onStatusChange = options.onStatusChange || (() => {});
      this.storageKey = options.storageKey || DEFAULT_STORAGE_KEY;
      this.now = options.now || (() => Date.now());
      this.randomId = options.randomId || createRandomId;
      this.sessionTtlMs = normalizeDuration(options.sessionTtlMs, 15 * 60 * 1000);
      this.approvalTtlMs = normalizeDuration(options.approvalTtlMs, 5 * 60 * 1000);
      this.maxOperations = normalizePositiveInteger(options.maxOperations, 100);
      this.state = createEmptyState();
      this.ready = false;
      this.transaction = Promise.resolve();
    }

    async initialize() {
      return this.#serialize(async () => {
        const stored = await this.#storageGet();
        this.state = normalizeState(stored);
        const now = this.now();
        for (const operation of Object.values(this.state.operations)) {
          if (operation.status === "executing") {
            operation.status = "unknown_after_restart";
            operation.completedAt = now;
            operation.error = "The extension service worker restarted while execution was in progress. The action was not retried.";
            delete operation.actions;
          }
        }
        this.#expireState(now);
        await this.#persist();
        this.ready = true;
        return this.getStatus();
      });
    }

    async armTab(tab) {
      return this.#serialize(async () => {
        this.#assertReady();
        if (!tab || !Number.isInteger(Number(tab.id))) {
          throw new Error("A valid tab is required.");
        }
        const tabId = Number(tab.id);
        if (this.state.armedTab?.tabId !== tabId) {
          this.#closeAllSessions("The user shared a different tab.");
        }
        this.state.armedTab = {
          tabId,
          windowId: Number.isInteger(Number(tab.windowId)) ? Number(tab.windowId) : null,
          title: redactExternalText(tab.title),
          url: sanitizeExternalUrl(tab.url),
          armedAt: this.now()
        };
        await this.#persistAndNotify();
        return this.getStatus();
      });
    }

    async disarmTab() {
      return this.#serialize(async () => {
        this.#assertReady();
        this.#closeAllSessions("The user stopped sharing the tab.");
        this.state.armedTab = null;
        await this.#persistAndNotify();
        return this.getStatus();
      });
    }

    getStatus() {
      this.#expireState(this.now());
      const activeSessions = Object.values(this.state.sessions).filter((session) => session.status === "active");
      const pendingApprovals = Object.values(this.state.operations).filter(
        (operation) => operation.status === "waiting_approval"
      );
      return {
        armed: Boolean(this.state.armedTab),
        sharedTab: this.state.armedTab
          ? {
              ...this.state.armedTab,
              title: redactExternalText(this.state.armedTab.title),
              url: sanitizeExternalUrl(this.state.armedTab.url)
            }
          : null,
        sessionActive: activeSessions.length > 0,
        activeSessionCount: activeSessions.length,
        pendingApprovalCount: pendingApprovals.length,
        pendingOperationIds: pendingApprovals.map((operation) => operation.id),
        updatedAt: this.state.updatedAt || 0
      };
    }

    listPendingOperations() {
      this.#expireState(this.now());
      return Object.values(this.state.operations)
        .filter((operation) => operation.status === "waiting_approval")
        .sort((left, right) => left.createdAt - right.createdAt)
        .map((operation) => this.#publicOperation(operation));
    }

    async approveOperation(operationId) {
      return this.#serialize(async () => {
        this.#assertReady();
        const operation = this.#requireOperation(operationId);
        if (operation.status !== "waiting_approval") {
          throw new Error(`Operation ${operationId} is not waiting for approval.`);
        }
        if (operation.approvalExpiresAt <= this.now()) {
          operation.status = "expired";
          operation.error = "The approval request expired before the user approved it.";
          delete operation.actions;
          await this.#persistAndNotify();
          return this.#publicOperation(operation);
        }
        operation.approvalGrant = {
          operationId: operation.id,
          effectDigest: operation.effectDigest,
          observationId: operation.observationId,
          targetTabId: operation.targetTabId,
          documentId: operation.observedDocumentId,
          expiresAt: operation.approvalExpiresAt,
          grantedAt: this.now()
        };
        operation.status = "approved";
        await this.#persistAndNotify();
        return this.#commitOperation(operation);
      });
    }

    async rejectOperation(operationId, reason = "The user rejected this operation.") {
      return this.#serialize(async () => {
        this.#assertReady();
        const operation = this.#requireOperation(operationId);
        if (!['waiting_approval', 'approved'].includes(operation.status)) {
          throw new Error(`Operation ${operationId} cannot be rejected in state ${operation.status}.`);
        }
        operation.status = "rejected";
        operation.completedAt = this.now();
        operation.error = stringValue(reason) || "The user rejected this operation.";
        delete operation.actions;
        delete operation.approvalGrant;
        await this.#persistAndNotify();
        return this.#publicOperation(operation);
      });
    }

    async dispatch(toolName, args = {}, client = {}) {
      return this.#serialize(async () => {
        this.#assertReady();
        this.#expireState(this.now());
        const inputValidation = Protocol.validateToolArguments(toolName, args);
        if (!inputValidation.valid) {
          throw new Error(`Invalid ${toolName || "bridge tool"} input: ${inputValidation.errors.join(" ")}`);
        }
        switch (toolName) {
          case "browser_status":
            return this.#getClientStatus();
          case "browser_session_start":
            return this.#startSession(args, client);
          case "browser_observe":
            return this.#observe(args);
          case "browser_screenshot":
            return this.#screenshot(args);
          case "browser_execute":
            return this.#proposeExecution(args);
          case "browser_operation_get":
            return this.#getOperation(args);
          case "browser_session_close":
            return this.#closeSession(args);
          default:
            throw new Error(`Unsupported bridge tool: ${toolName || "missing"}`);
        }
      });
    }

    async #startSession(args, client) {
      const armedTab = await this.#requireArmedTab();
      const goal = boundedString(args.goal, 4000, "goal");
      const now = this.now();
      const activeSession = Object.values(this.state.sessions).find((session) => session.status === "active");
      if (activeSession) {
        throw new Error("The shared tab already has an active external-control session.");
      }
      const id = this.randomId("session");
      this.state.sessions[id] = {
        id,
        status: "active",
        goal,
        clientId: boundedOptionalString(client.id || client.clientId, 160),
        clientName: boundedOptionalString(client.name || client.clientName, 160),
        targetTabId: armedTab.id,
        createdAt: now,
        lastActiveAt: now,
        expiresAt: now + this.sessionTtlMs,
        latestObservationId: "",
        observation: null
      };
      await this.#persistAndNotify();
      return {
        session_id: id,
        goal,
        expires_at: new Date(now + this.sessionTtlMs).toISOString(),
        shared_tab: summarizeSharedTab(armedTab),
        next: "Call browser_observe now. Do not end with only a progress announcement."
      };
    }

    #getClientStatus() {
      const status = this.getStatus();
      let next;
      if (!status.armed) {
        next = "Ask the user to connect the extension and share the intended tab.";
      } else if (status.sessionActive) {
        next = "A session is already active. Continue it only if you own its session_id; otherwise ask the user to release it.";
      } else {
        next = "Call browser_session_start now. Do not end with only a progress announcement.";
      }
      return { ...status, next };
    }

    async #observe(args, options = {}) {
      const session = this.#requireSession(args.session_id);
      const context = await this.#collectObservation(session.targetTabId);
      const observationId = this.randomId("observation");
      const now = this.now();
      session.latestObservationId = observationId;
      session.observation = {
        id: observationId,
        observedAt: now,
        context
      };
      this.#touchSession(session, now);
      await this.#persistAndNotify();
      const hasCompletedOperation = Object.values(this.state.operations).some(
        (operation) => operation.sessionId === session.id && operation.status === "completed"
      );
      return {
        observation_id: observationId,
        observed_at: new Date(now).toISOString(),
        context: sanitizeObservationForClient(context),
        next: hasCompletedOperation
          ? "A completed operation exists for this session. If this observation verifies the requested outcome, call browser_session_close now before returning any user-facing text. Otherwise, submit only the corrective action using this observation_id."
          : "If the objective is incomplete, call browser_execute using this exact observation_id and refs from this context. If it is already complete, call browser_session_close before returning user-facing text.",
        ...(options.internal ? { internalContext: context } : {})
      };
    }

    async #screenshot(args) {
      const session = this.#requireSession(args.session_id);
      await this.#requireBoundTab(session);
      const capture = await this.driver.screenshot(session.targetTabId);
      this.#touchSession(session, this.now());
      await this.#persistAndNotify();
      if (typeof capture === "string") {
        return { data_url: capture };
      }
      return capture;
    }

    async #proposeExecution(args) {
      const session = this.#requireSession(args.session_id);
      await this.#requireBoundTab(session);
      const goal = session.goal;
      const observationId = boundedString(args.observation_id, 160, "observation_id");
      const idempotencyKey = boundedString(args.idempotency_key, 160, "idempotency_key");
      const settings = await this.getSettings();
      const maxActions = normalizePositiveInteger(settings.maxActionsPerTurn, 8);
      const normalizedForIdempotency = Contract.normalizeExternalActions(args.actions, { maxActions });
      const digest = Contract.effectDigest(normalizedForIdempotency);
      const idempotencyIndexKey = `${session.id}:${idempotencyKey}`;
      const priorId = this.state.idempotency[idempotencyIndexKey];
      if (priorId) {
        const prior = this.#requireOperation(priorId);
        if (prior.effectDigest !== digest || prior.observationId !== observationId) {
          throw new Error("The idempotency key was already used for a different proposal.");
        }
        return this.#publicOperation(prior);
      }
      if (!session.observation || session.latestObservationId !== observationId) {
        throw new Error("browser_execute must reference the latest observation returned by browser_observe.");
      }
      const validation = Contract.validateExternalActions(args.actions, session.observation.context, { maxActions });
      if (!validation.valid) {
        throw new Error(`The action proposal is invalid: ${validation.errors.join(" ")}`);
      }
      const actions = validation.actions;

      let policy;
      try {
        policy = await this.evaluatePolicy({
          goal,
          actions: Contract.sanitizeActions(actions),
          context: sanitizeObservationForPolicy(session.observation.context),
          session: summarizeSession(session),
          settings: sanitizePolicySettings(settings)
        });
      } catch (error) {
        policy = {
          version: "1.0",
          verdict: "approval",
          message: `Independent policy evaluation failed: ${error.message || String(error)}`,
          risks: ["The proposal could not be independently classified."],
          sensitiveData: [],
          approvalReasons: ["Policy failure is handled fail-closed with explicit user approval."]
        };
      }
      const normalizedPolicy = normalizePolicy(policy);
      const safety = Contract.assessActionSafety({
        actions,
        context: session.observation.context,
        settings,
        policy: normalizedPolicy,
        validation
      });
      const now = this.now();
      const operationId = this.randomId("operation");
      const preconditions = Contract.buildActionPreconditions(actions, session.observation.context);
      const operation = {
        id: operationId,
        sessionId: session.id,
        idempotencyKey,
        observationId,
        observedDocumentId: stringValue(session.observation.context.documentId),
        observedPageUrl: stringValue(session.observation.context.url),
        targetTabId: session.targetTabId,
        goal,
        effectDigest: digest,
        actionSummary: Contract.sanitizeActions(actions),
        targetSummary: actions.map((action) => ({
          actionId: action.id,
          target: sanitizeTargetForClient(Contract.findActionTarget(action, session.observation.context))
        })),
        actions,
        preconditions,
        policy: sanitizePolicy(normalizedPolicy),
        safety: {
          blockedReasons: safety.blockedReasons,
          approvalReasons: safety.approvalReasons,
          warnings: safety.warnings
        },
        status: safety.blocked ? "blocked" : safety.requiresApproval ? "waiting_approval" : "ready",
        createdAt: now,
        approvalExpiresAt: now + this.approvalTtlMs,
        completedAt: safety.blocked ? now : 0,
        error: safety.blocked ? safety.blockedReasons.join(" ") : ""
      };
      if (safety.blocked) {
        delete operation.actions;
      }
      this.state.operations[operationId] = operation;
      this.state.idempotency[idempotencyIndexKey] = operationId;
      this.#trimOperations();
      this.#touchSession(session, now);
      await this.#persistAndNotify();

      if (operation.status === "ready") {
        return this.#commitOperation(operation);
      }
      return this.#publicOperation(operation);
    }

    async #commitOperation(operation) {
      if (!['ready', 'approved'].includes(operation.status)) {
        return this.#publicOperation(operation);
      }
      const session = this.#requireSession(operation.sessionId);
      await this.#requireBoundTab(session);
      if (operation.effectDigest !== Contract.effectDigest(operation.actions || [])) {
        operation.status = "blocked";
        operation.error = "The action proposal changed after policy review.";
        operation.completedAt = this.now();
        delete operation.actions;
        delete operation.approvalGrant;
        await this.#persistAndNotify();
        return this.#publicOperation(operation);
      }
      if (operation.status === "approved") {
        const grant = operation.approvalGrant;
        const grantValid = grant
          && grant.operationId === operation.id
          && grant.effectDigest === operation.effectDigest
          && grant.observationId === operation.observationId
          && grant.targetTabId === operation.targetTabId
          && grant.documentId === operation.observedDocumentId
          && grant.expiresAt > this.now();
        if (!grantValid) {
          operation.status = "blocked";
          operation.error = "The approval grant no longer matches this operation.";
          operation.completedAt = this.now();
          delete operation.actions;
          delete operation.approvalGrant;
          await this.#persistAndNotify();
          return this.#publicOperation(operation);
        }
      }

      operation.status = "executing";
      operation.startedAt = this.now();
      await this.#persistAndNotify();
      try {
        const freshContext = await this.#collectObservation(operation.targetTabId);
        const preconditionResult = Contract.validateActionPreconditions({
          actions: operation.actions,
          preconditions: operation.preconditions,
          observedDocumentId: operation.observedDocumentId,
          observedPageUrl: operation.observedPageUrl
        }, freshContext);
        if (!preconditionResult.valid) {
          operation.status = "stale";
          operation.error = preconditionResult.errors.join(" ");
          operation.completedAt = this.now();
          delete operation.actions;
          delete operation.approvalGrant;
          await this.#persistAndNotify();
          return this.#publicOperation(operation);
        }

        const pageActions = operation.actions.filter((action) => PAGE_ACTION_TYPES.has(action.type));
        const browserActions = operation.actions.filter((action) => !PAGE_ACTION_TYPES.has(action.type));
        let executionResult;
        if (pageActions.length && browserActions.length) {
          throw new Error("Page actions and browser actions cannot execute in one operation.");
        }
        if (browserActions.length) {
          executionResult = await this.driver.executeBrowser(operation.targetTabId, cloneJson(browserActions));
        } else {
          executionResult = await this.driver.executePage(operation.targetTabId, cloneJson(pageActions));
        }
        if (typeof this.driver.waitAfterExecution === "function") {
          await this.driver.waitAfterExecution(executionResult);
        }
        const postContext = await this.#collectObservation(operation.targetTabId);
        const evidenceId = this.randomId("evidence");
        const completedAt = this.now();
        operation.status = "completed";
        operation.completedAt = completedAt;
        operation.result = sanitizeExecutionResult(executionResult);
        operation.evidence = {
          id: evidenceId,
          observedAt: completedAt,
          documentId: stringValue(postContext.documentId),
          url: stringValue(postContext.url),
          contextDigest: Contract.contextDigest(postContext)
        };
        session.latestObservationId = "";
        session.observation = null;
        this.#touchSession(session, completedAt);
        delete operation.actions;
        delete operation.approvalGrant;
        await this.#persistAndNotify();
        return this.#publicOperation(operation);
      } catch (error) {
        operation.status = "failed";
        operation.completedAt = this.now();
        operation.error = error.message || String(error);
        delete operation.actions;
        delete operation.approvalGrant;
        await this.#persistAndNotify();
        return this.#publicOperation(operation);
      }
    }

    #getOperation(args) {
      const session = this.#requireSession(args.session_id, { allowExpired: true });
      const operation = this.#requireOperation(args.operation_id);
      if (operation.sessionId !== session.id) {
        throw new Error("The operation does not belong to this session.");
      }
      return this.#publicOperation(operation);
    }

    async #closeSession(args) {
      const session = this.#requireSession(args.session_id, { allowExpired: true });
      session.status = "closed";
      session.closedAt = this.now();
      session.observation = null;
      session.latestObservationId = "";
      for (const operation of Object.values(this.state.operations)) {
        if (operation.sessionId === session.id && ['waiting_approval', 'approved', 'ready'].includes(operation.status)) {
          operation.status = "cancelled";
          operation.completedAt = this.now();
          operation.error = "The external-control session was closed.";
          delete operation.actions;
          delete operation.approvalGrant;
        }
      }
      await this.#persistAndNotify();
      return {
        closed: true,
        session_id: session.id,
        next: "The browser lease is released. Return the concise evidence-based final answer now."
      };
    }

    async #collectObservation(tabId) {
      const context = await this.driver.observe(tabId, {
        redactSensitiveData: true
      });
      return sanitizeObservationForStorage(context);
    }

    async #requireArmedTab() {
      if (!this.state.armedTab) {
        throw new Error("No browser tab is shared. Ask the user to attach the current tab in the extension.");
      }
      let tab;
      try {
        tab = await this.driver.getTab(this.state.armedTab.tabId);
      } catch {
        tab = null;
      }
      if (!tab?.id) {
        this.#closeAllSessions("The shared browser tab is no longer available.");
        this.state.armedTab = null;
        await this.#persistAndNotify();
        throw new Error("The shared browser tab is no longer available.");
      }
      return tab;
    }

    async #requireBoundTab(session) {
      const tab = await this.#requireArmedTab();
      if (Number(tab.id) !== Number(session.targetTabId)) {
        throw new Error("The external-control session is not bound to the currently shared tab.");
      }
      return tab;
    }

    #requireSession(sessionId, options = {}) {
      const id = boundedString(sessionId, 160, "session_id");
      const session = this.state.sessions[id];
      if (!session) {
        throw new Error("Unknown external-control session.");
      }
      if (!options.allowExpired && session.status !== "active") {
        throw new Error(`The external-control session is ${session.status}.`);
      }
      if (!options.allowExpired && session.expiresAt <= this.now()) {
        session.status = "expired";
        session.observation = null;
        throw new Error("The external-control session expired.");
      }
      return session;
    }

    #requireOperation(operationId) {
      const id = boundedString(operationId, 160, "operation_id");
      const operation = this.state.operations[id];
      if (!operation) {
        throw new Error("Unknown browser operation.");
      }
      return operation;
    }

    #touchSession(session, now) {
      session.lastActiveAt = now;
      session.expiresAt = now + this.sessionTtlMs;
    }

    #expireState(now) {
      for (const session of Object.values(this.state.sessions)) {
        if (session.status === "active" && session.expiresAt <= now) {
          session.status = "expired";
          session.observation = null;
          session.latestObservationId = "";
        }
      }
      for (const operation of Object.values(this.state.operations)) {
        if (operation.status === "waiting_approval" && operation.approvalExpiresAt <= now) {
          operation.status = "expired";
          operation.completedAt = now;
          operation.error = "The approval request expired.";
          delete operation.actions;
          delete operation.approvalGrant;
        }
      }
    }

    #closeAllSessions(reason) {
      const now = this.now();
      for (const session of Object.values(this.state.sessions)) {
        if (session.status === "active") {
          session.status = "closed";
          session.closedAt = now;
          session.observation = null;
          session.latestObservationId = "";
        }
      }
      for (const operation of Object.values(this.state.operations)) {
        if (['waiting_approval', 'approved', 'ready'].includes(operation.status)) {
          operation.status = "cancelled";
          operation.completedAt = now;
          operation.error = reason;
          delete operation.actions;
          delete operation.approvalGrant;
        }
      }
    }

    #trimOperations() {
      const operations = Object.values(this.state.operations).sort((left, right) => right.createdAt - left.createdAt);
      for (const operation of operations.slice(this.maxOperations)) {
        if (['waiting_approval', 'approved', 'executing'].includes(operation.status)) {
          continue;
        }
        delete this.state.operations[operation.id];
        delete this.state.idempotency[`${operation.sessionId}:${operation.idempotencyKey}`];
      }
    }

    #publicOperation(operation) {
      return {
        operation_id: operation.id,
        session_id: operation.sessionId,
        status: operation.status,
        created_at: toIso(operation.createdAt),
        completed_at: operation.completedAt ? toIso(operation.completedAt) : null,
        actions: cloneJson(operation.actionSummary || []),
        targets: cloneJson(operation.targetSummary || []),
        policy: cloneJson(operation.policy || null),
        safety: cloneJson(operation.safety || null),
        approval: operation.status === "waiting_approval"
          ? {
              required: true,
              expires_at: toIso(operation.approvalExpiresAt),
              instruction: "Ask the user to review and approve this operation in the browser extension."
            }
          : { required: false },
        result: cloneJson(operation.result || null),
        evidence: cloneJson(operation.evidence || null),
        error: stringValue(operation.error),
        next: operationNextInstruction(operation)
      };
    }

    async #persistAndNotify() {
      await this.#persist();
      try {
        this.onStatusChange({
          status: this.getStatus(),
          pendingOperations: this.listPendingOperations()
        });
      } catch {
        // UI notification failures never change the privileged transaction result.
      }
    }

    async #persist() {
      this.state.updatedAt = this.now();
      await this.storage.set({ [this.storageKey]: cloneJson(this.state) });
    }

    async #storageGet() {
      const result = await this.storage.get(this.storageKey);
      return result?.[this.storageKey];
    }

    #assertReady() {
      if (!this.ready) {
        throw new Error("ExternalControlRuntime has not been initialized.");
      }
    }

    #serialize(task) {
      const run = this.transaction.then(task, task);
      this.transaction = run.catch(() => {});
      return run;
    }
  }

  function createEmptyState() {
    return {
      version: 1,
      armedTab: null,
      sessions: {},
      operations: {},
      idempotency: {},
      updatedAt: 0
    };
  }

  function normalizeState(value) {
    const source = value && typeof value === "object" ? value : {};
    return {
      version: 1,
      armedTab: source.armedTab && typeof source.armedTab === "object"
        ? {
            ...source.armedTab,
            title: redactExternalText(source.armedTab.title),
            url: sanitizeExternalUrl(source.armedTab.url)
          }
        : null,
      sessions: source.sessions && typeof source.sessions === "object" ? source.sessions : {},
      operations: source.operations && typeof source.operations === "object" ? source.operations : {},
      idempotency: source.idempotency && typeof source.idempotency === "object" ? source.idempotency : {},
      updatedAt: Number(source.updatedAt) || 0
    };
  }

  function sanitizeObservationForStorage(context) {
    const output = sanitizeObservationUrls(cloneJson(context || {}));
    output.interactiveElements = (output.interactiveElements || []).map((element) => {
      const sensitive = Contract.isSensitiveTarget(element);
      return {
        ...element,
        ...(sensitive && Object.hasOwn(element, "value") ? { value: "[redacted]" } : {})
      };
    });
    output.forms = (output.forms || []).map((form) => ({
      ...form,
      fields: (form.fields || []).map((field) => ({
        ...field,
        ...(Contract.isSensitiveTarget(field) && Object.hasOwn(field, "value") ? { value: "[redacted]" } : {})
      }))
    }));
    // The external client owns a lease for exactly one user-shared tab. The
    // driver's browser inventory is useful to the extension's internal agent,
    // but exposing it here would reveal unrelated tabs and stable browser IDs.
    delete output.browser;
    return output;
  }

  function sanitizeObservationUrls(value) {
    if (Array.isArray(value)) {
      return value.map(sanitizeObservationUrls);
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "string" && /^(?:url|href|formAction)$/i.test(key)) {
        output[key] = sanitizeExternalUrl(entry);
      } else {
        output[key] = sanitizeObservationUrls(entry);
      }
    }
    return output;
  }

  function sanitizeObservationForClient(context) {
    const output = sanitizeObservationForStorage(context);
    if (output.screenshotDataUrl) {
      delete output.screenshotDataUrl;
    }
    return output;
  }

  function sanitizeObservationForPolicy(context) {
    const output = sanitizeObservationForClient(context);
    output.visibleText = stringValue(output.visibleText).slice(0, 12000);
    output.interactiveElements = (output.interactiveElements || []).slice(0, 160);
    return output;
  }

  function sanitizePolicySettings(settings) {
    return {
      stopOnSensitiveInput: settings.stopOnSensitiveInput !== false,
      redactSensitiveData: settings.redactSensitiveData !== false,
      policyGuardEnabled: settings.policyGuardEnabled !== false,
      bridgeRequireApproval: settings.bridgeRequireApproval !== false,
      maxActionsPerTurn: normalizePositiveInteger(settings.maxActionsPerTurn, 8)
    };
  }

  function sanitizeExecutionResult(result) {
    const output = cloneJson(result ?? null);
    return redactObjectValues(output);
  }

  function sanitizeTargetForClient(target) {
    if (!target) return null;
    return {
      ref: stringValue(target.ref),
      tag: stringValue(target.tag),
      role: stringValue(target.role),
      type: stringValue(target.type),
      label: stringValue(target.label),
      href: stringValue(target.href),
      formAction: stringValue(target.formAction),
      formMethod: stringValue(target.formMethod),
      disabled: Boolean(target.disabled),
      ariaDisabled: Boolean(target.ariaDisabled),
      actionability: stringValue(target.actionability),
      readOnly: Boolean(target.readOnly),
      sensitive: Contract.isSensitiveTarget(target)
    };
  }

  function redactObjectValues(value) {
    if (Array.isArray(value)) {
      return value.map(redactObjectValues);
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/password|secret|token|authorization|cookie|value/i.test(key)) {
        output[key] = "[redacted]";
      } else {
        output[key] = redactObjectValues(entry);
      }
    }
    return output;
  }

  function normalizePolicy(policy) {
    const source = policy && typeof policy === "object" ? policy : {};
    const verdict = ["allow", "approval", "block"].includes(source.verdict)
      ? source.verdict
      : "approval";
    return {
      version: stringValue(source.version || "1.0"),
      verdict,
      message: stringValue(source.message),
      risks: stringArray(source.risks),
      sensitiveData: stringArray(source.sensitiveData),
      approvalReasons: verdict === "approval" && !stringArray(source.approvalReasons).length
        ? ["The policy response was incomplete, so approval is required."]
        : stringArray(source.approvalReasons)
    };
  }

  function sanitizePolicy(policy) {
    return {
      verdict: policy.verdict,
      message: policy.message,
      risks: policy.risks,
      approvalReasons: policy.approvalReasons
    };
  }

  function summarizeSession(session) {
    return {
      id: session.id,
      targetTabId: session.targetTabId,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt
    };
  }

  function summarizeSharedTab(tab) {
    return {
      title: redactExternalText(tab.title),
      url: sanitizeExternalUrl(tab.url)
    };
  }

  function operationNextInstruction(operation) {
    if (operation.status === "waiting_approval") {
      return "Wait for the user to approve this operation in the extension, then call browser_operation_get with the same operation_id. Do not create a duplicate proposal.";
    }
    if (operation.status === "completed") {
      return "Call browser_observe to verify the visible outcome, then close the session when the objective is satisfied.";
    }
    if (["stale", "expired"].includes(operation.status)) {
      return "Call browser_observe for a fresh observation before creating a new proposal.";
    }
    if (["blocked", "rejected", "unknown_after_restart", "cancelled"].includes(operation.status)) {
      return "Report this terminal blocker and close the session.";
    }
    return "Continue the session according to the current operation status.";
  }

  function redactExternalText(value) {
    return stringValue(value)
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
      .replace(/\b(?:api[_-]?key|token|secret|password|passwd|authorization)\s*[:=]\s*[^\s\"'<>]+/gi, "$1=[redacted]")
      .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted-token]");
  }

  function sanitizeExternalUrl(value) {
    const text = stringValue(value);
    if (!text) return "";
    try {
      const url = new URL(text);
      url.username = url.username ? "redacted" : "";
      url.password = url.password ? "redacted" : "";
      url.pathname = redactExternalText(url.pathname);
      url.hash = url.hash ? `#${redactExternalText(url.hash.slice(1))}` : "";
      for (const key of Array.from(url.searchParams.keys())) {
        if (/token|secret|password|passwd|auth|key|code|credential|session|cookie|card|cvv|cvc/i.test(key)) {
          url.searchParams.set(key, "[redacted]");
        }
      }
      return url.toString();
    } catch {
      return redactExternalText(text);
    }
  }

  function createRandomId(prefix) {
    const bytes = new Uint8Array(18);
    if (!globalScope.crypto?.getRandomValues) {
      throw new Error("Secure random generation is unavailable.");
    }
    globalScope.crypto.getRandomValues(bytes);
    const encoded = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    return `${prefix}-${encoded}`;
  }

  function normalizeDuration(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 1000 ? Math.floor(parsed) : fallback;
  }

  function normalizePositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  function boundedString(value, maxLength, name) {
    const output = stringValue(value).trim();
    if (!output) {
      throw new Error(`${name} is required.`);
    }
    if (output.length > maxLength) {
      throw new Error(`${name} is too long.`);
    }
    return output;
  }

  function boundedOptionalString(value, maxLength) {
    return stringValue(value).trim().slice(0, maxLength);
  }

  function stringArray(value) {
    return Array.isArray(value) ? value.map(stringValue).filter(Boolean) : [];
  }

  function stringValue(value) {
    return value === undefined || value === null ? "" : String(value);
  }

  function toIso(value) {
    return value ? new Date(value).toISOString() : null;
  }

  function cloneJson(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  const api = Object.freeze({
    ExternalControlRuntime,
    createExternalControlRuntime: (options) => new ExternalControlRuntime(options),
    sanitizeObservationForClient,
    sanitizeObservationForStorage
  });

  globalScope.WebExternalControlRuntime = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

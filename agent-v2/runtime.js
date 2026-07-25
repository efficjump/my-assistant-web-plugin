(function initializeAgentRuntimeV2(globalScope) {
  "use strict";

  const VERSION = "2.0";
  const DEFAULT_LIMITS = Object.freeze({
    maxEvents: 320,
    maxEvidence: 96,
    maxEffects: 96,
    maxAttempts: 128
  });
  const ACTIVE_STATUSES = new Set([
    "new",
    "observing",
    "thinking",
    "policy_check",
    "waiting_approval",
    "executing",
    "verifying",
    "recovering"
  ]);
  const TERMINAL_STATUSES = new Set([
    "answer",
    "completed",
    "blocked",
    "needs_input",
    "stopped",
    "failed"
  ]);
  const EVENT_TYPES = new Set([
    "run_started",
    "goal_updated",
    "observation_recorded",
    "model_output_received",
    "provider_state_updated",
    "tool_proposed",
    "policy_decided",
    "approval_requested",
    "approval_resolved",
    "tool_started",
    "tool_finished",
    "completion_checked",
    "run_completed",
    "run_blocked",
    "run_needs_input",
    "run_stopped",
    "run_failed",
    "run_recovered"
  ]);

  function createRun(options = {}) {
    const now = normalizeTimestamp(options.createdAt);
    const runId = stringValue(options.runId).trim();
    if (!runId) {
      throw new Error("Agent Runtime v2 requires a runId.");
    }
    const targetTabId = normalizePositiveInteger(options.targetTabId, 0);
    if (!targetTabId) {
      throw new Error("Agent Runtime v2 requires a targetTabId.");
    }
    return {
      version: VERSION,
      runId,
      targetTabId,
      documentId: stringValue(options.documentId),
      request: stringValue(options.request),
      status: "new",
      goal: normalizeGoalContract(options.goal || {
        objective: options.request,
        deliverable: { kind: "effect" }
      }),
      latestObservation: null,
      providerChannels: normalizeProviderChannels(options.providerChannels),
      pendingApproval: null,
      pendingEffects: {},
      evidenceLedger: [],
      effectLedger: [],
      attemptLedger: [],
      completion: null,
      recovery: null,
      events: [],
      createdAt: now,
      updatedAt: now
    };
  }

  function normalizeGoalContract(value = {}) {
    const deliverable = value.deliverable && typeof value.deliverable === "object"
      ? value.deliverable
      : {};
    const kind = ["answer", "effect", "collection"].includes(deliverable.kind)
      ? deliverable.kind
      : "effect";
    return {
      version: stringValue(value.version || "1.0"),
      objective: stringValue(value.objective || value.originalRequest).trim(),
      contextSummary: stringValue(value.contextSummary),
      deliverable: {
        kind,
        itemDescription: stringValue(deliverable.itemDescription),
        targetCount: normalizeNullablePositiveInteger(deliverable.targetCount),
        pageRange: normalizeCollectionPageRange(deliverable.pageRange),
        fields: uniqueStrings(deliverable.fields),
        includeCriteria: uniqueStrings(deliverable.includeCriteria),
        formats: uniqueStrings(deliverable.formats)
      },
      successCriteria: uniqueStrings(value.successCriteria || value.completionCriteria),
      prohibitedEffects: uniqueStrings(value.prohibitedEffects),
      repeatPolicy: ["once", "bounded", "until_condition"].includes(value.repeatPolicy)
        ? value.repeatPolicy
        : "once",
      repeatLimit: normalizePositiveInteger(value.repeatLimit, 1),
      requiresCurrentPageEvidence: value.requiresCurrentPageEvidence !== false
        && kind !== "answer",
      needsClarification: Boolean(value.needsClarification),
      clarificationQuestions: uniqueStrings(value.clarificationQuestions)
    };
  }

  function goalFromTurnIntent(turnIntent = {}, options = {}) {
    return normalizeGoalContract({
      version: turnIntent.version || "1.0",
      objective: turnIntent.objective || options.request || "",
      contextSummary: turnIntent.contextSummary || "",
      deliverable: turnIntent.deliverable || { kind: "effect" },
      completionCriteria: turnIntent.completionCriteria || [],
      prohibitedEffects: options.prohibitedEffects || [],
      repeatPolicy: turnIntent.repeatPolicy,
      repeatLimit: turnIntent.repeatLimit,
      requiresCurrentPageEvidence: options.requiresCurrentPageEvidence
    });
  }

  function createEvent(type, payload = {}, options = {}) {
    if (!EVENT_TYPES.has(type)) {
      throw new Error(`Unsupported Agent Runtime v2 event: ${type}`);
    }
    return {
      id: stringValue(options.id || createEventId(type)),
      type,
      runId: stringValue(options.runId),
      createdAt: normalizeTimestamp(options.createdAt),
      payload: cloneJson(payload) || {}
    };
  }

  function reduceRun(source, rawEvent, options = {}) {
    const run = normalizeRun(source);
    const event = normalizeEvent(rawEvent, run.runId);
    if (run.events.some((item) => item.id === event.id)) {
      return run;
    }

    switch (event.type) {
      case "run_started":
        run.status = "observing";
        break;
      case "goal_updated":
        run.goal = normalizeGoalContract(event.payload.goal || event.payload);
        break;
      case "observation_recorded":
        run.status = "thinking";
        run.documentId = stringValue(event.payload.documentId || run.documentId);
        run.latestObservation = {
          evidenceId: stringValue(event.payload.evidenceId),
          documentId: stringValue(event.payload.documentId || run.documentId),
          url: stringValue(event.payload.url),
          title: stringValue(event.payload.title),
          fingerprint: stringValue(event.payload.fingerprint),
          observedAt: event.createdAt
        };
        appendUniqueById(run.evidenceLedger, normalizeEvidence(event.payload.evidence), "id");
        break;
      case "model_output_received":
        run.status = "thinking";
        break;
      case "provider_state_updated": {
        const channel = stringValue(event.payload.channel || "planner");
        run.providerChannels[channel] = cloneJson(event.payload.state) || null;
        break;
      }
      case "tool_proposed":
        run.status = "policy_check";
        break;
      case "policy_decided":
        run.status = event.payload.blocked
          ? "blocked"
          : event.payload.requiresApproval
            ? "waiting_approval"
            : "executing";
        break;
      case "approval_requested":
        run.status = "waiting_approval";
        run.pendingApproval = cloneJson(event.payload) || {};
        break;
      case "approval_resolved":
        run.pendingApproval = null;
        run.status = event.payload.approved ? "executing" : "stopped";
        break;
      case "tool_started": {
        const effectId = stringValue(event.payload.effectId || event.payload.callId);
        if (effectId) {
          run.pendingEffects[effectId] = {
            ...cloneJson(event.payload),
            effectId,
            startedAt: event.createdAt
          };
        }
        run.status = "executing";
        break;
      }
      case "tool_finished": {
        const effectId = stringValue(event.payload.effectId || event.payload.callId);
        if (effectId) {
          delete run.pendingEffects[effectId];
        }
        const normalizedResult = normalizeToolResult(event.payload.result || event.payload);
        appendUniqueById(run.attemptLedger, {
          id: effectId || event.id,
          effectId,
          result: normalizedResult,
          completedAt: event.createdAt
        }, "id");
        if (normalizedResult.effect.changed || normalizedResult.goal.satisfied) {
          appendUniqueById(run.effectLedger, {
            id: effectId || event.id,
            effectId,
            result: normalizedResult,
            completedAt: event.createdAt
          }, "id");
        }
        for (const evidence of normalizedResult.evidence) {
          appendUniqueById(run.evidenceLedger, evidence, "id");
        }
        run.status = "verifying";
        break;
      }
      case "completion_checked":
        run.completion = cloneJson(event.payload) || null;
        run.status = event.payload.verified ? "completed" : "thinking";
        break;
      case "run_completed":
        run.status = event.payload.status === "answer" ? "answer" : "completed";
        run.completion = cloneJson(event.payload) || run.completion;
        break;
      case "run_blocked":
        run.status = "blocked";
        run.completion = cloneJson(event.payload) || run.completion;
        break;
      case "run_needs_input":
        run.status = "needs_input";
        run.completion = cloneJson(event.payload) || run.completion;
        break;
      case "run_stopped":
        run.status = "stopped";
        break;
      case "run_failed":
        run.status = "failed";
        run.completion = cloneJson(event.payload) || run.completion;
        break;
      case "run_recovered":
        run.status = "recovering";
        run.recovery = {
          ...cloneJson(event.payload),
          recoveredAt: event.createdAt
        };
        break;
      default:
        break;
    }

    run.events.push(event);
    trimToLimit(run.events, normalizePositiveInteger(options.maxEvents, DEFAULT_LIMITS.maxEvents));
    trimToLimit(run.evidenceLedger, normalizePositiveInteger(options.maxEvidence, DEFAULT_LIMITS.maxEvidence));
    trimToLimit(run.effectLedger, normalizePositiveInteger(options.maxEffects, DEFAULT_LIMITS.maxEffects));
    trimToLimit(run.attemptLedger, normalizePositiveInteger(options.maxAttempts, DEFAULT_LIMITS.maxAttempts));
    run.updatedAt = event.createdAt;
    return run;
  }

  function normalizeRun(value) {
    if (!value || typeof value !== "object") {
      throw new Error("Agent Runtime v2 run snapshot is required.");
    }
    return {
      ...cloneJson(value),
      version: VERSION,
      runId: stringValue(value.runId),
      targetTabId: normalizePositiveInteger(value.targetTabId, 0),
      documentId: stringValue(value.documentId),
      request: stringValue(value.request),
      status: ACTIVE_STATUSES.has(value.status) || TERMINAL_STATUSES.has(value.status)
        ? value.status
        : "new",
      goal: normalizeGoalContract(value.goal),
      providerChannels: normalizeProviderChannels(value.providerChannels),
      pendingEffects: value.pendingEffects && typeof value.pendingEffects === "object"
        ? cloneJson(value.pendingEffects)
        : {},
      evidenceLedger: Array.isArray(value.evidenceLedger) ? cloneJson(value.evidenceLedger) : [],
      effectLedger: Array.isArray(value.effectLedger) ? cloneJson(value.effectLedger) : [],
      attemptLedger: Array.isArray(value.attemptLedger) ? cloneJson(value.attemptLedger) : [],
      events: Array.isArray(value.events) ? cloneJson(value.events) : [],
      createdAt: normalizeTimestamp(value.createdAt),
      updatedAt: normalizeTimestamp(value.updatedAt || value.createdAt)
    };
  }

  function normalizeEvent(value, runId) {
    if (!value || typeof value !== "object" || !EVENT_TYPES.has(value.type)) {
      throw new Error("Invalid Agent Runtime v2 event.");
    }
    const eventRunId = stringValue(value.runId || runId);
    if (eventRunId !== runId) {
      throw new Error("Agent Runtime v2 event belongs to a different run.");
    }
    return {
      id: stringValue(value.id || createEventId(value.type)),
      type: value.type,
      runId: eventRunId,
      createdAt: normalizeTimestamp(value.createdAt),
      payload: cloneJson(value.payload) || {}
    };
  }

  function normalizeToolResult(value = {}) {
    const verification = value.verification && typeof value.verification === "object"
      ? value.verification
      : {};
    const result = value.result && typeof value.result === "object" ? value.result : {};
    const dispatched = value.transport?.dispatched === true
      || value.ok === true
      || result.dispatched === true;
    const changed = value.effect?.changed === true
      || verification.materialChanged === true
      || verification.changed === true
      || verification.urlChanged === true
      || result.navigationObserved === true;
    const indeterminate = verification.indeterminate === true;
    const goalSatisfied = value.goal?.satisfied === true;
    const evidence = (value.evidence || [])
      .map(normalizeEvidence)
      .filter((item) => item.id);
    return {
      ok: value.ok === true,
      transport: {
        dispatched,
        targetFingerprint: stringValue(
          value.transport?.targetFingerprint
          || result.targetFingerprint
          || value.targetFingerprint
        )
      },
      effect: {
        changed,
        materialChanged: verification.materialChanged === true,
        indeterminate,
        urlChanged: verification.urlChanged === true,
        targetChanged: verification.targetChanged === true,
        valueChanged: verification.valueChanged === true,
        reason: stringValue(
          value.effect?.reason
          || verification.reason
          || value.error
        )
      },
      goal: {
        satisfied: goalSatisfied,
        criteria: uniqueStrings(value.goal?.criteria)
      },
      evidence,
      error: value.error
        ? {
            message: stringValue(value.error?.message || value.error),
            code: stringValue(value.error?.code),
            retryable: value.error?.retryable === true
          }
        : null
    };
  }

  function evaluateCompletion(options = {}) {
    const goal = normalizeGoalContract(options.goal);
    const candidate = options.candidate && typeof options.candidate === "object"
      ? options.candidate
      : {};
    const verifier = options.verifier && typeof options.verifier === "object"
      ? options.verifier
      : {};
    const evidence = (options.evidence || []).map(normalizeEvidence).filter((item) => item.id);
    const evidenceById = new Map(evidence.map((item) => [item.id, item]));
    const candidateEvidenceIds = uniqueStrings([
      ...(candidate.completionEvidence || []),
      ...(verifier.evidenceIds || [])
    ]);
    const errors = [];
    const warnings = [];

    if (!["completed", "answer"].includes(stringValue(candidate.status))) {
      errors.push("The candidate is not a terminal success response.");
    }
    if (options.pendingApproval) {
      errors.push("An approval request is still pending.");
    }
    if (Object.keys(options.pendingEffects || {}).length) {
      errors.push("One or more effects have an unknown execution outcome.");
    }
    if (verifier.status && verifier.status !== "verified") {
      errors.push(stringValue(verifier.message || "The independent verifier did not accept completion."));
    }
    const missingIds = candidateEvidenceIds.filter((id) => !evidenceById.has(id));
    if (missingIds.length) {
      errors.push(`Completion cites unavailable evidence: ${missingIds.join(", ")}`);
    }
    if (!candidateEvidenceIds.length && goal.deliverable.kind !== "answer") {
      errors.push("Effectful completion requires runtime-issued evidence.");
    }

    const currentPageEvidenceId = stringValue(options.currentPageEvidenceId);
    if (
      options.requireCurrentPageEvidence !== false
      && goal.requiresCurrentPageEvidence
      && (
        !currentPageEvidenceId
        || !candidateEvidenceIds.includes(currentPageEvidenceId)
        || !evidenceById.has(currentPageEvidenceId)
      )
    ) {
      errors.push("The latest page observation is not bound to completion.");
    }

    const citedEvidence = candidateEvidenceIds
      .map((id) => evidenceById.get(id))
      .filter(Boolean);
    if (goal.deliverable.kind === "effect") {
      const effectEvidence = citedEvidence.some((item) => (
        ["action_result", "tool_result"].includes(item.source)
        && evidenceShowsSuccessfulExecution(item)
      ));
      if (!effectEvidence) {
        errors.push("No cited action or tool result proves that the requested effect executed.");
      }
    }

    if (goal.deliverable.kind === "answer") {
      const hasGrounding = verifier.status === "verified"
        || citedEvidence.some((item) => [
          "page_observation",
          "tool_result",
          "collection_result"
        ].includes(item.source));
      if (!hasGrounding) {
        errors.push("The answer is not grounded in runtime evidence.");
      }
    }

    if (goal.deliverable.kind === "collection") {
      const targetCount = goal.deliverable.targetCount;
      const pageRange = goal.deliverable.pageRange;
      const collectionEvidence = citedEvidence.find((item) => item.source === "collection_result");
      const uniqueCount = Number(
        collectionEvidence?.payload?.uniqueCount
        ?? collectionEvidence?.payload?.rowCount
        ?? collectionEvidence?.payload?.rows?.length
      );
      if (!collectionEvidence) {
        errors.push("Collection completion requires a runtime collection result.");
      } else if (targetCount && uniqueCount !== targetCount) {
        errors.push(`Collection cardinality is ${Number.isFinite(uniqueCount) ? uniqueCount : "unknown"}, expected ${targetCount}.`);
      }
      if (
        collectionEvidence
        && pageRange
        && (
          collectionEvidence.payload?.status !== "reached"
          || !collectionPageRangeCovered(collectionEvidence.payload?.pages, pageRange)
        )
      ) {
        errors.push(`Collection pages do not prove the requested inclusive range ${pageRange.start}-${pageRange.end}.`);
      }
      for (const format of goal.deliverable.formats) {
        const hasArtifact = citedEvidence.some((item) => (
          item.source === "tool_result"
          && item.payload?.artifact?.format === format
          && item.payload?.artifact?.status !== "failed"
        ));
        if (!hasArtifact) {
          errors.push(`The requested ${format} artifact is not proven by runtime evidence.`);
        }
      }
    }

    if (!goal.successCriteria.length) {
      warnings.push("The dynamic goal contract has no explicit observable success criterion.");
    }
    if (goal.needsClarification) {
      errors.push("The goal contract still requires user clarification.");
    }

    return {
      version: VERSION,
      verified: errors.length === 0,
      status: errors.length ? "rejected" : "verified",
      errors: uniqueStrings(errors),
      warnings: uniqueStrings(warnings),
      evidenceIds: candidateEvidenceIds,
      checkedAt: normalizeTimestamp()
    };
  }

  function evidenceShowsSuccessfulExecution(evidence) {
    const payload = evidence?.payload || {};
    if (payload.ok === false || payload.transport?.dispatched === false) {
      return false;
    }
    if (
      payload.effect?.changed === true
      || payload.goal?.satisfied === true
      || payload.verification?.changed === true
      || payload.verification?.materialChanged === true
      || payload.changed === true
    ) {
      return true;
    }
    if (
      payload.verification?.urlChanged === true
      || payload.verification?.targetChanged === true
      || payload.verification?.valueChanged === true
    ) {
      return true;
    }
    return false;
  }

  function selectContextItems(items, options = {}) {
    const tokenBudget = normalizePositiveInteger(options.tokenBudget, 12000);
    const reserveTokens = Math.min(
      tokenBudget,
      normalizePositiveInteger(options.reserveTokens, Math.ceil(tokenBudget * 0.15))
    );
    const availableTokens = Math.max(1, tokenBudget - reserveTokens);
    const normalized = (items || [])
      .map((item, index) => ({
        value: cloneJson(item),
        index,
        score: calculateContextScore(item, options),
        tokens: estimateTokens(item)
      }))
      .filter((item) => item.tokens <= availableTokens);
    normalized.sort((left, right) => (
      right.score - left.score
      || right.index - left.index
    ));

    const selected = [];
    let usedTokens = 0;
    for (const item of normalized) {
      if (selected.length && usedTokens + item.tokens > availableTokens) {
        continue;
      }
      selected.push(item);
      usedTokens += item.tokens;
    }
    selected.sort((left, right) => left.index - right.index);
    return {
      items: selected.map((item) => item.value),
      estimatedTokens: usedTokens,
      omittedCount: Math.max(0, normalized.length - selected.length),
      tokenBudget
    };
  }

  function calculateContextScore(item, options) {
    let score = Number(item?.contextPriority) || 0;
    const recency = Number(item?.step ?? item?.sequence ?? item?.index);
    if (Number.isFinite(recency)) {
      score += recency;
    }
    if (item?.unresolved === true || item?.pending === true) {
      score += 10000;
    }
    if (item?.source === "page_observation" || item?.kind === "effects") {
      score += 4000;
    }
    const relevantIds = new Set(uniqueStrings(options.relevantIds));
    if (item?.id && relevantIds.has(item.id)) {
      score += 20000;
    }
    return score;
  }

  function estimateTokens(value) {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    return Math.max(1, Math.ceil(stringValue(serialized).length / 4));
  }

  function normalizeEvidence(value = {}) {
    return {
      id: stringValue(value.id),
      source: stringValue(value.source),
      step: Number(value.step) || 0,
      summary: stringValue(value.summary),
      url: stringValue(value.url),
      documentId: stringValue(value.documentId),
      observedAt: normalizeTimestamp(value.observedAt),
      payload: cloneJson(value.payload) || null
    };
  }

  function normalizeProviderChannels(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    return cloneJson(value);
  }

  function isRunActive(run) {
    return Boolean(run && ACTIVE_STATUSES.has(run.status));
  }

  function hasUnknownEffect(run) {
    return Boolean(run && Object.keys(run.pendingEffects || {}).length);
  }

  function snapshotForStorage(run) {
    return redactSensitiveValue(normalizeRun(run));
  }

  function redactSensitiveValue(value, key = "") {
    if (Array.isArray(value)) {
      return value.map((item) => redactSensitiveValue(item, key));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([entryKey, entryValue]) => [
          entryKey,
          redactSensitiveValue(entryValue, entryKey)
        ])
      );
    }
    if (/password|secret|authorization|api.?key|cookie|card|cvv|cvc/i.test(key)) {
      return value ? "[redacted]" : value;
    }
    if (typeof value === "string") {
      return value
        .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[redacted-key]")
        .replace(/\b(?:password|secret|authorization|api[_-]?key)\s*[:=]\s*[^\s"'<>]+/gi, "$1=[redacted]");
    }
    return value;
  }

  function appendUniqueById(list, value, key) {
    if (!value || !value[key]) {
      return;
    }
    const index = list.findIndex((item) => item?.[key] === value[key]);
    if (index >= 0) {
      list[index] = value;
    } else {
      list.push(value);
    }
  }

  function trimToLimit(list, maxLength) {
    if (list.length > maxLength) {
      list.splice(0, list.length - maxLength);
    }
  }

  function normalizePositiveInteger(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }
    return Math.floor(parsed);
  }

  function normalizeNullablePositiveInteger(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    return normalizePositiveInteger(value, null);
  }

  function normalizeCollectionPageRange(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const start = Number(value.start);
    const end = Number(value.end);
    if (
      !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start < 1
      || end < start
      || end - start + 1 > 250
    ) {
      return null;
    }
    return { start, end };
  }

  function collectionPageRangeCovered(pages, pageRange) {
    const ordinals = new Set(
      (Array.isArray(pages) ? pages : [])
        .filter((page) => !page?.repeated)
        .map((page) => Number(page?.ordinal))
        .filter((ordinal) => Number.isSafeInteger(ordinal))
    );
    for (let ordinal = pageRange.start; ordinal <= pageRange.end; ordinal += 1) {
      if (!ordinals.has(ordinal)) {
        return false;
      }
    }
    return true;
  }

  function normalizeTimestamp(value) {
    const date = value ? new Date(value) : new Date();
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }

  function uniqueStrings(values) {
    return Array.from(new Set(
      (Array.isArray(values) ? values : [])
        .map((item) => stringValue(item).trim())
        .filter(Boolean)
    ));
  }

  function stringValue(value) {
    return value === undefined || value === null ? "" : String(value);
  }

  function cloneJson(value) {
    if (value === undefined) {
      return undefined;
    }
    if (typeof structuredClone === "function") {
      try {
        return structuredClone(value);
      } catch {
        // Fall through to JSON cloning for extension-safe data.
      }
    }
    return JSON.parse(JSON.stringify(value));
  }

  function createEventId(type) {
    const random = globalScope.crypto?.randomUUID?.()
      || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `${type}:${random}`;
  }

  const api = Object.freeze({
    VERSION,
    ACTIVE_STATUSES,
    TERMINAL_STATUSES,
    EVENT_TYPES,
    createRun,
    createEvent,
    reduceRun,
    normalizeRun,
    normalizeGoalContract,
    goalFromTurnIntent,
    normalizeToolResult,
    evaluateCompletion,
    selectContextItems,
    estimateTokens,
    isRunActive,
    hasUnknownEffect,
    snapshotForStorage
  });

  globalScope.WebAgentRuntimeV2 = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

(function initializeAgentLatencyStrategyV2(globalScope) {
  "use strict";

  const VERSION = "2.2";
  const TERMINAL_STATUSES = new Set(["answer", "completed"]);
  const FAST_STAGE_KINDS = new Set(["answer", "routing", "policy", "verifier"]);
  const LATENCY_MODES = new Set(["fast", "balanced", "thorough"]);
  const NON_SEMANTIC_EVIDENCE_KEYS = new Set([
    "ref",
    "selector",
    "tag",
    "role",
    "type",
    "disabled",
    "ariaDisabled",
    "actionability",
    "documentId",
    "frameId",
    "index"
  ]);

  function classifyStage(purpose) {
    const value = stringValue(purpose).toLocaleLowerCase();
    if (value.includes("policy")) {
      return "policy";
    }
    if (value.includes("visual")) {
      return "visual";
    }
    if (value.includes("repair") || value.includes("replan")) {
      return "repair";
    }
    if (value.includes("verifier") || value.includes("grounding")) {
      return "verifier";
    }
    if (value.includes("focused-page-answer") || value.includes("fast-answer")) {
      return "answer";
    }
    if (value.includes("routing") || value.includes("target-selection")) {
      return "routing";
    }
    return "planner";
  }

  function resolveStageProfile(options = {}) {
    const settings = options.settings || {};
    const classifiedKind = classifyStage(options.purpose);
    const kind = (
      classifiedKind === "planner"
      && Boolean(options.hasScreenshot)
    )
      ? "visual"
      : classifiedKind;
    const latencyMode = normalizeLatencyMode(settings.latencyMode);
    const schema = options.responseSchema || null;
    const inputChars = normalizeNonnegativeInteger(options.inputChars, 0);
    const configuredMax = normalizePositiveInteger(settings.maxOutputTokens, 2000);
    const maxOutputTokens = resolveOutputBudget({
      kind,
      schema,
      inputChars,
      configuredMax
    });
    const configuredContinuation = normalizePositiveInteger(
      settings.providerContinuationMaxChars,
      32000
    );
    const continuationChars = Math.min(
      configuredContinuation,
      Math.max(
        8000,
        normalizePositiveInteger(settings.maxTextChars, 16000)
          + Math.ceil(estimateSchemaInputTokens(schema) * 6)
      )
    );
    const primaryModel = stringValue(settings.model).trim();
    const fastModel = stringValue(settings.fastModel).trim();
    const fastPlannerEligible = (
      latencyMode === "fast"
      && kind === "planner"
      && settings.agentMode !== "auto"
      && options.allowFastPlanner !== false
      && options.forcePrimaryModel !== true
      && !options.hasScreenshot
    );
    const useFastModel = (
      options.forcePrimaryModel !== true
      && Boolean(fastModel)
      && fastModel !== primaryModel
      && (FAST_STAGE_KINDS.has(kind) || fastPlannerEligible)
    );
    const model = useFastModel
      ? fastModel
      : primaryModel;
    const reasoningEffort = resolveReasoningEffort({
      latencyMode,
      kind,
      useFastModel
    });
    const textVerbosity = resolveTextVerbosity({
      latencyMode,
      kind
    });
    const serviceTier = settings.serviceTier === "priority"
      ? "priority"
      : "";

    return {
      version: VERSION,
      kind,
      latencyMode,
      model,
      modelRole: useFastModel ? "fast" : "primary",
      fastPlanner: useFastModel && kind === "planner",
      maxOutputTokens,
      continuationChars,
      reasoningEffort,
      textVerbosity,
      serviceTier,
      promptCache: settings.promptCaching !== false
        && settings.apiProfile === "openai-responses",
      cacheScope: buildCacheScope({
        kind,
        modelRole: useFastModel ? "fast" : "primary",
        schema
      }),
      stream: settings.streamAiResponses !== false
        && settings.apiProfile === "openai-responses",
      nativeTools: shouldUseNativeTools(settings, options.purpose)
    };
  }

  function normalizeLatencyMode(value) {
    const normalized = stringValue(value).trim().toLocaleLowerCase();
    return LATENCY_MODES.has(normalized) ? normalized : "fast";
  }

  function resolveReasoningEffort(options = {}) {
    const latencyMode = normalizeLatencyMode(options.latencyMode);
    const kind = stringValue(options.kind || "planner");
    if (latencyMode === "fast") {
      return "low";
    }
    if (latencyMode === "thorough") {
      return ["routing", "policy", "verifier", "answer"].includes(kind)
        ? "low"
        : "medium";
    }
    return "";
  }

  function resolveTextVerbosity(options = {}) {
    const latencyMode = normalizeLatencyMode(options.latencyMode);
    if (latencyMode === "fast") {
      return "low";
    }
    if (latencyMode === "thorough" && options.kind === "answer") {
      return "medium";
    }
    return "";
  }

  function buildCacheScope(options = {}) {
    const canonical = JSON.stringify({
      version: VERSION,
      kind: stringValue(options.kind || "planner"),
      modelRole: stringValue(options.modelRole || "primary"),
      schema: options.schema || null
    });
    return [
      "agent",
      stringValue(options.kind || "planner"),
      hashString(canonical)
    ].join("-");
  }

  function hashString(value) {
    let hash = 2166136261;
    const text = stringValue(value);
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function resolveOutputBudget(options = {}) {
    const kind = stringValue(options.kind || "planner");
    const configuredMax = Math.max(
      128,
      normalizePositiveInteger(options.configuredMax, 2000)
    );
    const inputChars = normalizeNonnegativeInteger(options.inputChars, 0);
    const schemaOutputTokens = estimateSchemaOutputTokens(options.schema);
    const stageWeight = {
      routing: 2.4,
      policy: 2.2,
      verifier: 2.8,
      visual: 4.5,
      repair: 6.5,
      planner: 7.5
    }[kind] || 7.5;
    const reasoningReserve = Math.ceil(
      Math.sqrt(Math.max(1, inputChars + estimateSchemaInputTokens(options.schema) * 4))
      * stageWeight
    );
    const recoveryHeadroom = Math.ceil(schemaOutputTokens * (
      ["planner", "repair"].includes(kind) ? 0.8 : 0.4
    ));
    return Math.min(
      configuredMax,
      Math.max(
        128,
        schemaOutputTokens + reasoningReserve + recoveryHeadroom
      )
    );
  }

  function estimateSchemaInputTokens(schema) {
    if (!schema || typeof schema !== "object") {
      return 0;
    }
    return Math.ceil(JSON.stringify(schema).length / 4);
  }

  function estimateSchemaOutputTokens(schema) {
    if (!schema || typeof schema !== "object") {
      return 256;
    }
    const skeleton = buildSchemaSkeleton(schema);
    const structuralTokens = Math.ceil(JSON.stringify(skeleton).length / 3.5);
    const propertyCount = countSchemaProperties(schema);
    return Math.max(160, structuralTokens + propertyCount * 5);
  }

  function buildSchemaSkeleton(schema, depth = 0) {
    if (!schema || typeof schema !== "object" || depth > 8) {
      return null;
    }
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const type = types.find((entry) => entry && entry !== "null")
      || (schema.properties ? "object" : schema.items ? "array" : "string");
    if (type === "object") {
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      return Object.fromEntries(
        Object.entries(schema.properties || {})
          .filter(([key]) => required.has(key))
          .map(([key, value]) => [key, buildSchemaSkeleton(value, depth + 1)])
      );
    }
    if (type === "array") {
      return [];
    }
    if (type === "boolean") {
      return false;
    }
    if (type === "integer" || type === "number") {
      return 0;
    }
    return Array.isArray(schema.enum) && schema.enum.length
      ? schema.enum[0]
      : "";
  }

  function countSchemaProperties(schema, seen = new Set()) {
    if (!schema || typeof schema !== "object" || seen.has(schema)) {
      return 0;
    }
    seen.add(schema);
    let count = schema.properties && typeof schema.properties === "object"
      ? Object.keys(schema.properties).length
      : 0;
    for (const value of Object.values(schema)) {
      if (Array.isArray(value)) {
        count += value.reduce(
          (sum, entry) => sum + countSchemaProperties(entry, seen),
          0
        );
      } else if (value && typeof value === "object") {
        count += countSchemaProperties(value, seen);
      }
    }
    return count;
  }

  function shouldUseNativeTools(settings = {}, purpose = "") {
    if (
      settings.nativeToolCalling === false
      || settings.apiProfile !== "openai-responses"
      || settings.structuredOutput === false
    ) {
      return false;
    }
    const kind = classifyStage(purpose);
    return kind === "planner" || kind === "repair";
  }

  function buildNativeDecisionTool(schema, options = {}) {
    const parameters = cloneJson(schema || {});
    const allowedStatuses = Array.isArray(options.allowedStatuses)
      ? options.allowedStatuses.filter(Boolean)
      : [];
    if (
      allowedStatuses.length
      && parameters?.properties?.status
      && typeof parameters.properties.status === "object"
    ) {
      parameters.properties.status = {
        ...parameters.properties.status,
        enum: allowedStatuses
      };
    }
    return {
      type: "function",
      name: stringValue(options.name || "browser_agent_step"),
      description: stringValue(
        options.description
        || "Return one browser-agent decision. For continue, the application executes the proposed effect and returns the exact result using the function call ID. Terminal decisions end the run."
      ),
      parameters,
      strict: true
    };
  }

  function evaluateFastPlannerEscalation(options = {}) {
    if (!options.fastPlanner || options.validation?.valid !== true) {
      return { required: false, reason: "" };
    }
    const decision = options.decision && typeof options.decision === "object"
      ? options.decision
      : {};
    if (["blocked", "clarify"].includes(decision.status)) {
      return {
        required: true,
        reason: "fast-planner-terminal-uncertainty"
      };
    }
    if (Array.isArray(decision.toolCalls) && decision.toolCalls.length) {
      return {
        required: true,
        reason: "fast-planner-external-tool"
      };
    }
    const primaryOnlyActions = new Set([
      "visual_click",
      "submit",
      "tab_open",
      "tab_focus",
      "tab_adopt",
      "tab_close",
      "download",
      "download_wait",
      "upload"
    ]);
    if (
      (Array.isArray(decision.actions) ? decision.actions : [])
        .some((action) => primaryOnlyActions.has(stringValue(action?.type)))
    ) {
      return {
        required: true,
        reason: "fast-planner-primary-only-effect"
      };
    }
    return { required: false, reason: "" };
  }

  function evaluateFastRoute(options = {}) {
    const route = options.route && typeof options.route === "object"
      ? options.route
      : {};
    const intent = options.intent && typeof options.intent === "object"
      ? options.intent
      : {};
    const minimumConfidence = clampNumber(
      options.minimumConfidence,
      0.5,
      1,
      0.82
    );
    const confidence = Number(route.confidence);
    if (!["direct", "answer", "collection"].includes(route.strategy)) {
      return {
        accepted: false,
        reason: "fast-route-needs-general-agent"
      };
    }
    if (!Number.isFinite(confidence) || confidence < minimumConfidence) {
      return {
        accepted: false,
        reason: "fast-route-confidence-below-threshold"
      };
    }
    if (
      route.strategy === "collection"
      && intent?.deliverable?.kind !== "collection"
    ) {
      return {
        accepted: false,
        reason: "fast-route-collection-contract-mismatch"
      };
    }
    if (
      route.strategy === "direct"
      && (!Array.isArray(route.actions) || !route.actions.length)
    ) {
      return {
        accepted: false,
        reason: "fast-route-has-no-effects"
      };
    }
    return {
      accepted: true,
      reason: "fast-route-accepted"
    };
  }

  function normalizeProviderToolOutputs(outputs) {
    return (Array.isArray(outputs) ? outputs : [])
      .flatMap((entry) => {
        const callId = stringValue(entry?.callId || entry?.call_id).trim();
        if (!callId) {
          return [];
        }
        const rawOutput = entry?.output;
        return [{
          type: "function_call_output",
          call_id: callId,
          output: typeof rawOutput === "string"
            ? rawOutput
            : JSON.stringify(rawOutput ?? null)
        }];
      });
  }

  function evaluateLocalTerminalDecision(options = {}) {
    const runtime = options.runtime || globalScope.WebAgentRuntimeV2;
    const candidate = options.candidate && typeof options.candidate === "object"
      ? options.candidate
      : {};
    const goal = options.goal && typeof options.goal === "object"
      ? options.goal
      : {};
    const evidence = Array.isArray(options.evidence) ? options.evidence : [];
    const evidenceById = new Map(
      evidence.filter((item) => item?.id).map((item) => [item.id, item])
    );
    const citedIds = uniqueStrings(candidate.completionEvidence);
    const citedEvidence = citedIds.map((id) => evidenceById.get(id)).filter(Boolean);
    const currentPageEvidenceId = stringValue(options.currentPageEvidenceId);
    const base = {
      version: VERSION,
      verified: false,
      useRemoteVerifier: true,
      reason: "",
      verifier: null,
      completionGate: null
    };

    if (!runtime?.evaluateCompletion || !TERMINAL_STATUSES.has(candidate.status)) {
      return { ...base, reason: "non-terminal-or-runtime-unavailable" };
    }
    if (!stringValue(candidate.message).trim()) {
      return { ...base, reason: "missing-user-visible-result" };
    }
    if (!citedIds.length || citedEvidence.length !== citedIds.length) {
      return { ...base, reason: "missing-or-unavailable-evidence" };
    }

    const deliverableKind = stringValue(goal?.deliverable?.kind);
    if (candidate.status === "answer") {
      const directPageGrounding = Boolean(
        currentPageEvidenceId
        && citedIds.includes(currentPageEvidenceId)
        && citedEvidence.every((item) => item.source === "page_observation")
      );
      if (
        deliverableKind !== "answer"
        || candidate.verification?.required !== false
        || !directPageGrounding
        || !answerHasExactPageSupport(candidate, goal, citedEvidence)
      ) {
        return { ...base, reason: "answer-needs-semantic-verification" };
      }
    }

    if (candidate.status === "completed") {
      if (!["effect", "collection"].includes(deliverableKind)) {
        return { ...base, reason: "terminal-status-needs-semantic-verification" };
      }
      if (
        !Array.isArray(candidate.verification?.successCriteria)
        || !candidate.verification.successCriteria.length
        || !stringValue(candidate.verification?.expectedChange).trim()
      ) {
        return { ...base, reason: "completion-contract-is-not-observable" };
      }
      if (
        deliverableKind === "effect"
        && (
          !citedEvidence.some((item) => (
            item.source === "action_result"
            && evidenceShowsMaterialChange(item)
          ))
          || !messageCoversObjective(candidate.message, goal.objective)
        )
      ) {
        return { ...base, reason: "effect-needs-semantic-verification" };
      }
      if (
        deliverableKind === "collection"
        && citedEvidence.some((item) => (
          item.source === "tool_result"
          && item.payload?.toolName !== "runtime.export_collection"
        ))
      ) {
        return { ...base, reason: "collection-includes-unbounded-tool-evidence" };
      }
    }

    const completionGate = runtime.evaluateCompletion({
      goal,
      candidate,
      verifier: {},
      evidence,
      pendingApproval: options.pendingApproval || null,
      pendingEffects: options.pendingEffects || {},
      currentPageEvidenceId,
      requireCurrentPageEvidence: options.requireCurrentPageEvidence !== false
    });
    if (!completionGate.verified) {
      return {
        ...base,
        reason: "runtime-completion-gate-rejected",
        completionGate
      };
    }
    const verifier = {
      version: "1.0",
      status: "verified",
      message: stringValue(
        options.verifiedMessage
        || "The runtime accepted exact, locally bound completion evidence."
      ),
      evidenceIds: completionGate.evidenceIds,
      missingEvidence: [],
      confidence: 1,
      source: "deterministic-runtime"
    };
    return {
      version: VERSION,
      verified: true,
      useRemoteVerifier: false,
      reason: "deterministic-runtime-evidence",
      verifier,
      completionGate
    };
  }

  function answerHasExactPageSupport(candidate, goal, citedEvidence) {
    const messageTerms = tokenize(candidate.message);
    const objectiveTerms = tokenize(goal?.objective);
    const evidenceTerms = tokenize(citedEvidence.map((item) => (
      collectScalarEvidenceText([
        item.payload?.title || "",
        item.payload?.visibleText || "",
        item.payload?.liveRegions || [],
        item.payload?.forms || [],
        item.payload?.tables || [],
        item.payload?.interactiveElements || []
      ])
    )).join("\n"));
    const groundedMessageTerms = messageTerms.filter((term) => (
      evidenceTerms.some((evidenceTerm) => termsOverlap(term, evidenceTerm))
    ));
    const resultTerms = groundedMessageTerms.filter((term) => (
      isSubstantiveResultTerm(term)
      &&
      !objectiveTerms.some((objectiveTerm) => termsOverlap(term, objectiveTerm))
    ));
    return groundedMessageTerms.length > 0 && resultTerms.length > 0;
  }

  function collectScalarEvidenceText(value, depth = 0) {
    if (depth > 6 || value === undefined || value === null) {
      return "";
    }
    if (Array.isArray(value)) {
      return value.map((item) => collectScalarEvidenceText(item, depth + 1))
        .filter(Boolean)
        .join("\n");
    }
    if (typeof value === "object") {
      return Object.entries(value)
        .filter(([key]) => !NON_SEMANTIC_EVIDENCE_KEYS.has(key))
        .map(([, item]) => collectScalarEvidenceText(item, depth + 1))
        .filter(Boolean)
        .join("\n");
    }
    if (["string", "number", "boolean"].includes(typeof value)) {
      return stringValue(value);
    }
    return "";
  }

  function isSubstantiveResultTerm(term) {
    return (
      /^\p{N}+$/u.test(term)
      || /[^\u0000-\u007f]/u.test(term)
      || term.length >= 4
    );
  }

  function messageCoversObjective(message, objective) {
    const messageTerms = tokenize(message);
    const objectiveTerms = tokenize(objective);
    return messageTerms.some((messageTerm) => (
      objectiveTerms.some((objectiveTerm) => termsOverlap(messageTerm, objectiveTerm))
    ));
  }

  function termsOverlap(left, right) {
    if (left === right) {
      return true;
    }
    const shorter = left.length <= right.length ? left : right;
    const longer = left.length > right.length ? left : right;
    return shorter.length >= 2 && longer.startsWith(shorter);
  }

  function evidenceShowsMaterialChange(item) {
    const payload = item?.payload || {};
    if (payload.ok === false) {
      return false;
    }
    return Boolean(
      payload.changed === true
      || payload.effect?.changed === true
      || payload.goal?.satisfied === true
      || payload.verification?.changed === true
      || payload.verification?.materialChanged === true
      || payload.verification?.urlChanged === true
      || payload.verification?.targetChanged === true
      || payload.verification?.valueChanged === true
    );
  }

  function selectRelevantText(value, objective, maxChars) {
    const text = stringValue(value);
    const budget = Math.max(256, normalizePositiveInteger(maxChars, text.length || 256));
    if (text.length <= budget) {
      return text;
    }
    const chunks = splitTextChunks(text, Math.max(240, Math.min(900, Math.ceil(budget / 8))));
    const terms = tokenize(objective);
    const candidates = chunks.map((chunk, index) => ({
      chunk,
      index,
      score: scoreText(chunk, terms)
        + (index === 0 ? 2 : 0)
        + (index === chunks.length - 1 ? 1 : 0)
    }));
    candidates.sort((left, right) => (
      right.score - left.score
      || left.index - right.index
    ));
    const selected = [];
    let used = 0;
    for (const candidate of candidates) {
      const size = candidate.chunk.length + (selected.length ? 2 : 0);
      if (selected.length && used + size > budget) {
        continue;
      }
      selected.push(candidate);
      used += size;
      if (used >= budget) {
        break;
      }
    }
    selected.sort((left, right) => left.index - right.index);
    return selected.map((item) => item.chunk).join("\n\n").slice(0, budget);
  }

  function selectRelevantItems(items, objective, options = {}) {
    const source = Array.isArray(items) ? items : [];
    const maxItems = normalizePositiveInteger(options.maxItems, source.length || 1);
    const maxChars = normalizePositiveInteger(options.maxChars, Number.MAX_SAFE_INTEGER);
    const terms = tokenize(objective);
    const ranked = source.map((item, index) => {
      const serialized = JSON.stringify(item);
      return {
        item,
        index,
        serialized,
        score: scoreText(serialized, terms)
      };
    }).sort((left, right) => (
      right.score - left.score
      || left.index - right.index
    ));
    const selected = [];
    let used = 2;
    for (const candidate of ranked) {
      const size = candidate.serialized.length + 1;
      if (
        selected.length >= maxItems
        || (selected.length && used + size > maxChars)
      ) {
        continue;
      }
      selected.push(candidate);
      used += size;
    }
    selected.sort((left, right) => left.index - right.index);
    return selected.map((entry) => entry.item);
  }

  function splitTextChunks(text, targetSize) {
    const chunks = [];
    const blocks = text.split(/\n{2,}/u);
    for (const block of blocks) {
      const normalized = block.trim();
      if (!normalized) {
        continue;
      }
      if (normalized.length <= targetSize) {
        chunks.push(normalized);
        continue;
      }
      for (let offset = 0; offset < normalized.length; offset += targetSize) {
        chunks.push(normalized.slice(offset, offset + targetSize));
      }
    }
    return chunks.length ? chunks : [text.slice(0, targetSize)];
  }

  function scoreText(value, terms) {
    if (!terms.length) {
      return 0;
    }
    const normalized = normalizeText(value);
    let score = 0;
    for (const term of terms) {
      if (normalized.includes(term)) {
        score += 1 + Math.min(3, normalized.split(term).length - 1);
      }
    }
    return score;
  }

  function tokenize(value) {
    return Array.from(new Set(
      normalizeText(value)
        .split(/[^\p{L}\p{N}_.-]+/u)
        .filter((item) => item.length >= 2 || /^\p{N}+$/u.test(item))
    ));
  }

  function summarizeRunLatency(logs, options = {}) {
    const requests = (Array.isArray(logs) ? logs : [])
      .filter((entry) => entry?.kind === "ai-request");
    const durations = requests
      .map((entry) => normalizeNonnegativeInteger(entry.durationMs, 0))
      .sort((left, right) => left - right);
    const firstBytes = requests
      .map((entry) => Number(entry.firstByteMs))
      .filter((value) => Number.isFinite(value) && value >= 0)
      .sort((left, right) => left - right);
    const byStage = {};
    for (const request of requests) {
      const stage = stringValue(request.stage || classifyStage(request.purpose));
      const bucket = byStage[stage] || {
        calls: 0,
        durationMs: 0,
        inputTokens: 0,
        outputTokens: 0
      };
      bucket.calls += 1;
      bucket.durationMs += normalizeNonnegativeInteger(request.durationMs, 0);
      bucket.inputTokens += normalizeNonnegativeInteger(request.usage?.inputTokens, 0);
      bucket.outputTokens += normalizeNonnegativeInteger(request.usage?.outputTokens, 0);
      byStage[stage] = bucket;
    }
    const rawCallBudget = Number(options.callBudget);
    const hasCallBudget = Number.isFinite(rawCallBudget) && rawCallBudget >= 0;
    const callBudget = hasCallBudget ? Math.trunc(rawCallBudget) : null;
    const milestoneSource = options.milestones && typeof options.milestones === "object"
      ? options.milestones
      : {};
    const milestones = {};
    for (const [name, value] of Object.entries(milestoneSource)) {
      if (/^[a-z][A-Za-z0-9]*Ms$/u.test(name)) {
        milestones[name] = normalizeNonnegativeInteger(value, 0);
      }
    }
    const wallClockDurationMs = normalizeNonnegativeInteger(
      options.wallClockDurationMs,
      milestones.completedMs || 0
    );
    return {
      version: VERSION,
      requestCount: requests.length,
      callBudget,
      withinCallBudget: hasCallBudget ? requests.length <= callBudget : null,
      wallClockDurationMs,
      milestones,
      totalDurationMs: durations.reduce((sum, value) => sum + value, 0),
      p50RequestMs: percentile(durations, 0.5),
      p95RequestMs: percentile(durations, 0.95),
      p50FirstByteMs: percentile(firstBytes, 0.5),
      p95FirstByteMs: percentile(firstBytes, 0.95),
      byStage
    };
  }

  function percentile(sortedValues, ratio) {
    if (!sortedValues.length) {
      return null;
    }
    const index = Math.min(
      sortedValues.length - 1,
      Math.max(0, Math.ceil(sortedValues.length * ratio) - 1)
    );
    return sortedValues[index];
  }

  function normalizeText(value) {
    return stringValue(value).normalize("NFKC").toLocaleLowerCase();
  }

  function uniqueStrings(values) {
    return Array.from(new Set(
      (Array.isArray(values) ? values : [])
        .map((item) => stringValue(item).trim())
        .filter(Boolean)
    ));
  }

  function normalizePositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  }

  function normalizeNonnegativeInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
  }

  function clampNumber(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
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
        // Fall through for VM and extension contexts without clone support.
      }
    }
    return JSON.parse(JSON.stringify(value));
  }

  const api = Object.freeze({
    VERSION,
    classifyStage,
    normalizeLatencyMode,
    resolveStageProfile,
    resolveReasoningEffort,
    resolveTextVerbosity,
    buildCacheScope,
    resolveOutputBudget,
    estimateSchemaInputTokens,
    estimateSchemaOutputTokens,
    shouldUseNativeTools,
    buildNativeDecisionTool,
    evaluateFastPlannerEscalation,
    evaluateFastRoute,
    normalizeProviderToolOutputs,
    evaluateLocalTerminalDecision,
    selectRelevantText,
    selectRelevantItems,
    summarizeRunLatency,
    percentile
  });

  globalScope.WebAgentLatencyStrategyV2 = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

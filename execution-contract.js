(function initializeExecutionContract(globalScope) {
  "use strict";

  const AgentCore = globalScope.WebAgentCore
    || (typeof require === "function" ? require("./agent-core.js") : null);
  if (!AgentCore) {
    throw new Error("WebAgentCore must be loaded before execution-contract.js.");
  }

  const EXTERNALLY_BLOCKED_ACTION_TYPES = new Set([
    "upload",
    "visual_click",
    "tab_focus",
    "tab_adopt",
    "tab_close",
    "download",
    "download_wait"
  ]);
  const EXTERNAL_ACTION_TYPES = Object.freeze(
    AgentCore.ACTION_TYPES.filter((type) => !EXTERNALLY_BLOCKED_ACTION_TYPES.has(type))
  );
  const EXTERNAL_ACTION_TYPE_SET = new Set(EXTERNAL_ACTION_TYPES);
  const READ_ONLY_ACTION_TYPES = new Set(["focus", "hover", "scroll", "wait", "wait_for", "extract"]);
  const EXTERNAL_ACTION_FIELDS = Object.freeze([
    "id",
    "type",
    "ref",
    "selector",
    "text",
    "value",
    "checked",
    "key",
    "code",
    "direction",
    "block",
    "inline",
    "amount",
    "url",
    "ms",
    "conditionJson",
    "altKey",
    "ctrlKey",
    "metaKey",
    "shiftKey",
    "reason"
  ]);
  const EXTERNAL_ACTION_FIELD_SET = new Set(EXTERNAL_ACTION_FIELDS);

  function cloneJson(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function getExternalActionSchema() {
    const source = AgentCore.DECISION_SCHEMA?.properties?.actions?.items;
    if (!source?.properties) {
      throw new Error("Agent action schema is unavailable.");
    }
    const properties = {};
    for (const key of EXTERNAL_ACTION_FIELDS) {
      if (source.properties[key]) {
        properties[key] = cloneJson(source.properties[key]);
      }
    }
    properties.type = {
      ...properties.type,
      enum: [...EXTERNAL_ACTION_TYPES]
    };
    return {
      type: "object",
      additionalProperties: false,
      properties,
      required: ["type"]
    };
  }

  function normalizeExternalActions(input, options = {}) {
    if (!Array.isArray(input)) {
      throw new TypeError("actions must be an array.");
    }
    const maxActions = normalizePositiveInteger(options.maxActions, 8);
    if (!input.length) {
      throw new Error("At least one action is required.");
    }
    if (input.length > maxActions) {
      throw new Error(`No more than ${maxActions} actions may be submitted at once.`);
    }
    input.forEach((action, index) => {
      if (!action || typeof action !== "object" || Array.isArray(action)) {
        throw new TypeError(`actions[${index}] must be an object.`);
      }
      const unknown = Object.keys(action).filter((key) => !EXTERNAL_ACTION_FIELD_SET.has(key));
      if (unknown.length) {
        throw new Error(`actions[${index}] contains fields that external clients cannot set: ${unknown.join(", ")}`);
      }
      if (!EXTERNAL_ACTION_TYPE_SET.has(String(action.type || "").trim().toLowerCase())) {
        throw new Error(`actions[${index}] uses an unavailable external action type: ${action.type || "missing"}`);
      }
    });

    const decision = AgentCore.normalizeDecision({ status: "continue", actions: input }, {
      step: 1,
      maxEffects: maxActions
    });
    return decision.actions.map((action, index) => ({
      ...action,
      id: String(action.id || `external-action-${index + 1}`)
    }));
  }

  function validateExternalActions(actions, context, options = {}) {
    const maxActions = normalizePositiveInteger(options.maxActions, 8);
    let normalized;
    try {
      normalized = normalizeExternalActions(actions, { maxActions });
    } catch (error) {
      return { valid: false, errors: [error.message || String(error)], warnings: [], actions: [] };
    }
    const decision = AgentCore.normalizeDecision({ status: "continue", actions: normalized }, {
      step: 1,
      maxEffects: maxActions
    });
    const validation = AgentCore.validateDecision(decision, { context, maxEffects: maxActions });
    return { ...validation, actions: normalized };
  }

  function validateResolvedVisualActions(actions, context) {
    if (!Array.isArray(actions) || actions.length !== 1 || actions[0]?.type !== "visual_click") {
      return {
        valid: false,
        errors: ["A resolved visual proposal must contain exactly one visual_click."],
        warnings: [],
        actions: []
      };
    }
    const decision = AgentCore.normalizeDecision({
      version: "1.0",
      status: "continue",
      message: "",
      summary: "Extension-resolved visual action",
      progress: "",
      doneReason: "",
      completionEvidence: [],
      needsUserApproval: true,
      plan: [],
      toolCalls: [],
      actions,
      verification: {
        required: true,
        expectedChange: "The described visual target responds.",
        successCriteria: []
      }
    }, { maxEffects: 1 });
    const validation = AgentCore.validateDecision(decision, { context, maxEffects: 1 });
    return { ...validation, actions: decision.actions };
  }

  function findActionTarget(action, context) {
    return AgentCore.findTarget(action || {}, context || {});
  }

  function digestValue(value) {
    const canonical = AgentCore.stableStringify(value === undefined ? null : value);
    return `${canonical.length.toString(36)}:${AgentCore.hashString(canonical)}`;
  }

  function summarizeTargetForPrecondition(target) {
    if (!target) {
      return null;
    }
    return {
      ref: stringValue(target.ref),
      selector: stringValue(target.selector),
      scope: stringValue(target.scope),
      frameId: Number.isInteger(Number(target.frameId)) ? Number(target.frameId) : 0,
      parentFrameId: Number.isInteger(Number(target.parentFrameId)) ? Number(target.parentFrameId) : -1,
      frameDocumentId: stringValue(target.frameDocumentId),
      frameUrl: stringValue(target.frameUrl),
      rectSpace: stringValue(target.rectSpace),
      rectDigest: digestValue(target.rect || null),
      tag: stringValue(target.tag),
      kind: stringValue(target.kind),
      role: stringValue(target.role),
      type: stringValue(target.type),
      label: stringValue(target.label),
      name: stringValue(target.name),
      autocomplete: stringValue(target.autocomplete),
      href: stringValue(target.href),
      formAction: stringValue(target.formAction),
      formMethod: stringValue(target.formMethod).toLowerCase(),
      disabled: Boolean(target.disabled),
      ariaDisabled: Boolean(target.ariaDisabled),
      actionability: stringValue(target.actionability),
      readOnly: Boolean(target.readOnly),
      contentEditable: Boolean(target.contentEditable),
      sensitive: Boolean(target.sensitive),
      checkedDigest: digestValue(target.checked),
      valueDigest: digestValue(target.value),
      optionsDigest: digestValue((target.options || []).map((option) => ({
        value: option?.value,
        label: option?.label,
        selected: Boolean(option?.selected),
        disabled: Boolean(option?.disabled)
      })))
    };
  }

  function summarizeBrowserTab(tab) {
    if (!tab) {
      return null;
    }
    return {
      tabId: Number(tab.tabId ?? tab.id),
      windowId: Number.isFinite(Number(tab.windowId)) ? Number(tab.windowId) : null,
      openerTabId: Number.isFinite(Number(tab.openerTabId)) ? Number(tab.openerTabId) : null,
      active: Boolean(tab.active),
      title: stringValue(tab.title),
      url: stringValue(tab.url)
    };
  }

  function buildActionPreconditions(actions, context) {
    return (actions || []).map((action) => ({
      actionId: stringValue(action.id),
      documentId: stringValue(context?.documentId),
      pageUrl: stringValue(context?.url),
      contextDigest: contextDigest(context),
      visualObservationId: stringValue(action.visualObservationId),
      lookup: {
        ref: stringValue(action.ref),
        selector: stringValue(action.selector),
        text: stringValue(action.text)
      },
      target: summarizeTargetForPrecondition(findActionTarget(action, context)),
      browserTab: action.tabId
        ? summarizeBrowserTab((context?.browser?.tabs || []).find((tab) => Number(tab.tabId) === Number(action.tabId)))
        : null
    }));
  }

  function validateActionPreconditions(preconditionsOrDecision, context) {
    const errors = [];
    const preconditions = Array.isArray(preconditionsOrDecision)
      ? preconditionsOrDecision
      : preconditionsOrDecision?.preconditions || [];
    const actions = Array.isArray(preconditionsOrDecision?.actions)
      ? preconditionsOrDecision.actions
      : preconditions.map((item) => ({ id: item.actionId, ...(item.lookup || {}) }));
    const byActionId = new Map(preconditions.map((item) => [String(item.actionId || ""), item]));

    if (preconditionsOrDecision?.observedDocumentId
      && preconditionsOrDecision.observedDocumentId !== context?.documentId) {
      return { valid: false, errors: ["The observed document was replaced before execution."] };
    }
    if (preconditionsOrDecision?.observedPageUrl
      && preconditionsOrDecision.observedPageUrl !== context?.url) {
      return { valid: false, errors: ["The observed page URL changed before execution."] };
    }

    for (const action of actions) {
      const precondition = byActionId.get(String(action.id || ""));
      if (!precondition) {
        errors.push(`Missing precondition for action ${action.id || "unknown"}.`);
        continue;
      }
      if (precondition.documentId && precondition.documentId !== context?.documentId) {
        errors.push(`The document changed for action ${action.id || "unknown"}.`);
        continue;
      }
      if (precondition.pageUrl && precondition.pageUrl !== context?.url) {
        errors.push(`The page URL changed for action ${action.id || "unknown"}.`);
        continue;
      }
      if (
        precondition.visualObservationId
        && precondition.visualObservationId !== context?.visualObservation?.id
      ) {
        errors.push(`The visual observation changed for action ${action.id || "unknown"}.`);
        continue;
      }
      if (precondition.browserTab) {
        const currentTab = summarizeBrowserTab((context?.browser?.tabs || []).find(
          (tab) => Number(tab.tabId ?? tab.id) === Number(precondition.browserTab.tabId)
        ));
        if (AgentCore.stableStringify(currentTab) !== AgentCore.stableStringify(precondition.browserTab)) {
          errors.push(`The browser tab changed for action ${action.id || "unknown"}.`);
          continue;
        }
      }
      if (!precondition.target) {
        continue;
      }
      const lookupAction = { ...action, ...(precondition.lookup || {}) };
      const currentTarget = summarizeTargetForPrecondition(findActionTarget(lookupAction, context));
      if (AgentCore.stableStringify(currentTarget) !== AgentCore.stableStringify(precondition.target)) {
        errors.push(`The target changed or disappeared for action ${action.id || "unknown"}.`);
      }
    }
    const uniqueErrors = uniqueStrings(errors);
    return { valid: uniqueErrors.length === 0, errors: uniqueErrors };
  }

  function contextDigest(context) {
    return digestValue({
      documentId: context?.documentId || "",
      url: context?.url || "",
      domRevision: context?.pageState?.domRevision ?? context?.domRevision ?? null,
      frameRevisions: context?.pageState?.frameRevisions || [],
      elements: [
        ...(context?.interactiveElements || []),
        ...(context?.scrollRegions || []),
        ...(context?.visualSurfaces || [])
      ].map(summarizeTargetForPrecondition)
    });
  }

  function canonicalizeActions(actions) {
    return (actions || []).map((action) => Object.fromEntries(
      Object.entries(action || {})
        .filter(([key, value]) => EXTERNAL_ACTION_FIELD_SET.has(key) && value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
    ));
  }

  function effectDigest(actions) {
    const canonical = AgentCore.stableStringify(canonicalizeActions(actions));
    return `effects-v1:${canonical.length.toString(36)}:${AgentCore.hashString(canonical)}`;
  }

  function isSensitiveTarget(target) {
    if (!target) {
      return false;
    }
    if (target.sensitive || String(target.type || "").toLowerCase() === "password") {
      return true;
    }
    const descriptor = [target.type, target.autocomplete, target.label, target.name]
      .filter(Boolean)
      .join(" ");
    return /password|secret|token|api.?key|card|cvv|cvc|ssn|주민|비밀번호|인증.?번호/i.test(descriptor);
  }

  function isSubmitLikeClick(action, target) {
    return action?.type === "click"
      && target?.tag === "button"
      && (!target.type || target.type === "submit");
  }

  function isApprovalSensitiveAction(action, target) {
    return Boolean(
      action?.type === "submit"
      || action?.type === "visual_click"
      || action?.type === "navigate"
      || action?.type === "tab_open"
      || isSubmitLikeClick(action, target)
      || target?.href
      || (target?.formAction && String(target.formMethod || "get").toLowerCase() !== "get")
    );
  }

  function actionChangesState(action) {
    return !READ_ONLY_ACTION_TYPES.has(action?.type);
  }

  function assessActionSafety(input, positionalContext, positionalSettings) {
    const options = Array.isArray(input)
      ? { actions: input, context: positionalContext, settings: positionalSettings }
      : input || {};
    const actions = options.actions || [];
    const context = options.context || null;
    const settings = options.settings || {};
    const policy = options.policy || null;
    const validation = options.validation || null;
    const blockedReasons = [];
    const warnings = [];
    const approvalReasons = [];

    if (!context) {
      blockedReasons.push("A current browser observation is required.");
    }
    if (validation && !validation.valid) {
      blockedReasons.push(...(validation.errors || []));
      warnings.push(...(validation.warnings || []));
    }
    if (policy?.verdict === "block") {
      blockedReasons.push(policy.message || "The independent policy gate blocked this operation.");
      blockedReasons.push(...(policy.risks || []));
    } else if (policy?.verdict === "approval") {
      approvalReasons.push(...(
        policy.approvalReasons?.length
          ? policy.approvalReasons
          : [policy.message || "The independent policy gate requires approval."]
      ));
    }
    warnings.push(...(policy?.risks || []));

    for (const action of actions) {
      const resolvedVisualAction = options.allowResolvedVisual === true && action?.type === "visual_click";
      if (!EXTERNAL_ACTION_TYPE_SET.has(action?.type) && !resolvedVisualAction) {
        blockedReasons.push(`External clients cannot use action type ${action?.type || "missing"}.`);
        continue;
      }
      const target = findActionTarget(action, context);
      if (settings.stopOnSensitiveInput !== false && action.type === "fill" && isSensitiveTarget(target)) {
        blockedReasons.push(`Sensitive input is blocked for ${target?.label || action.ref || action.selector || action.id}.`);
      }
      if (settings.bridgeRequireApproval !== false && actionChangesState(action)) {
        approvalReasons.push(`External state-changing action requires approval: ${action.type}.`);
      } else if (isApprovalSensitiveAction(action, target)) {
        approvalReasons.push(`Consequential action requires approval: ${action.type}.`);
      }
    }

    const uniqueBlockedReasons = uniqueStrings(blockedReasons);
    const uniqueApprovalReasons = uniqueStrings(approvalReasons);
    const uniqueWarnings = uniqueStrings(warnings);
    return {
      blocked: uniqueBlockedReasons.length > 0,
      requiresApproval: uniqueApprovalReasons.length > 0,
      reasons: uniqueStrings([...uniqueBlockedReasons, ...uniqueApprovalReasons]),
      blockedReasons: uniqueBlockedReasons,
      approvalReasons: uniqueApprovalReasons,
      warnings: uniqueWarnings
    };
  }

  function sanitizeActions(actions) {
    return (actions || []).map((action) => ({
      ...canonicalizeActions([action])[0],
      ...(action?.type === "fill" && Object.hasOwn(action, "value") ? { value: "[redacted]" } : {})
    }));
  }

  function normalizePositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  function stringValue(value) {
    return value === undefined || value === null ? "" : String(value);
  }

  function uniqueStrings(values) {
    return Array.from(new Set((values || []).map(stringValue).filter(Boolean)));
  }

  const api = Object.freeze({
    EXTERNAL_ACTION_FIELDS,
    EXTERNAL_ACTION_TYPES,
    actionChangesState,
    assessActionSafety,
    buildActionPreconditions,
    canonicalizeActions,
    contextDigest,
    effectDigest,
    findActionTarget,
    getExternalActionSchema,
    isApprovalSensitiveAction,
    isSensitiveTarget,
    normalizeExternalActions,
    sanitizeActions,
    summarizeTargetForPrecondition,
    validateActionPreconditions,
    validateExternalActions,
    validateResolvedVisualActions,
    validateJsonAgainstSchema: AgentCore.validateJsonAgainstSchema
  });

  globalScope.WebExecutionContract = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

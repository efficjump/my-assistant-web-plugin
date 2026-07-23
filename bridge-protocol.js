(function initializeBridgeProtocol(globalScope) {
  "use strict";

  const Contract = globalScope.WebExecutionContract
    || (typeof require === "function" ? require("./execution-contract.js") : null);
  if (!Contract) {
    throw new Error("WebExecutionContract must be loaded before bridge-protocol.js.");
  }

  const protocolVersion = "2.2";
  const instructions = `This MCP server controls only the browser tab explicitly shared by the user in the extension.
Call browser_begin once with the user's complete browser goal. It starts or resumes the caller's short-lived session and returns the current redacted page snapshot. Use only refs from that snapshot. When a needed visible control is absent, prefer browser_elements with a goal-derived query, semantic roles, and nearby visible text so the extension can retrieve relevant controls locally like a source-code search. Continue a returned cursor only when more matches are needed; an element-count limit is never by itself a blocker or a reason to ask the user to click. Use scroll actions and re-observe when the target is outside the current viewport. Call browser_act with the next bounded action or action group; session, observation, and idempotency identifiers are managed internally. browser_act accepts proposals, not trusted commands: the extension independently validates policy and safety, may require an in-extension approval, and re-observes immediately before execution. After every proposal, call browser_continue. Pass refresh=true when the visible page or observation settings may have changed without an operation. If approval is required, ask the user to review the extension and call browser_continue again after their decision; never submit a duplicate proposal. For a visible canvas or application-surface target with no DOM ref, call browser_visual_act with only its surface ref and a precise target description; the extension-owned model locates and independently verifies the point. Repeat discovery, act, and continue until the visible result satisfies the goal, then call browser_end before the final answer. Use browser_screenshot only when visible pixels are necessary. Never request, expose, or infer credentials and sensitive field values.`;
  const advancedInstructions = `This MCP server is using the advanced identifier-based browser workflow.
Start with browser_status and browser_session_start, then call browser_observe before proposing actions. The session owns the canonical goal supplied at start, so later execution proposals cannot replace or paraphrase it. Use only element refs from the latest observation. When a needed visible control is absent, prefer browser_elements with a goal-derived query, semantic roles, and nearby visible text so the extension retrieves relevant controls locally instead of paging blindly. Continue a returned cursor only when more matches are needed; truncation is never a terminal blocker. Use scroll actions and re-observe for offscreen targets. Treat an acquired session as one multi-step transaction: while the user's objective remains incomplete, continue with the next required tool call instead of ending a turn with only a progress announcement. Stop only when the objective is complete, the user must perform an approval or other direct action, or a concrete blocker prevents progress. browser_execute accepts proposals, not trusted commands: the extension independently validates policy and safety, may require an in-extension approval, re-observes immediately before execution, and returns an operation ID. Use browser_visual_act for a visible canvas or application-surface target with no DOM ref; do not invent or submit coordinates. Poll browser_operation_get with the same operation ID after an approval; never create a duplicate proposal to bypass the approval gate. Close the session after completion or a terminal blocker. Never request, expose, or infer credentials and sensitive field values.`;

  const identifierSchema = {
    type: "string",
    minLength: 1,
    maxLength: 160,
    pattern: "^[A-Za-z0-9._:-]+$"
  };

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function objectSchema(properties = {}, required = []) {
    return {
      type: "object",
      additionalProperties: false,
      properties,
      ...(required.length ? { required } : {})
    };
  }

  function elementDiscoveryProperties() {
    return {
      cursor: {
        type: "string",
        maxLength: 24000,
        description: "Opaque nextCursor from the latest elementDiscovery result. Omit it to start a new query or continue with the current snapshot's cursor."
      },
      query: {
        type: "string",
        maxLength: 500,
        description: "Goal-derived visible label, attribute, or symbol terms used to rank and filter controls locally."
      },
      roles: {
        type: "array",
        maxItems: 12,
        items: {
          type: "string",
          maxLength: 80,
          pattern: "^[A-Za-z0-9_.:-]+$"
        },
        description: "Optional semantic roles, tags, or input types such as button, link, textbox, or checkbox."
      },
      near_text: {
        type: "string",
        maxLength: 500,
        description: "Optional visible row, table, form, dialog, region, or group text near the intended control."
      }
    };
  }

  function visualActionProperties() {
    return {
      surface_ref: {
        type: "string",
        minLength: 1,
        maxLength: 160,
        description: "Visual surface ref from the latest snapshot."
      },
      target_description: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: "Precise visible target to locate inside the surface. Coordinates are extension-owned and must not be supplied."
      },
      reason: {
        type: "string",
        maxLength: 500,
        description: "Why this target advances the user's retained browser goal."
      }
    };
  }

  function buildToolDefinitions() {
    const actionSchema = Contract.getExternalActionSchema();
    return [
      {
        name: "browser_begin",
        title: "Begin browser task",
        description: "Start or safely resume the caller's browser task and return the current redacted page snapshot. No status or observation call is needed first.",
        inputSchema: objectSchema({
          goal: {
            type: "string",
            minLength: 1,
            maxLength: 4000,
            description: "The complete user objective retained by the extension policy gate for the whole browser task."
          }
        }, ["goal"]),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "browser_act",
        title: "Propose browser actions",
        description: "Propose the next actions using refs from the snapshot most recently returned by browser_begin or browser_continue. Session, observation, and retry identifiers are managed internally.",
        inputSchema: objectSchema({
          actions: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: actionSchema
          }
        }, ["actions"]),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
      },
      {
        name: "browser_elements",
        title: "Inspect more visible controls",
        description: "Retrieve relevant currently visible controls by label terms, semantic roles, and nearby context, or continue that search with its opaque cursor. Prefer a targeted search when the needed ref is absent; truncation alone is not a blocker.",
        inputSchema: objectSchema(elementDiscoveryProperties()),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "browser_continue",
        title: "Continue browser task",
        description: "Return the current proposal status or refresh the redacted page snapshot for the next decision. Call this after every browser_act and after the user handles an approval. Set refresh=true when the page or observation settings may have changed without an operation.",
        inputSchema: objectSchema({
          refresh: {
            type: "boolean",
            description: "Force a new observation instead of returning the cached snapshot when no proposal is pending."
          }
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "browser_screenshot",
        title: "Capture shared tab",
        description: "Capture the visible pixels of the active user-shared tab. The image can contain on-screen private data, so use it only when the task requires visual evidence.",
        inputSchema: objectSchema(),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "browser_visual_act",
        title: "Propose a verified visual action",
        description: "Ask the extension-owned model to locate and independently verify one visible target inside a canvas or application surface. The caller supplies no coordinates, screenshot token, policy result, or approval.",
        inputSchema: objectSchema(visualActionProperties(), ["surface_ref", "target_description"]),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
      },
      {
        name: "browser_end",
        title: "End browser task",
        description: "Release the caller's short-lived browser lease after the goal is complete or a terminal blocker is reached.",
        inputSchema: objectSchema(),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      }
    ];
  }

  function buildAdvancedToolDefinitions() {
    const sessionId = cloneJson(identifierSchema);
    const operationId = cloneJson(identifierSchema);
    const observationId = cloneJson(identifierSchema);
    const idempotencyKey = {
      ...cloneJson(identifierSchema),
      description: "Caller-generated key reused for retries of the exact same proposal."
    };
    const actionSchema = Contract.getExternalActionSchema();
    return [
      {
        name: "browser_status",
        title: "Browser bridge status",
        description: "Check whether the extension and a user-shared tab are available. Follow the returned next instruction immediately when the workflow can continue without user input.",
        inputSchema: objectSchema(),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "browser_session_start",
        title: "Start browser session",
        description: "Acquire a short-lived control session for the tab the user explicitly shared in the extension, then continue immediately with browser_observe.",
        inputSchema: objectSchema({
          goal: {
            type: "string",
            minLength: 1,
            maxLength: 4000,
            description: "The canonical user objective stored by the session and reused by the extension policy gate for every proposal."
          }
        }, ["goal"]),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "browser_observe",
        title: "Observe shared tab",
        description: "Get a redacted accessibility-oriented snapshot and a fresh observation ID for the shared tab, then continue the incomplete workflow from only that snapshot.",
        inputSchema: objectSchema({ session_id: sessionId }, ["session_id"]),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "browser_elements",
        title: "Inspect more visible controls",
        description: "Retrieve relevant currently visible controls by label terms, semantic roles, and nearby context, or continue that observation-bound search cursor. Exhaust relevant matches before reporting a missing-control blocker.",
        inputSchema: objectSchema({
          session_id: cloneJson(identifierSchema),
          ...elementDiscoveryProperties()
        }, ["session_id"]),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "browser_screenshot",
        title: "Capture shared tab",
        description: "Capture the visible pixels of the user-shared tab. The image can contain on-screen private data, so use it only when the user's task requires visual evidence.",
        inputSchema: objectSchema({ session_id: cloneJson(identifierSchema) }, ["session_id"]),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "browser_visual_act",
        title: "Propose a verified visual action",
        description: "Ask the extension-owned model to locate and independently verify one visible target inside a canvas or application surface. Coordinates and verification claims are not accepted from the caller.",
        inputSchema: objectSchema({
          session_id: cloneJson(identifierSchema),
          ...visualActionProperties()
        }, ["session_id", "surface_ref", "target_description"]),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
      },
      {
        name: "browser_execute",
        title: "Propose browser actions",
        description: "Submit actions tied to the latest observation. The extension validates and may wait for user approval before executing.",
        inputSchema: objectSchema({
          session_id: cloneJson(identifierSchema),
          observation_id: observationId,
          idempotency_key: idempotencyKey,
          actions: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: actionSchema
          }
        }, ["session_id", "observation_id", "idempotency_key", "actions"]),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
      },
      {
        name: "browser_operation_get",
        title: "Get browser operation",
        description: "Read the status and sanitized evidence for a submitted browser operation.",
        inputSchema: objectSchema({
          session_id: cloneJson(identifierSchema),
          operation_id: operationId
        }, ["session_id", "operation_id"]),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      },
      {
        name: "browser_session_close",
        title: "Close browser session",
        description: "Required cleanup before the final user-facing answer: release the caller's short-lived lease without changing pairing or shared-tab choice.",
        inputSchema: objectSchema({ session_id: cloneJson(identifierSchema) }, ["session_id"]),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
      }
    ];
  }

  function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) {
      return value;
    }
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
    return value;
  }

  function getToolDefinitions(options = {}) {
    return cloneJson(options.advanced ? buildAdvancedToolDefinitions() : buildToolDefinitions());
  }

  function getInstructions(options = {}) {
    return options.advanced ? advancedInstructions : instructions;
  }

  function validateToolArguments(toolName, args, options = {}) {
    const availableTools = options.advanced === true
      ? buildAdvancedToolDefinitions()
      : options.advanced === false
        ? buildToolDefinitions()
        : [...buildToolDefinitions(), ...buildAdvancedToolDefinitions()];
    const tools = availableTools
      .filter((definition) => definition.name === toolName);
    if (!tools.length) {
      return { valid: false, errors: [`Unknown bridge tool: ${toolName || "missing"}`] };
    }
    const validationErrors = tools.map((tool) =>
      Contract.validateJsonAgainstSchema(args, tool.inputSchema, `${toolName} arguments`)
    );
    if (validationErrors.some((errors) => errors.length === 0)) {
      return { valid: true, errors: [] };
    }
    const errors = validationErrors.sort((left, right) => left.length - right.length)[0];
    return { valid: false, errors };
  }

  const MCP_TOOLS = deepFreeze(buildToolDefinitions());
  const ADVANCED_MCP_TOOLS = deepFreeze(buildAdvancedToolDefinitions());
  const api = Object.freeze({
    ADVANCED_MCP_TOOLS,
    MCP_TOOLS,
    getToolDefinitions,
    getInstructions,
    advancedInstructions,
    instructions,
    protocolVersion,
    validateToolArguments
  });

  globalScope.WebBridgeProtocol = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

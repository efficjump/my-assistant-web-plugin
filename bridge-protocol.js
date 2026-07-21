(function initializeBridgeProtocol(globalScope) {
  "use strict";

  const Contract = globalScope.WebExecutionContract
    || (typeof require === "function" ? require("./execution-contract.js") : null);
  if (!Contract) {
    throw new Error("WebExecutionContract must be loaded before bridge-protocol.js.");
  }

  const protocolVersion = "1.0";
  const instructions = `This MCP server controls only the browser tab explicitly shared by the user in the extension.
Start with browser_status and browser_session_start, then call browser_observe before proposing actions. The session owns the canonical goal supplied at start, so later execution proposals cannot replace or paraphrase it. Use only element refs from the latest observation. Treat an acquired session as one multi-step transaction: while the user's objective remains incomplete, continue with the next required tool call instead of ending a turn with only a progress announcement. Stop only when the objective is complete, the user must perform an approval or other direct action, or a concrete blocker prevents progress. browser_execute accepts proposals, not trusted commands: the extension independently validates policy and safety, may require an in-extension approval, re-observes immediately before execution, and returns an operation ID. Poll browser_operation_get with that same ID after an approval; never create a duplicate proposal to bypass the approval gate. Close the session after completion or a terminal blocker. Never request, expose, or infer credentials and sensitive field values.`;

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

  function buildToolDefinitions() {
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
        name: "browser_screenshot",
        title: "Capture shared tab",
        description: "Capture the visible pixels of the user-shared tab. The image can contain on-screen private data, so use it only when the user's task requires visual evidence.",
        inputSchema: objectSchema({ session_id: cloneJson(identifierSchema) }, ["session_id"]),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
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

  function getToolDefinitions() {
    return cloneJson(buildToolDefinitions());
  }

  function validateToolArguments(toolName, args) {
    const tool = buildToolDefinitions().find((definition) => definition.name === toolName);
    if (!tool) {
      return { valid: false, errors: [`Unknown bridge tool: ${toolName || "missing"}`] };
    }
    const errors = Contract.validateJsonAgainstSchema(args, tool.inputSchema, `${toolName} arguments`);
    return { valid: errors.length === 0, errors };
  }

  const MCP_TOOLS = deepFreeze(buildToolDefinitions());
  const api = Object.freeze({
    MCP_TOOLS,
    getToolDefinitions,
    instructions,
    protocolVersion,
    validateToolArguments
  });

  globalScope.WebBridgeProtocol = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);

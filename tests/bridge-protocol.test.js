const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../agent-core.js");
const Contract = require("../execution-contract.js");
const Protocol = require("../bridge-protocol.js");

function getTools() {
  const tools = Protocol.getToolDefinitions();
  assert.ok(Array.isArray(tools));
  return tools;
}

function getAdvancedTools() {
  const tools = Protocol.getToolDefinitions({ advanced: true });
  assert.ok(Array.isArray(tools));
  return tools;
}

test("bridge publishes the guided browser MCP tool surface by default", () => {
  const names = getTools().map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "browser_act",
    "browser_begin",
    "browser_continue",
    "browser_end",
    "browser_screenshot"
  ]);
});

test("bridge retains the identifier-based tool surface as an advanced option", () => {
  const names = getAdvancedTools().map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "browser_execute",
    "browser_observe",
    "browser_operation_get",
    "browser_screenshot",
    "browser_session_close",
    "browser_session_start",
    "browser_status"
  ]);
  assert.equal(
    Protocol.validateToolArguments("browser_screenshot", { session_id: "session-1" }, { advanced: false }).valid,
    false
  );
  assert.equal(
    Protocol.validateToolArguments("browser_screenshot", { session_id: "session-1" }, { advanced: true }).valid,
    true
  );
});

test("bridge instructions keep multi-step clients working until the session is closed", () => {
  assert.match(Protocol.instructions, /browser_begin once/i);
  assert.match(Protocol.instructions, /identifiers are managed internally/i);
  assert.match(Protocol.instructions, /browser_end before the final answer/i);
  assert.match(Protocol.instructions, /never submit a duplicate proposal/i);
  assert.match(Protocol.getInstructions({ advanced: true }), /browser_session_start/i);
});

test("browser_act derives its action fields from the canonical decision schema", () => {
  const execute = getTools().find((tool) => tool.name === "browser_act");
  assert.ok(execute);
  assert.equal(Object.hasOwn(execute.inputSchema.properties, "goal"), false);
  const externalAction = execute.inputSchema.properties.actions.items;
  const canonicalAction = Core.DECISION_SCHEMA.properties.actions.items;

  assert.equal(externalAction.additionalProperties, false);
  assert.deepEqual(externalAction.required, ["type"]);
  assert.deepEqual(
    Object.keys(externalAction.properties).sort(),
    [...Contract.EXTERNAL_ACTION_FIELDS].sort()
  );
  for (const property of Contract.EXTERNAL_ACTION_FIELDS) {
    if (property === "type") continue;
    assert.deepEqual(externalAction.properties[property], canonicalAction.properties[property]);
  }
  for (const privilegedField of ["tabId", "downloadId", "filename", "accept", "multiple", "adopt"]) {
    assert.equal(Object.hasOwn(externalAction.properties, privilegedField), false);
  }
});

test("browser_execute excludes privileged action types from raw MCP input", () => {
  const execute = getTools().find((tool) => tool.name === "browser_act");
  const actionTypes = execute.inputSchema.properties.actions.items.properties.type.enum;

  for (const unsafe of [
    "upload",
    "visual_click",
    "download",
    "download_wait",
    "tab_focus",
    "tab_adopt",
    "tab_close"
  ]) {
    assert.equal(actionTypes.includes(unsafe), false, `${unsafe} must stay extension-owned`);
  }
  for (const safe of ["click", "fill", "select", "press", "navigate", "wait_for", "extract"] ) {
    assert.equal(actionTypes.includes(safe), true, `${safe} should remain available`);
  }
});

test("MCP callers cannot provide policy, approval, preconditions, settings, or secrets", () => {
  const forbidden = [
    "approval",
    "approved",
    "needsUserApproval",
    "policy",
    "policyVerdict",
    "preconditions",
    "safety",
    "settings",
    "secret",
    "token",
    "apiKey",
    "tabId"
  ];

  for (const tool of [...getTools(), ...getAdvancedTools()]) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    const properties = tool.inputSchema.properties || {};
    for (const field of forbidden) {
      assert.equal(
        Object.hasOwn(properties, field),
        false,
        `${tool.name} must not accept trusted field ${field}`
      );
    }
  }
});

test("exported MCP tool constants cannot mutate future generated schemas", () => {
  const first = getTools();
  const execute = first.find((tool) => tool.name === "browser_act");
  execute.inputSchema.properties.actions.items.properties.type.enum.push("upload");

  const regenerated = Protocol.getToolDefinitions();
  const regeneratedTypes = regenerated
    .find((tool) => tool.name === "browser_act")
    .inputSchema.properties.actions.items.properties.type.enum;
  assert.equal(regeneratedTypes.includes("upload"), false);
  assert.ok(Array.isArray(Protocol.MCP_TOOLS));
  assert.ok(Array.isArray(Protocol.ADVANCED_MCP_TOOLS));
});

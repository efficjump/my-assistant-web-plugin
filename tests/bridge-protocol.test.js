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

test("bridge publishes the bounded browser MCP tool surface", () => {
  const names = getTools().map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "browser_execute",
    "browser_observe",
    "browser_operation_get",
    "browser_screenshot",
    "browser_session_close",
    "browser_session_start",
    "browser_status"
  ]);
});

test("bridge instructions keep multi-step clients working until the session is closed", () => {
  assert.match(Protocol.instructions, /continue with the next required tool call/i);
  assert.match(Protocol.instructions, /Close the session/i);
  assert.match(Protocol.instructions, /never create a duplicate proposal/i);
});

test("browser_execute derives its action fields from the canonical decision schema", () => {
  const execute = getTools().find((tool) => tool.name === "browser_execute");
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
  const execute = getTools().find((tool) => tool.name === "browser_execute");
  const actionTypes = execute.inputSchema.properties.actions.items.properties.type.enum;

  for (const unsafe of [
    "upload",
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

  for (const tool of getTools()) {
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
  const execute = first.find((tool) => tool.name === "browser_execute");
  execute.inputSchema.properties.actions.items.properties.type.enum.push("upload");

  const regenerated = Protocol.getToolDefinitions();
  const regeneratedTypes = regenerated
    .find((tool) => tool.name === "browser_execute")
    .inputSchema.properties.actions.items.properties.type.enum;
  assert.equal(regeneratedTypes.includes("upload"), false);
  assert.ok(Array.isArray(Protocol.MCP_TOOLS));
});

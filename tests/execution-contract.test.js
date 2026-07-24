const test = require("node:test");
const assert = require("node:assert/strict");
const Contract = require("../execution-contract.js");

function observedContext(overrides = {}) {
  return {
    url: "https://example.test/account",
    title: "Account",
    documentId: "document-1",
    domRevision: 7,
    interactiveElements: [{
      ref: "e1",
      scope: "main",
      tag: "input",
      role: "textbox",
      type: "email",
      name: "email",
      label: "Work email",
      autocomplete: "email",
      href: "",
      formAction: "https://example.test/account",
      formMethod: "post",
      disabled: false,
      readOnly: false,
      sensitive: false,
      value: "before@example.test",
      options: [
        { value: "personal", label: "Personal", selected: true, disabled: false },
        { value: "work", label: "Work", selected: false, disabled: false }
      ],
      selector: "input[name='email']",
      ...overrides
    }]
  };
}

function fillAction(overrides = {}) {
  return {
    type: "fill",
    ref: "e1",
    value: "after@example.test",
    reason: "Update the account email",
    ...overrides
  };
}

test("preconditions bind execution to the complete observed target fingerprint", async (t) => {
  const actions = [fillAction()];
  const context = observedContext();
  const preconditions = Contract.buildActionPreconditions(actions, context);

  assert.equal(Contract.validateActionPreconditions(preconditions, context).valid, true);

  const mutations = {
    scope: { scope: "dialog" },
    sensitive: { sensitive: true },
    formAction: { formAction: "https://example.test/delete-account" },
    formMethod: { formMethod: "get" },
    ariaHasPopup: { ariaHasPopup: "menu" },
    ariaExpanded: { ariaExpanded: "false" },
    readOnly: { readOnly: true },
    value: { value: "changed-by-page@example.test" },
    options: {
      options: [
        { value: "personal", label: "Personal", selected: false, disabled: false },
        { value: "work", label: "Work", selected: true, disabled: true }
      ]
    }
  };

  for (const [field, override] of Object.entries(mutations)) {
    await t.test(`rejects a changed ${field}`, () => {
      const result = Contract.validateActionPreconditions(preconditions, observedContext(override));
      assert.equal(result.valid, false, `${field} changes must invalidate the observation`);
      assert.ok(result.errors.length > 0);
    });
  }
});

test("preconditions fingerprint sensitive values without retaining the plaintext", () => {
  const secret = "not-for-runtime-results";
  const context = observedContext({
    type: "password",
    autocomplete: "current-password",
    sensitive: true,
    value: secret
  });
  const preconditions = Contract.buildActionPreconditions([
    fillAction({ value: "replacement-secret" })
  ], context);

  assert.doesNotMatch(JSON.stringify(preconditions), new RegExp(secret));
  assert.equal(Contract.validateActionPreconditions(preconditions, context).valid, true);
  assert.equal(Contract.validateActionPreconditions(
    preconditions,
    observedContext({
      type: "password",
      autocomplete: "current-password",
      sensitive: true,
      value: "a-different-secret"
    })
  ).valid, false);
});

test("preconditions keep a target bound to its observed child frame and top-viewport geometry", () => {
  const context = observedContext({
    ref: "f7:e1",
    scope: "frame-7/top",
    frameId: 7,
    parentFrameId: 0,
    frameDocumentId: "frame-document-7",
    frameUrl: "https://embed.example.test/form",
    rectSpace: "top-viewport",
    rect: { x: 120, y: 240, width: 220, height: 32 }
  });
  const actions = [fillAction({ ref: "f7:e1" })];
  const preconditions = Contract.buildActionPreconditions(actions, context);

  assert.equal(Contract.validateActionPreconditions(preconditions, context).valid, true);
  assert.equal(Contract.validateActionPreconditions(preconditions, observedContext({
    ...context.interactiveElements[0],
    frameDocumentId: "replacement-frame-document"
  })).valid, false);
  assert.equal(Contract.validateActionPreconditions(preconditions, observedContext({
    ...context.interactiveElements[0],
    rect: { x: 120, y: 280, width: 220, height: 32 }
  })).valid, false);
});

test("effect digests are deterministic and bind the material action content", () => {
  const left = [{
    type: "fill",
    ref: "e1",
    value: "hello",
    reason: "Set a value"
  }];
  const reordered = [{
    reason: "Set a value",
    value: "hello",
    ref: "e1",
    type: "fill"
  }];

  assert.equal(Contract.effectDigest(left), Contract.effectDigest(reordered));
  assert.notEqual(
    Contract.effectDigest(left),
    Contract.effectDigest([{ ...left[0], value: "different" }])
  );
});

test("semantic effect keys survive observation ref and selector changes when search context is stable", () => {
  const firstContext = observedContext({
    ref: "e81",
    tag: "button",
    role: "button",
    type: "button",
    name: "",
    label: "Next page",
    selector: "#generated-page-control-81",
    searchMatch: {
      score: 100,
      matchedFields: ["label", "role", "context"],
      contextSnippet: "collection: Issue grid"
    }
  });
  const nextContext = observedContext({
    ref: "e3",
    tag: "button",
    role: "button",
    type: "button",
    name: "",
    label: "Next page",
    selector: "#generated-page-control-144",
    searchMatch: {
      score: 96,
      matchedFields: ["label", "role", "context"],
      contextSnippet: "collection: Issue grid"
    }
  });

  assert.equal(
    Contract.semanticEffectKey({ type: "click", ref: "e81" }, firstContext),
    Contract.semanticEffectKey({ type: "click", ref: "e3" }, nextContext)
  );
  assert.notEqual(
    Contract.semanticEffectKey({ type: "click", ref: "e81" }, firstContext),
    Contract.semanticEffectKey(
      { type: "click", ref: "e3" },
      observedContext({
        ...nextContext.interactiveElements[0],
        searchMatch: {
          ...nextContext.interactiveElements[0].searchMatch,
          contextSnippet: "collection: Audit grid"
        }
      })
    )
  );
});

test("semantic effect keys avoid retaining value and URL-query data", () => {
  const context = observedContext();
  assert.equal(
    Contract.semanticEffectKey(fillAction({ value: "first-private-value" }), context),
    Contract.semanticEffectKey(fillAction({ value: "different-private-value" }), context)
  );
  assert.equal(
    Contract.semanticEffectKey({
      type: "navigate",
      url: "https://example.test/results?page=1&token=first-secret"
    }, context),
    Contract.semanticEffectKey({
      type: "navigate",
      url: "https://example.test/results?page=2&token=second-secret"
    }, context)
  );
  assert.notEqual(
    Contract.semanticEffectKey({
      type: "navigate",
      url: "https://example.test/results?page=1"
    }, context),
    Contract.semanticEffectKey({
      type: "navigate",
      url: "https://example.test/account"
    }, context)
  );
});

test("external control blocks filling a sensitive target", () => {
  const assessment = Contract.assessActionSafety({
    actions: [fillAction({ value: "replacement-secret" })],
    context: observedContext({
      type: "password",
      autocomplete: "current-password",
      sensitive: true,
      value: "redacted"
    }),
    settings: { bridgeRequireApproval: true }
  });

  assert.equal(assessment.blocked, true);
  assert.ok(assessment.reasons.length > 0);
});

test("bridge defaults require user approval for a state-changing action", () => {
  const assessment = Contract.assessActionSafety({
    actions: [{ type: "click", ref: "e1", reason: "Submit the change" }],
    context: observedContext({ tag: "button", role: "button", type: "submit" }),
    settings: { bridgeRequireApproval: true }
  });

  assert.equal(assessment.blocked, false);
  assert.equal(assessment.requiresApproval, true);
  assert.ok(assessment.reasons.length > 0);
});

test("bridge allows deterministic disclosure and same-origin navigation clicks without weakening destructive clicks", () => {
  const disclosureContext = observedContext({
    tag: "button",
    role: "button",
    type: "button",
    formAction: "",
    formMethod: "",
    ariaHasPopup: "menu",
    ariaExpanded: "false"
  });
  const disclosure = Contract.assessActionSafety({
    actions: [{ type: "click", ref: "e1", reason: "Open the actions menu" }],
    context: disclosureContext,
    settings: { bridgeRequireApproval: true }
  });
  assert.equal(disclosure.requiresApproval, false);
  assert.equal(
    Contract.semanticEffectKey({ type: "click", ref: "e1" }, disclosureContext),
    ""
  );
  assert.match(
    Contract.semanticEffectKey(
      { type: "click", ref: "e1" },
      disclosureContext,
      { includeLowRisk: true }
    ),
    /^semantic-effect-v1:/
  );
  assert.equal(
    Contract.isDisclosureClick(
      { type: "click", ref: "e1" },
      disclosureContext.interactiveElements[0]
    ),
    true
  );
  assert.equal(Contract.actionCanSucceedWithoutPageChange({ type: "extract" }), true);
  assert.equal(Contract.actionCanSucceedWithoutPageChange({ type: "wait_for" }), true);
  assert.equal(Contract.actionCanSucceedWithoutPageChange({ type: "scroll" }), false);

  const formDisclosureContext = observedContext({
    tag: "button",
    role: "button",
    type: "submit",
    ariaHasPopup: "menu",
    ariaExpanded: "false",
    formAction: "https://example.test/account/update",
    formMethod: "post"
  });
  const formDisclosure = Contract.assessActionSafety({
    actions: [{ type: "click", ref: "e1", reason: "Submit a form-backed disclosure control" }],
    context: formDisclosureContext,
    settings: { bridgeRequireApproval: false }
  });
  assert.equal(formDisclosure.requiresApproval, true);

  const sameOriginContext = observedContext({
    tag: "a",
    role: "menuitem",
    type: "",
    href: "https://example.test/account/settings",
    formAction: "",
    formMethod: ""
  });
  const sameOriginNavigation = Contract.assessActionSafety({
    actions: [{ type: "click", ref: "e1", reason: "Open settings" }],
    context: sameOriginContext,
    settings: { bridgeRequireApproval: true }
  });
  assert.equal(sameOriginNavigation.requiresApproval, false);

  const crossOriginContext = observedContext({
    tag: "a",
    role: "link",
    type: "",
    href: "https://other.example/settings",
    ariaHasPopup: "menu",
    ariaExpanded: "false",
    formAction: "",
    formMethod: ""
  });
  const crossOriginNavigation = Contract.assessActionSafety({
    actions: [{ type: "click", ref: "e1", reason: "Open another origin" }],
    context: crossOriginContext,
    settings: { bridgeRequireApproval: true }
  });
  assert.equal(crossOriginNavigation.requiresApproval, true);

  const destructiveContext = observedContext({
    tag: "button",
    role: "button",
    type: "button",
    label: "Delete",
    formAction: "",
    formMethod: ""
  });
  const destructive = Contract.assessActionSafety({
    actions: [{ type: "click", ref: "e1", reason: "Delete the resource" }],
    context: destructiveContext,
    settings: { bridgeRequireApproval: false }
  });
  assert.equal(destructive.requiresApproval, true);
});

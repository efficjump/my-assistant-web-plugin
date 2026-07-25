# Agent latency evaluation

This document separates orchestration latency from provider latency. Local tests can prove that redundant requests are not scheduled, repeated safe routes can bypass the model, request bodies stay bounded, and compatibility fallbacks do not repeat unnecessarily. Only a configured live endpoint can measure real first-byte and generation time.

## Performance contract

Runtime v2 selects a path from current settings and runtime evidence:

| Scenario | Normal model-call budget | Escalation conditions |
| --- | ---: | --- |
| Repeated, previously successful semantic DOM action on the same page identity | 0 | Route expired, target no longer resolves uniquely, policy/precondition failure |
| First simple direct DOM action through the compact fast router | 1 | Low routing confidence, ambiguous target, consequential policy, visual or external effect |
| Focused current-page answer through the compact fast router | 2 small fast calls | Insufficient page evidence, invalid answer, unsupported claim |
| Current-page answer through the general planner | 1 | Ambiguous evidence, external tool result, malformed output |
| Simple effect through the general planner | 2 | Consequential policy, stale target, malformed output, ambiguous completion |
| Collection after the first representative record is bound | No planner call per later page | Ambiguous record structure, unsafe pagination, stalled ledger |

The count includes planner and routing calls. Policy, verifier, repair, candidate arbitration, and visual calls appear as explicit escalation stages. A remembered route stores only a local semantic intent and target description; it never stores or replays a DOM ref, selector, approval, or execution binding. The current page must still resolve one live target and pass the normal policy, approval, precondition, native-input, and outcome checks.

## Latency modes

The default mode is `fast`.

| Mode | OpenAI Responses controls | Model routing |
| --- | --- | --- |
| `fast` | `reasoning.effort: low`, `text.verbosity: low`, streaming, adaptive output budget | Optional fast model for compact routing, normal approval-mode DOM planning, focused answers, policy, and verification |
| `balanced` | Provider defaults plus adaptive output budget and streaming | Optional fast model only for bounded answer, routing, policy, and verifier stages |
| `thorough` | Medium reasoning for primary planner/repair work where supported | Primary model for planning and repair; bounded stages may still use the optional fast model |

Automatic execution mode, screenshots, visual actions, repair/replan, low-confidence routing, external tools, blocked/clarify results, and privileged browser effects remain on or escalate to the primary model. If a compatible endpoint explicitly rejects reasoning effort, text verbosity, prompt-cache keys, or Priority processing, that feature is removed independently and remembered for the background worker's lifetime. A generic unnamed compatibility error removes the four optional latency hints together in one bounded retry while preserving structured output and native tools.

OpenAI Responses requests use a stable, non-sensitive `prompt_cache_key` derived from the runtime version, stage, model role, and response contract. The key contains no user prompt, page text, URL, or site identity. `service_tier: priority` is opt-in because it can carry additional cost.

## Deterministic regression suite

Run:

```bash
pnpm run check
pnpm run test:latency
pnpm test
pnpm run test:e2e
```

The latency suite verifies:

- stage-derived output and continuation budgets;
- low-reasoning and low-verbosity request controls;
- primary, fast-planner, and automatic primary escalation routing;
- strict native decision calls and exact call-ID outputs;
- local terminal eligibility and independent-verifier retention;
- coherent continuation compaction without orphaned function items;
- streaming, native-tool, reasoning, verbosity, cache-key, and Priority compatibility fallback;
- zero-call successful-route replay and semantic-only route storage in real Chrome;
- reuse of a verified prefetched observation for one exact semantic target;
- first-decision, first-effect, completion, request-count, and percentile summaries.

Passing this suite does not claim a network speed in milliseconds. It proves that the runtime does not add the removed sequential calls and duplicate observations back into the supported fast paths.

## Live measurement

Use a normal local browser profile with the unpacked extension and the intended endpoint:

1. Run one visibly grounded current-page question.
2. Run one simple reversible page action twice with exactly the same wording and page identity.
3. Run one intentionally ambiguous or consequential action to exercise primary escalation.
4. Export the conversation as JSON.
5. Inspect each run record's `performance` object and the corresponding `ai-request` audit entries.

Important fields:

| Field | Meaning |
| --- | --- |
| `requestCount` | Total model requests made by the run; a remembered local route can be `0` |
| `callBudget` / `withinCallBudget` | Path-specific target and whether the run stayed inside it |
| `wallClockDurationMs` | User-visible run duration, including local observation, approval wait, effects, and model time |
| `milestones.firstDecisionReadyMs` | Time until the first structurally valid runtime decision was ready |
| `milestones.firstApprovalReadyMs` | Time until the first approval card became visible, when approval was required |
| `milestones.firstEffectStartedMs` | Time until the first tool or browser effect began |
| `milestones.firstEffectCompletedMs` | Time until the first effect returned an outcome |
| `milestones.completedMs` | Time until the run reached a terminal state |
| `totalDurationMs` | Sum of model-request durations |
| `p50RequestMs` / `p95RequestMs` | Request latency distribution inside the run |
| `p50FirstByteMs` / `p95FirstByteMs` | Time until the provider began responding |
| `byStage` | Calls, time, and tokens grouped by planner, answer, policy, verifier, repair, visual, or routing stage |
| `latencyMode` / `reasoningEffort` | Requested orchestration mode and reasoning control |
| `modelRole` / `fastPlanner` | Whether the primary or fast model handled the stage |
| `requestedServiceTier` / `serviceTier` | Requested and returned provider service tier |
| `usage.cachedTokens` / `usage.cacheWriteTokens` | Provider-reported cache reads and writes when available |
| compatibility fallback flags | Features removed after a compatible endpoint explicitly rejected them |

Compare runs by task shape, endpoint, model, service tier, warm/cold cache state, and browser state. Do not mix an initial capability-negotiation run with a warm compatibility-cache run.

## Diagnosing a slow run

Start with the first missing or late milestone:

- A late `firstDecisionReadyMs` with high first-byte time points to endpoint queueing, model selection, service tier, or network delay.
- A low first-byte time but late decision with high output or reasoning-token use points to generation or reasoning.
- A quick decision but late approval points to policy or safety work; a long gap from approval to effect start is user review time.
- A quick effect start but late completion points to page navigation, browser input, tool execution, or settle handling.
- A high `requestCount` with repair/verifier stages indicates ambiguous evidence or contract-invalid model output.
- Repeated fallback flags indicate a compatibility regression or a background-worker restart before its in-memory capability cache could be reused.
- A route-memory hit followed by fallback means the live DOM no longer uniquely satisfies the remembered semantic target; this is expected fail-closed behavior.

The fast model is optional. Leaving it blank keeps model selection unchanged while still applying adaptive budgets, streaming, prompt caching, local terminal checks, deterministic route memory, and first-action measurement. Real endpoint timing and task-success quality must still be measured together before claiming a seconds-level improvement.

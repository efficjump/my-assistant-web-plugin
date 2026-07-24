# Web structure compatibility

The extension combines DOM evidence with screenshot evidence instead of assuming that every node in a page is visible or controllable. It does not contain site-specific selectors. Each turn discovers the current structure, exposes only visually grounded targets, acts through observation-scoped refs, and observes again.

![Context view showing verified frames, nested scroll regions, visual surfaces, and explicit automation gaps](assets/web-compatibility.png)

## Compatibility levels

| Page structure | Observation | Control | Guardrail |
| --- | --- | --- | --- |
| Standard HTML and semantic ARIA controls | Visible text and exposed controls | Ref-based DOM actions | Current document, target fingerprint, clipping, occlusion, disabled state |
| Open Shadow DOM | Visible descendants are traversed | Ref-based DOM actions | Shadow scope remains part of the target fingerprint |
| Same-origin `iframe` or legacy `frame` | Visible child frame is observed separately | Action is routed to the child frame | Child document ID and composed top-viewport geometry |
| Cross-origin `iframe` or legacy `frame` | Available after its visible origin is granted | Action is routed to the granted child frame | One fully exposed boundary must map to exactly one browser frame |
| Nested scroll container | Visible region and current scroll range | Targeted `scroll` action | Newly revealed content is not described until the next observation |
| `html` or `body` document scroller | Descendants are clipped to the visual viewport | Normal viewport scroll and ref-based actions | The shifted root box is not applied as a second clipping rectangle |
| Legacy `javascript:` or AJAX link | Visible link and declared page-owned handler | Exact selector and `href` are rebound in the page's main execution world | Approval, fresh target validation, and an observable post-action fingerprint change |
| HTML image map | Visible mapped area is projected onto its displayed image | Ref-based pointer activation or a guarded page-owned handler | Scaled shape geometry, exposed point, image occlusion, and fresh target validation |
| SVG link | Visible SVG anchor with `href` or `xlink:href` | Ref-based pointer activation | Current geometry, exposure, and link binding |
| Semantic menu or tree item containing one link or button | Exposed composite container plus the single rendered child action | The parent ref activates the bound child action rather than an unrelated icon hit point | Matching visible label, current child action type and URL, parent exposure, and fresh target validation |
| Canvas or `role="application"` surface | Surface bounds plus current screenshot | Internal `visual_click`, or Bridge `browser_visual_act` with no caller coordinates | Screenshot binding, extension-owned normalized point, approval, fresh observation, independent LLM verification |

Hidden, clipped, or covered frames are not merged merely because their scripts can be injected. The parent checks the complete `iframe` or `frame` box for viewport clipping and occlusion before accepting a child observation. Named sibling frames can be matched through their live document binding even when they share a navigation URL. If anonymous or otherwise indistinguishable frames use the same URL and the runtime cannot prove which visible boundary owns which document, their contents are withheld and reported as `frame_visibility_unverified`. This is deliberately conservative: missing evidence is preferable to presenting hidden DOM as visible page content.

## Contextual element retrieval and observation windows

The element setting is a response-window size, not a limit on what the page can expose. Each frame gathers all currently visible interactive candidates before ordering them. The background merges those candidates by their top-viewport geometry, returns one bounded window, and includes `elementDiscovery` metadata with an opaque continuation cursor.

When the first window does not contain the required ref, the built-in planner can return `status: "discover"` with `elementSearch`. The Bridge exposes the same retrieval operation through `browser_elements`:

```json
{
  "query": "next page",
  "roles": ["button"],
  "near_text": "issue grid"
}
```

The content script builds a bounded local search record for each exposed control. Identity fields include accessible name, semantic role, tag, input type, placeholder, title, ARIA description, name, and common test identifiers. Context fields come from generic semantic ancestors such as the nearest cell, row, table/grid/list collection, form, dialog, group, region, and nearby heading. When an older page has none of those semantics, complete nearby ancestor groups of at most 520 normalized characters are considered; larger groups are discarded rather than partially sampled. With `near_text`, the main query must match control identity while the nearby text is scored against context, so a query such as page `2` does not match every link merely because the surrounding table contains dates. When a query or role filter can reject a node from identity alone, that inexpensive check runs before geometry, exposure, and nearby-context scoring. If a fully constrained search returns zero controls, the runtime removes semantic constraints in bounded combinations while retaining at least one target constraint, then falls back to a fresh unfiltered window. Only matching full control descriptors and their current refs are returned. `searchMatch` explains the matched fields and includes the best redacted context snippet. No site name, framework, symbol, or selector is embedded in the retrieval logic.

Refs are opaque document-scoped capabilities rather than positions in a result array. One connected DOM node keeps its monotonic namespaced ref when it appears in another observation window; a replacement node receives a different ref even when its selector and label are identical. The execution map is rebuilt for each observation, so a stable ref is actionable only when that ref was returned in the current context. If planning still cites an expired ref after the normal repair pass, the runtime discards that plan, re-observes, and performs a bounded fresh replan instead of asking the user to retry the whole task.

An optimized targeted result reports `availableTotal: null` and `availableTotalExact: false`, because computing the full unfiltered exposed-control count would undo that optimization. `potentialTotal` is the number of cheap identity candidates considered, while `total` counts candidates that passed complete exposure and search scoring. An unfiltered observation still reports an exact `availableTotal`.

The built-in planner may try a bounded number of distinct searches in the same agent turn. A repeated or empty search falls back to a remaining cursor rather than looping. If a targeted search returns no result, the runtime can resume the original unfiltered cursor. Scrolling remains necessary for virtualized or offscreen content because retrieval deliberately stays inside the current visual viewport.

Search result ordering is preserved across frames. The cursor retains per-frame offsets and is bound to the normalized query, roles, nearby text, document IDs, DOM revisions, frame visibility, viewport, and ranked-candidate digest. If any binding changes, discovery restarts instead of applying old offsets to a different result set.

Refs from a search window remain observation-scoped. The built-in approval path and external Bridge privately retain the exact search request and cursor used to produce the plan. Immediately before an approved action, they reconstruct that same window and compare the complete target fingerprint. This prevents a compact search result such as `e1` from being mistaken for the unrelated `e1` in the default window.

## Collection and agent-loop performance

The observer keeps a collection-scoped cache for DOM queries, computed styles, rectangles, exposure points, text exposure, and image-map geometry. Cached objects are released after the observation, so repeated checks inside one pass avoid recalculation without keeping a page-wide DOM snapshot alive.

Permission preflight collects only visible frame boundaries and origins. Planning is DOM-first: if an ordinary page already exposes visible text, controls, forms, or tables, enabling screenshot support does not attach pixels to every model request. Screenshots are selected when visual surfaces exist, the DOM provides no usable evidence, or the runtime explicitly requires fresh visual evidence. A screenshot cycle performs one full observation, captures the pixels, and validates a compact probe containing document and viewport revisions, included target bindings, and frame boundaries. It recollects the full page only when that probe detects a change. Collection diagnostics, including wall time, phase timings, scanned-node count, query count, and cache hits, are available to the extension context view for distinguishing DOM collection cost from model or network latency.

Every fresh request resolves its immutable intent and first executable decision in one structured model response, removing the serial intent-only request from the normal path. The initial DOM observation and MCP capability discovery still run together, and the prefetched page state is reused only if a compact probe confirms that it is current. The combined response contains the dynamic turn intent, collection/output contract, completion criteria, and first plan; malformed intent receives one bounded structured repair before the runtime uses a safe standalone fallback and a separate replan. The planner excludes duplicate page-text aliases and full evidence payloads, and terminal completion-evidence and current-page-grounding checks still share an independent verifier request. Before execution, actions proven read-only or limited to a disclosure control or same-origin link use the canonical deterministic state-change contract; actions that can be consequential still use the independent policy model. Inside an action, the first paint and observable state fingerprint are checked immediately; a bounded grace period is used only when no change appears. After execution, the top document reports readiness plus DOM, visual, URL, and scroll revisions until they have remained quiet for a dynamically bounded interval instead of relying on unconditional sleeps. If document replacement closes the content response channel, success is recovered only after the browser confirms that the same frame has a new document ID or sanitized URL. A stale prefetch, prior conversation, changed screenshot, malformed decision, consequential effect, or uncertain completion still activates the corresponding conservative path.

## Side-panel layout validation

Long dynamic task names previously let an implicit nested grid track grow beyond the compact task-flow card. The outer panel hid the overflow, so the title wrapped while the summary and progress state extended under the disclosure control. The summary now defines a shrinkable `minmax(0, 1fr)` track at each nested grid level, keeps the task-flow label on one line, and truncates only the dynamic summary.

| Before | After |
| --- | --- |
| ![Task-flow title wrapping while content escapes the compact card](assets/task-flow-layout-before.png) | ![Long task name, current status, and progress contained inside the compact card](assets/task-flow-layout-after.png) |

The real-browser layout contract uses the same long task text at 240, 300, 360, and 420 pixels. It verifies the dock and summary `scrollWidth`, the single-line title, row containment, composer alignment, template popover, settings sheet, and horizontally scrollable settings tabs.

## Structured record collections

An exact record count is treated as output cardinality, separate from permission to repeat a state-changing effect. For a structured collection, the agent binds `extract` to one representative record ref and supplies one stable collection identity across result pages. The content layer expands the repeated rendered structure around that exemplar, preserves the redacted record context and provenance, groups links that describe the same record, and emits stable keys for runtime deduplication.

The runtime merges each page batch into one collection ledger before allowing further traversal. It stops as soon as the unique-record count reaches the requested target and returns only that target-sized result. A repeated page identity or a page that adds no new unique records marks the ledger as stalled; further pagination is blocked and the agent must report the exact shortfall instead of looping or treating navigation as collection progress.

Requested local formats are resolved into the immutable turn intent. After the ledger reaches its exact target, the only permitted continuation is the local `runtime.export_collection` capability for each still-missing CSV or XLSX artifact. The runtime generates the file from its own deduplicated ledger, records collection ID, format, row count, byte length, filename, and download start as evidence, and treats duplicate export calls idempotently. Terminal success remains invalid until every requested artifact is present; no remote conversion or upload is involved.

## How model-assisted visual targeting works

Normal DOM refs remain the first choice. A visual action is eligible only when all of the following are true:

1. The current observation contains an exposed canvas or application surface.
2. A screenshot was captured and bound to that exact viewport observation.
3. The internal planner, or the Bridge's extension-owned locator, describes one unambiguous visible target and returns a point normalized from `0` to `1000` inside the surface, not the whole screen.
4. The user reviews the action; visual actions never bypass approval in automatic mode.
5. Immediately before execution, the runtime captures another coherent observation and screenshot.
6. An independent verifier request using the configured LLM confirms that the description still matches the proposed point. Screenshot text is treated as untrusted evidence, not instructions.
7. The content script checks the surface type, exposed rectangle, point bounds, current hit target, occlusion, and disabled state before dispatching pointer and mouse events.

Any missing screenshot, changed geometry, replaced frame document, occluded point, uncertain verifier response, or model/API failure stops the action. The runtime replans from fresh evidence instead of replaying the coordinate.

The authenticated external MCP bridge still does not accept raw `visual_click` actions. Instead, `browser_visual_act` lets the caller provide only a current surface ref and a precise target description. The extension captures and binds the screenshot, obtains and verifies the normalized point with the configured model, applies policy and approval, then resolves and verifies the target again against a fresh screenshot immediately before execution. Coordinates, screenshot tokens, policy results, and approval claims never cross the public input boundary.

## Disposable public-page validation

Use the live Bridge harness for a public-page regression that is not covered by the synthetic fixture:

```bash
npm run test:live-bridge -- "<public-page-url>"
```

The harness grants only the supplied origin to a temporary extension copy, launches an isolated browser profile, and creates short-lived local Bridge credentials. Drive the normal guided workflow, review pending effects with `status`, and use `approve` or `reject` before execution. `quit` closes the browser and companion and removes the temporary profile and token. Do not use this harness with a signed-in or private page.

## Permission behavior

The production manifest does not request blanket host access. When a user starts a task or shares a tab, the extension first checks which configured endpoint and page origins are already granted. It then requests only missing origins.

For embedded pages, the runtime uses a lightweight pass over visible `iframe` and legacy `frame` boundaries and asks only for currently visible HTTP or HTTPS origins. It repeats discovery after a grant so a newly observable child frame can reveal a nested frame. Declining an embedded-origin request leaves the top page usable and records `frame_access_required` for the unavailable part.

`webNavigation` is used only to discover stable browser frame IDs and parent relationships. It does not grant host access or expose frame contents by itself.

## Structured capability gaps

The page context includes `automationCapabilities.gaps`. Common codes are:

| Code | Meaning | Safe next step |
| --- | --- | --- |
| `frame_access_required` | A visible embedded origin is not granted | Grant only the listed origin, reload when required, and observe again |
| `frame_injection_unavailable` | The origin is granted, but browser or document policy still prevents content-script access | Treat that embedded document as unavailable and use direct interaction if necessary |
| `frame_visibility_unverified` | A child document cannot be mapped unambiguously to a visible `iframe` or `frame` boundary | Do not describe or control its contents; use direct user interaction or simplify the page state |
| `unsupported_frame_scheme` | The embedded document uses a scheme that extension injection cannot access | Treat it as unavailable metadata |
| `visual_surface` | Visible content is painted without individual DOM controls | Use screenshot-bound visual targeting when unambiguous, otherwise ask the user |
| `target_not_exposed` | The target is clipped, covered, transparent, or outside the current viewport | Scroll or change the page state, then observe again |
| `element_not_found` | A snapshot-scoped ref or selector no longer resolves | Discard the plan and use refs from a new observation |

These codes are returned with action diagnostics and included in the context view so the planner can choose a different path rather than guessing.

## Boundaries that remain

Some surfaces cannot or should not be automated by a page extension:

- browser settings, extension-management pages, developer tools, and other internal URLs
- closed Shadow DOM internals when the host exposes no usable semantic control
- operating-system dialogs and native application UI
- browser permission, payment, authentication, or popup flows that require a trusted physical user gesture
- CAPTCHAs, abuse-prevention challenges, and controls that reject synthetic events
- DRM-protected or otherwise policy-restricted embedded content
- visual targets that are too small, moving, covered, or ambiguous for the verifier to identify confidently

In these cases the correct result is a precise blocker and a direct-user step, not an invented success claim.

## Verification coverage

The real-browser E2E fixture checks that:

- a visible cross-origin frame receives a frame-scoped ref and can be filled and clicked;
- a hidden cross-origin frame is absent from visible text and actions;
- child-frame rectangles are transformed into top-viewport coordinates;
- named legacy `<frame>` siblings that share one URL remain distinguishable and route an action to the correct document;
- an exposed HTML image-map area is projected onto its displayed image and its page-owned action is verified;
- an SVG `xlink:href` control is recognized as a link;
- a nested scroll region reveals a previously clipped control only after scrolling and re-observation;
- a `body` root scroller does not double-clip descendants after viewport scrolling;
- a numeric legacy paginator is retrieved from bounded nearby context and its page-owned `javascript:` handler must produce an observable state change;
- a 121st dense-grid control is found through both opaque cursor paging and structured query/role/nearby-context retrieval without a user handoff;
- search results expose their matched context, multi-window search cursors preserve the complete filter, and a mismatched role invalidates the cursor;
- changing the DOM invalidates an old element cursor and safely restarts discovery;
- an 8,000-node observation exposes its target, records cache hits and phase diagnostics, and keeps lightweight frame-origin discovery separate from full collection;
- an unchanged post-capture page passes the compact observation probe without a duplicate full collection;
- an already-stable page completes event-driven settling before its timeout, while normal DOM planning skips optional screenshots and visual surfaces retain them;
- disclosure and read-only actions use the deterministic policy fast path, while an unresolved click remains on the independent policy path;
- a document replacement that closes the content response is recovered from browser-observed navigation, and a composite menu item activates its one nested link instead of its icon;
- immediate disclosure changes return without the former per-action fixed waits, while a delayed mutation still has a bounded grace window;
- the built-in model loop issues `discover` and obtains the target without blindly advancing the unfiltered cursor;
- the initial planner response resolves immutable intent and the first executable decision in one structured request, while prefetched DOM and MCP evidence is reused only after a fresh probe;
- structured collection extraction expands rendered records from a bound exemplar, deduplicates stable rows across pages, and stops at the exact target or a repeated/no-new-record page;
- a complete latest message becomes a standalone immutable intent even after a failed related run, while an explicit continuation carries only the named unfinished deliverable;
- malformed decision output and stray `elementSearch` metadata are repaired without exposing internal JSON or schema errors, and one successful semantic effect cannot be repeated beyond the resolved turn boundary;
- approval-time validation reconstructs the search observation instead of rebinding its ref in the default window;
- a canvas surface accepts a normalized visual point and produces an observable state change;
- the independent visual verifier receives the current screenshot, can approve a grounded target, and fails closed on rejection;
- the authenticated Bridge performs locator and verifier calls both before approval and again before executing a visual action;
- the Bridge allows an explicitly bounded repeated effect only up to its resolved count and makes failed guided operations terminal until `browser_end`;
- document replacement, worker restart, approvals, and the authenticated MCP bridge continue to pass their existing regression scenarios.

Run the checks from the repository root:

```bash
npm run check
npm test
npm run test:bridge
npm run test:e2e
```

The corresponding pnpm commands remain supported.

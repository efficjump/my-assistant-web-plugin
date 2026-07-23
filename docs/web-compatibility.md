# Web structure compatibility

The extension combines DOM evidence with screenshot evidence instead of assuming that every node in a page is visible or controllable. It does not contain site-specific selectors. Each turn discovers the current structure, exposes only visually grounded targets, acts through observation-scoped refs, and observes again.

![Context view showing verified frames, nested scroll regions, visual surfaces, and explicit automation gaps](assets/web-compatibility.png)

## Compatibility levels

| Page structure | Observation | Control | Guardrail |
| --- | --- | --- | --- |
| Standard HTML and semantic ARIA controls | Visible text and exposed controls | Ref-based DOM actions | Current document, target fingerprint, clipping, occlusion, disabled state |
| Open Shadow DOM | Visible descendants are traversed | Ref-based DOM actions | Shadow scope remains part of the target fingerprint |
| Same-origin iframe | Visible child frame is observed separately | Action is routed to the child frame | Child document ID and composed top-viewport geometry |
| Cross-origin iframe | Available after its visible origin is granted | Action is routed to the granted child frame | One fully exposed iframe boundary must map to exactly one browser frame |
| Nested scroll container | Visible region and current scroll range | Targeted `scroll` action | Newly revealed content is not described until the next observation |
| Canvas or `role="application"` surface | Surface bounds plus current screenshot | Internal `visual_click`, or Bridge `browser_visual_act` with no caller coordinates | Screenshot binding, extension-owned normalized point, approval, fresh observation, independent LLM verification |

Hidden, clipped, or covered frames are not merged merely because their scripts can be injected. The parent frame checks the complete iframe box for viewport clipping and occlusion before accepting a child observation. If multiple frames use the same navigation URL and the runtime cannot prove which fully exposed iframe owns which document, their contents are withheld and reported as `frame_visibility_unverified`. This is deliberately conservative: missing evidence is preferable to presenting hidden DOM as visible page content.

## Dense visible controls and observation windows

The element setting is a response-window size, not a limit on what the page can expose. Each frame gathers all currently visible interactive candidates before ordering them. The background merges those candidates by their top-viewport geometry, returns one bounded window, and includes `elementDiscovery` metadata with an opaque continuation cursor.

The cursor retains per-frame offsets and is bound to the document IDs, DOM revisions, frame visibility, viewport, and an ordered-candidate digest. If the page changes between windows, discovery restarts instead of applying old offsets to a new layout. A goal-derived query can rank and filter controls from accessible names, roles, element types, titles, ARIA descriptions, names, and test identifiers; no site or framework-specific selector is embedded in the runtime.

The built-in agent automatically requests the next window when its planner reports a missing-target blocker while `hasMore` is true. External MCP clients receive the same state through `browser_elements`. Only after relevant visible windows are exhausted should the runtime consider scrolling or a precise capability blocker. This prevents a lower grid pager or action button from being mistaken for an inaccessible control merely because it appeared after the first configured window.

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

## Permission behavior

The production manifest does not request blanket host access. When a user starts a task or shares a tab, the extension first checks which configured endpoint and page origins are already granted. It then requests only missing origins.

For embedded pages, the runtime inspects visible iframe boundaries and asks only for currently visible, uniquely mapped HTTP or HTTPS origins. It repeats discovery after a grant so a newly observable child frame can reveal a nested frame. Declining an embedded-origin request leaves the top page usable and records `frame_access_required` for the unavailable part.

`webNavigation` is used only to discover stable browser frame IDs and parent relationships. It does not grant host access or expose frame contents by itself.

## Structured capability gaps

The page context includes `automationCapabilities.gaps`. Common codes are:

| Code | Meaning | Safe next step |
| --- | --- | --- |
| `frame_access_required` | A visible embedded origin is not granted | Grant only the listed origin, reload when required, and observe again |
| `frame_injection_unavailable` | The origin is granted, but browser or document policy still prevents content-script access | Treat that embedded document as unavailable and use direct interaction if necessary |
| `frame_visibility_unverified` | A child document cannot be mapped unambiguously to a visible iframe boundary | Do not describe or control its contents; use direct user interaction or simplify the page state |
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
- a nested scroll region reveals a previously clipped control only after scrolling and re-observation;
- a 121st dense-grid control is found through both opaque cursor paging and dynamic query without a user handoff;
- changing the DOM invalidates an old element cursor and safely restarts discovery;
- the built-in model loop continues from a missing-target decision into the next visible-element window;
- a canvas surface accepts a normalized visual point and produces an observable state change;
- the independent visual verifier receives the current screenshot, can approve a grounded target, and fails closed on rejection;
- the authenticated Bridge performs locator and verifier calls both before approval and again before executing a visual action;
- document replacement, worker restart, approvals, and the authenticated MCP bridge continue to pass their existing regression scenarios.

Run the checks from the repository root:

```bash
npm run check
npm test
npm run test:bridge
npm run test:e2e
```

The corresponding pnpm commands remain supported.

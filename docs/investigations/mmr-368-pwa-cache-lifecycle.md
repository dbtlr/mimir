# MMR-368: PWA cache refresh and invalidation

## Scope

This investigation traces how the embedded console shell is populated, versioned,
discovered, activated, and recovered across deployments. It separates four mechanisms
that are intentionally independent:

- Workbox owns app-shell precaching and cache cleanup.
- The HTTP server owns revalidation and immutable-asset caching.
- The console registration module owns the transition between loaded application
  versions.
- TanStack Query persistence owns offline data and its schema compatibility.

## Current behavior

### Build and population

`vite-plugin-pwa` runs in `generateSW` mode. The production build precaches the HTML
shell, content-hashed JavaScript, CSS and fonts, the web manifest, and icons. `/api/*`
is excluded from the navigation fallback, so API data is never served by the app-shell
worker.

A production build on 2026-08-06 generated 17 precache entries totaling 1,232.06 KiB.
The icon and manifest entries appear twice because `includeAssets` overlaps
`globPatterns`; Workbox accepts the output, so this is redundant rather than a cache
correctness failure.

### HTTP caching

The embedded server marks `/assets/*` as `public, max-age=31536000, immutable`.
`index.html`, `sw.js`, the Workbox runtime, the manifest, and icons are served with
`no-cache`. Content-hashed asset URLs therefore remain safe for long-lived caching,
while every shell or worker request revalidates.

### Update discovery and activation

The console registers `/sw.js` immediately. `registerType: 'autoUpdate'` generates a
worker with `skipWaiting()` and `clientsClaim()`. The generated registration module
listens for the new worker taking control and calls `window.location.reload()`.

The resulting deployment sequence is:

1. The browser checks `/sw.js` on registration/navigation and through its normal
   service-worker update cycle.
2. A byte-different worker installs the complete new precache atomically.
3. `skipWaiting()` activates it without waiting for old tabs to close.
4. `clientsClaim()` transfers open clients to the new worker.
5. The generated registration code reloads each controlled open tab.
6. The reloaded HTML refers to the new content-hashed assets.
7. Workbox deletes obsolete precaches during activation.

There is no waiting-worker state for the operator to approve. Update discovery is not
deployment-push-driven: a tab that remains open depends on the browser's update checks
until another registration or navigation occurs.

### Version signaling

The bundle and daemon embed the same release version. The version footer polls
`/api/health` and renders `update available` when the loaded bundle and daemon differ.
This is a useful fallback signal when a long-lived tab has not discovered its new
worker, but it does not control service-worker activation and offers no refresh action.

The persisted query cache has a separate `mimir-ui-v3` buster. It protects persisted
data-shape compatibility; it is not an application release identifier and must not be
coupled to service-worker cache versions.

## Failure modes

1. **An update can discard active input.** Automatic activation reloads every open
   console tab without consulting the application. The console now contains task,
   project, annotation, seed, transition, and reason forms, so an operator can lose
   unsaved input.
2. **Discovery latency is invisible.** A long-lived tab has no explicit periodic update
   check or deployment signal. The health-version mismatch eventually says an update
   exists, but only as quiet footer text.
3. **There is no actionable update state.** The UI cannot explain that a new shell is
   ready, let the operator finish input, or initiate a controlled refresh.
4. **Multiple tabs reload independently.** `clientsClaim()` reaches all controlled
   clients; each generated registration listener reloads its own tab. This converges
   versions, but can interrupt several simultaneous workflows.
5. **Offline recovery is last-known-good only.** A previously populated shell opens
   offline and persisted queries provide data. Deployment discovery and new-shell
   installation necessarily wait for connectivity. Once connectivity returns, API
   queries refetch and the service worker can update; no offline write queue exists.
6. **Precache inputs overlap.** The manifest and icons are emitted twice in the
   generated manifest. This wastes manifest space but does not explain stale clients.

## Recommended contract

Use an operator-controlled update transition:

- Change the PWA registration behavior from automatic reload to prompt mode.
- Surface a persistent, actionable `Update available` notice when a worker is waiting.
- Make `Refresh now` send the skip-waiting message and reload only after the new worker
  controls the page.
- Do not automatically reload a page with potentially unsaved input. Deferral keeps the
  current worker and shell coherent until the operator chooses to transition.
- Check the registration periodically while the document is visible, and immediately
  on focus/reconnect, so long-lived console tabs discover deployments promptly without
  a server-side push channel.
- Keep Workbox content hashes, HTTP cache headers, health-version signaling, and the
  persisted-query buster as separate ownership layers.
- Preserve the version footer as a fallback. When it detects a mismatch, its update
  notice should invoke the same controlled registration/update path rather than only
  advising a manual reload.
- Cover first install, waiting-worker prompt, controlled activation, multiple tabs,
  offline launch, reconnect, and unsaved-form deferral in browser-level regression
  tests.

This refines the PWA behavior within ADR 0013's app-shell and offline-read boundaries;
it does not change the one-binary deployment model or add offline writes.

## Evidence and limitations

- `packages/ui/vite.config.ts` defines the precache boundary and `autoUpdate` policy.
- `packages/ui/src/main.tsx` registers the worker immediately.
- The generated `dist/sw.js` contains `skipWaiting()`, `clientsClaim()`, precache
  routing, navigation fallback, and obsolete-cache cleanup.
- The generated application chunk contains the controlling-event reload handler.
- `packages/bin/src/http/static.ts` defines immutable and revalidation headers.
- `packages/ui/src/components/version-footer.tsx` defines daemon/bundle mismatch
  signaling.
- `packages/ui/src/lib/persist.ts` and `main.tsx` define offline-query persistence.

The available collaborative browser could not navigate to the reachable local preview,
and no fallback browser was attached. The lifecycle above is therefore verified from
the production-generated worker and registration code, HTTP responses, repository tests,
and the service-worker contracts, but not from a recorded interactive browser run in
this session. The implementation task must include browser-level lifecycle proof before
shipping the behavior change.

---
title: 'ADR 0013: The UI is an embedded SPA — board-first console, PWA, offline reads only'
status: accepted
date: 2026-06-11
---

# ADR 0013: The UI is an embedded SPA — board-first console, PWA, offline reads only

What the Phase-5 web UI is, what it's built from, and how it ships. The
console's job statement comes from ADR 0012: a cross-project operator console —
see everything in flight across all projects, and intervene. Chunk-level scope
and view design live on `MMR-16`'s annotations; this records the
hard-to-reverse shape.

## The decision

1. **A static SPA, embedded in the binary.** The UI is a `packages/ui` Vite
   build whose output is embedded in the compiled binary (Bun file-type
   imports over a generated asset manifest) and served by `mimir serve` at
   `/`, with the API under `/api/*`. One product, one artifact: the `curl|sh`
   install story is unchanged, and binary↔UI version skew is unrepresentable.
   There is no server runtime in the UI — `mimir serve` is the server; no
   meta-framework.

2. **The stack:** Vite, React, TanStack Router, TanStack Query, Tailwind v4,
   shadcn/ui (Base UI flavor), `vite-plugin-pwa`, vitest. Chosen heavier than
   the minimal option on purpose:
   - TanStack Router's typed search-params carry the navigation contract
     (below) in the type system instead of by convention.
   - TanStack Query owns poll/cache/staleness — the entire data model of a
     read console — rather than hand-rolling a polling layer.
   - shadcn's vendored-source model (components copied into `packages/ui`,
     owned, not imported) is the dependency-shaped expression of the console
     job: a surface the operator crafts and extends.
   - React keeps the strongest accessible drag-and-drop path (dnd-kit) for
     the intervention chunk, and is the dialect agent-driven development
     produces most reliably in this codebase.

3. **Navigation: URLs name scopes; everything else is a lens parameter.**
   `/` is the Overview (all projects); `/p/KEY` is a project; node detail is a
   URL-addressable drawer parameter. Views (board/tree) are lens params, not
   routes. The console never invents a navigation concept the data model
   doesn't have.

4. **The board is the primary lens, and it absorbs the queue.** Columns are
   the status vocabulary (the status lens — priority-as-columns stays banned
   per ADR 0007): In progress · Ready · Awaiting · Blocked · Parked · Done
   (windowed). The Ready column in rank order _is_ the `next` queue — array
   order from the API carries rank, which itself stays invisible. `abandoned`
   is a filter, never a column. Column transitions are reserved to map 1:1
   onto mutation verbs when intervention arrives (drag Ready→In progress =
   `start`).

5. **PWA with offline _reads_ only, loudly marked.** App-shell service worker
   (the installed app always opens) plus the query cache persisted to
   IndexedDB. Unreachable-for-any-reason is one state: show the last-known
   board, visually demoted, behind a persistent offline banner with the
   last-sync time; refetch automatically on reconnect. **No offline write
   queue, ever** — when write affordances exist, offline disables them. A
   sync/conflict engine is a product this project is not building at
   single-operator scale.

## Why

- **Embedding completes ADR 0010.** "One binary" decided how the surfaces
  ship; the UI was the open edge. The rejected shape was not a sidecar assets
  directory but a _second distributable_ — wrong because the console is part
  of the product, not a product.
- **Read-only-first keeps the open auth question parked.** A console without
  verbs behind the colocated proxy is the small exposure; the auth question
  (ADR 0012, deliberately open) must be revisited before the intervention
  chunk ships writes over the LAN.
- **Stale-presented-as-stale is useful; stale-presented-as-fresh is poison.**
  The offline posture follows from that one rule: last-known-good is a real
  console job (the glance away from the desk), safe by construction while
  reads are the only capability.

## Considered and rejected

- **A second distributable for the UI** — see above; one product, one artifact.
- **Sidecar assets directory** — reintroduces "where do the files live" for
  zero benefit at single-operator scale; a `--ui-dir` dev escape can exist
  later if prod-mode-on-disk iteration ever hurts.
- **Meta-framework (Next/Remix/SvelteKit)** — no SSR, no UI server runtime;
  `mimir serve` hosts static output.
- **Lighter frameworks (Solid/Svelte/Preact)** — their headline advantage
  (bundle size) is irrelevant served same-machine; the ecosystem advantage
  (drag toolkit, agent fluency) bites exactly where this UI is going.
- **Offline write queue** — a sync/conflict engine; out of scope permanently
  at this scale.
- **Websockets for liveness** — already deferred with its re-entry condition
  in ADR 0012 ("UI outgrows polling"); polling via the query layer, with
  `/api/transitions?since=` as the cheap change-detector if needed.

## Consequences

- `MMR-16` (chunk 1: read-only console) carries the groomed view/scope
  contract on its annotations; `MMR-51` (intervention) and `MMR-52`
  (archaeology) are the follow-on chunks, dependency-gated on chunk 1.
- `release.yml` gains a UI build step before each per-platform compile; the
  local `build` script becomes build-ui-then-compile.
- The localhost CORS reflection in `src/http/respond.ts` is the dev loop
  (`vite dev` against a running `mimir serve`), as anticipated at Phase 4.
- PWA requires HTTPS; that lands on the proxy, where ADR 0012 puts boundary
  concerns. Mobile-on-LAN as an access path sharpens the auth revisit noted
  on the intervention chunk.

## Refinement (v0.9, MMR-76 / MMR-78): the board foregrounds the actionable set; a `/tasks` browser is the complete view

Dogfooding the board surfaced that one-column-per-status (§4) does not scale: the
off-path states (Parked, Blocked, Awaiting) are noise on the working surface, and
Done grows without bound. The board's job is the **actionable present**, not the
complete record — the same operational/lookup split already drawn between the board
and the `/artifacts` browser. §4 is refined accordingly; §3's "URLs name scopes"
is preserved.

- **The board is a three-tier status lens, not one column per status.**
  - **Full columns — the actionable set:** Ready and In progress. (Ready in rank
    order remains the `next` queue, per §4.)
  - **Windowed column:** Done stays bounded to its recency window and shows an
    `n of m` count with a drill-through to the complete list (the window itself
    already existed: `DONE_WINDOW_MS`).
  - **Collapsed columns — the non-actionable set:** Parked, Blocked, Awaiting
    render as narrow strips showing the status and its count, expandable inline on
    demand. Column order is the MMR-68 pipeline order (Parked → Blocked → Awaiting →
    Ready → In progress → Done); this also supersedes §4's original left-to-right
    listing.
  - `abandoned` remains a filter, never a column; priority is never a column
    (ADR 0007). Drag-to-verb (intervention) is unaffected.

- **A `/tasks` portfolio browser is the complete, filterable, searchable view** —
  the sibling of `/artifacts`: a master-detail list across all projects, reusing the
  existing node selection surface (status universes, `eq`/`is`/`has`, project, limit).
  It is a portfolio **scope route**, consistent with §3 (not a project lens). The
  board's Done drill-through deep-links into it pre-filtered (`/tasks?project=KEY&status=done`),
  mirroring the artifact reader's `from=` provenance.

- **One server addition:** node listing gains a `q` case-insensitive substring
  search over title (LIKE; FTS5 deferred on the same trigger as `/artifacts`,
  per ADR 0012). The rich filters already exist server-side; only text search was
  missing. This is the lone backend change in the otherwise frontend-only v0.9 set.

## Refinement (v0.11, MMR-86): the mobile board is a legibility pass, not a scaled-down desktop

The board (§4) was the same dense, multi-column desktop styling rendered in one
column on a phone — which fails three ways: the per-status tab row can't show which
column you're viewing (and got worse as the status vocabulary grew, e.g. `under_review`),
there is no type hierarchy so the card title doesn't win, and controls are below a
usable touch size. Frontend-only; the contract and the desktop board are unchanged.

- **The mobile column switcher is a column-header dropdown, not a tab row.** The
  current column is a single legible header (status dot + label + count) that _is_ the
  answer to "which column," and taps open to a jump menu of every column with its dot
  and count (the current one checked). It scales to any number of columns where a tab
  row cannot. Swipe-between (MMR-70) is retained. Replaces the per-status `TabsList`.
- **Hierarchy is carried by weight and recession, not size.** A first attempt that
  scaled type/padding/targets up wholesale read as oversized and was rejected — the
  correct fix is the card **title wins by weight** (semibold) against dimmed metadata,
  at near-original sizes. Mobile is not "desktop bigger."
- **Touch + chrome:** the drag-grip (rank reorder) is **desktop-only** — reordering by
  dragging a tiny handle on a phone is the worst target _and_ an unwanted gesture; mobile
  is read + act-via-kebab. `+ New task` collapses to an icon-only `+`, and the secondary
  nav (Tasks/Artifacts) folds into a top-bar overflow menu.
- **Alignment is load-bearing and was verified by measuring, not eyeballing.** On mobile
  the column-box's internal card padding (a desktop affordance with no box on mobile)
  and a right-aligned toolbar broke the shared left margin; the board now aligns the
  header, title, status badge, toolbar, switcher, and cards to one left edge, with the
  lens toggle pinned right (`justify-between`).

## Refinement (v0.13, MMR-111): the Overview groups projects into Lanes, not "attention bands"

The v0.12 attention-router (MMR-100/101/102) grouped projects into four "attention
bands," but that name borrowed the top-bar alert's word — the project-level
classifier and the alert both read as "attention." The classifier is renamed
**Lane**; **Attention** now names the top-bar alert only. Frontend + facet-field
rename, behavior-preserving except the alert relabel below; the four standings and
their ordering are unchanged.

- **A Lane is the operator-facing sibling of the container rollup word.** A project
  stores no status, so the Overview derives a coarse standing over its **leaf tasks**
  the way `interpret()` derives a word over a container's direct children — same
  spine, a four-value vocabulary instead of the eight status words. This is why the
  Lane vocabulary is small and fixed rather than mirroring the status set.
- **Four lanes in action-impact order** (how much the operator's action moves it,
  highest-wins): `awaiting_you` → `live` → `needs_unsticking` → `at_rest`. Recency
  orders projects within a lane; `at_rest` folds to a count strip (the Overview
  analog of the board's Done-windowing, §4 / v0.9 refinement).
- **Going cold is a modifier, not a fifth lane (5 → 4 + modifier).** A stale project
  is not a distinct standing — staleness is orthogonal to the lane, so it decorates
  whatever lane a project already holds (a stale `live` project is still `live`,
  marked _going cold_). Collapsing the would-be fifth band to a modifier keeps the
  lane axis one-dimensional.
- **The wire facet field renames** `attention.band` → `attention.lane`; the facet
  itself stays the `attention` facet on the projects read. No external consumers
  (embedded UI, versioned with the binary), so the rename is safe.
- **The attention alert relabels stale-only items as going cold.** The alert's stale
  arm pulls in stale `in_progress`/`ready` tasks; they were shown with their status
  word (a misleading healthy dot). They now surface as _going cold_ — kept in the set
  (a rotted started task needs you), but labeled by the nudge, not the status.

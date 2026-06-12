---
title: "ADR 0013: The UI is an embedded SPA — board-first console, PWA, offline reads only"
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
   `/` is the fleet (all projects); `/p/KEY` is a project; node detail is a
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

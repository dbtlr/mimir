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
  chunk ships writes over the LAN. Revisited in v0.22.1 (MMR-433): see
  ADR 0012's refinement.
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
  Superseded in v0.22 (MMR-426): see the refinement below.
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

_Superseded by the MMR-476 refinement in ADR 0019: the Lanes and the `attention` facet retire._

## Refinement (2026-07-07): the attention model is recorded in ADR 0019

The Overview/attention model this ADR accumulated as refinements (the v0.12
attention-router, the v0.13 Lane rename, going-cold-as-modifier, the attention
set and its ordering) is extracted into
[ADR 0019](0019-meridian-console-design-system.md) §9, which is now the
decision of record for it — together with the Meridian design system (color
roles, violet attention, verdict-first review). The refinement sections above
remain as historical narrative. This ADR remains the decision of record for
the SPA shape, navigation grammar, the board as primary lens, and the offline
posture.

## Refinement (v0.18, MMR-369): shell updates are installed globally but adopted per tab

The app-shell boundary in §5 remains, but activating a deployed shell no longer
forces every open console tab to reload. The service worker registers in prompt
mode: discovery and installation can happen in the background, while each tab
keeps its mounted DOM and unsaved form state until its operator chooses the
persistent refresh action. Focus, reconnect, visibility return, and a bounded
visible-tab interval drive throttled discovery for long-lived consoles.

Activation is origin-wide, but adoption is per tab. The requesting tab reloads
only after the new worker controls it; every other tab moves to an
"activated elsewhere" state and waits for its own explicit action. Workbox's
prompt-mode controlling event is local to the requester, so the registration
adapter broadcasts that activation over an origin-scoped `BroadcastChannel`
before deferring the requester's reload to the next task. That message changes
peer state only — it never reloads a peer. The health-version mismatch footer,
the persistent banner, and the standalone header action all route through this
one controller.

The worker remains an app-shell cache, never an API cache. Production builds
now fail unless the precache has unique URLs and complete HTML, JavaScript,
CSS, font, icon, and manifest coverage with `/api` still denied from navigation
fallback; a serial two-build Chromium test pins update, offline, and reconnect
behavior together. It remains available as `bun run test:pwa` for local and
manual release verification rather than running as a separate GitHub Actions
gate.

## Refinement (v0.22, MMR-426): the dev loop is same-origin through the Vite proxy

The dev loop no longer relies on CORS. `vite dev` forwards `/api` to a running
from-source `mimir serve` (the port in `MIMIR_PORT`, else the dev default), so
the console is same-origin in development as it is in production, and `serve`
grants CORS to no origin. The earlier reflection of any `localhost` or
`127.0.0.1` origin let every other web app on loopback read and write the
board. The Host guard (MMR-425) cannot catch that case, because those requests
name the daemon's own host.

Withdrawing CORS stops cross-origin reads, but a browser still sends a "simple"
POST (a `text/plain` body, no preflight) from any origin. So `serve` also
refuses any write that `Sec-Fetch-Site` marks as not same-origin, or whose
`Origin` does not name the request's `Host`. The
console's own writes pass: they are same-origin directly, behind a proxy that
keeps `Host`, and through the Vite proxy. Clients that send no `Origin`, such
as the CLI and agents, are unaffected. The Vite dev server's own CORS is off
for the same reason.

## Refinement (v0.23, MMR-444): a record is a page under its project

§3 made record detail a drawer parameter on a scope route. The console rebuild
(MMR-356) gives every task, container, seed, and artifact its own page that
works the same on desktop and phone, so §3 is revised: a URL names a scope, a
view, or a record, and only filters are parameters.

- **A record's path is its ID's suffix under its project.** `/p/KEY` is the
  project. A task or container is `/p/KEY/417`, a seed `/p/KEY/s41`, and an
  artifact `/p/KEY/a219`. The path is the ID split at its hyphen, so the
  translation between ID and URL is mechanical in both directions. Records sit
  under their project to make ownership explicit in the URL, at the same level
  as the project's views.
- **A distinct page gets a path; a narrowed page gets a parameter.** Project
  views move from the `?view=` lens parameter to path segments:
  `/p/KEY/board`, `/p/KEY/tasks`, `/p/KEY/seeds`, and `/p/KEY/artifacts`. The
  tree lens gets no path, because the work page retires it. Filters and
  groupings stay typed search parameters (`?status=`, `?q=`, `?bands=`). §3's
  lens-parameter rule survives in that narrower form.
- **Record suffix shapes are reserved.** A view segment is never all digits,
  and never `s` or `a` followed by digits. Those shapes always name a record.
- **The cross-project browsers stay top-level.** `/tasks`, `/artifacts`, and
  `/seeds` remain the browsers across all projects, and `/` remains the
  cross-project landing.
- **A bare ID redirects by grammar alone.** An unmatched path that is a
  well-formed ID (`/MMR-417`, `/mmr-s41`) or a bare project key (`/MMR`),
  in any case, redirects to its record or project URL without a lookup. The record
  page owns the not-found state when no record has that ID. An ID copied from
  the CLI, a commit, or a session summary is one edit away from a working link.
- **Drawer links are not carried forward.** `?node=`, `/artifacts?a=`, and
  `/seeds?seed=` were drawer state, not a stable link format. They get no
  redirect, and the parameters go away with the overlay.
- **No server change.** `serve` answers every GET outside `/api/` with the
  embedded SPA shell. The service worker precaches the shell and its static
  assets, and navigation falls back to the shell everywhere except `/api/`, so
  new paths need no cache changes.

Considered and rejected:

- **The ID as the whole path** (`/MMR-417`): the shortest form, but records
  would sit above the project's views instead of beside them, and the project
  would be implicit. It survives as the redirect form.
- **Nesting by collection** (`/p/KEY/seeds/41`): the URL stops spelling the
  ID, and seeds and artifacts sit a level deeper than tasks.
- **Kind prefixes** (`/t/MMR-417`, `/s/MMR-s41`): the ID already encodes its
  kind.
- **The full ID under the project** (`/p/KEY/MMR-417`): repeats the key and
  admits mismatches such as `/p/MMR/NRN-4`.

## Refinement (2026-10-11, MMR-454): `q` matches a node's id as well as its title

The `q` search added in v0.9 matched the title only. It now matches the title
or the rendered id, so typing `mmr-45` in the `/tasks` browser finds `MMR-45`
and `MMR-450`. The change lives in the shared node selection, so the CLI
(`list`/`next -q`) and MCP get it too. The artifact feed's `q` stays
title-only.

## Refinement (2026-10-12, MMR-467): a project or container opens as its work page

§4 made the board the primary lens. Agent work moves through statuses in
minutes, so the columns mostly show churn, and status belongs on the row.
The console rebuild (MMR-356) replaces the lens with a work page built from
the questions the operator asks. §4 is revised:

- **`/p/KEY` and a container's own URL open its work page.** A project, an
  initiative, or a phase opens at its page from the MMR-444 refinement
  (`/p/KEY`, `/p/KEY/367`) as the work page, scoped to its subtree. A task
  page is unchanged.
- **The main column is five sections in question order:** _Now_, _Needs
  you_, _Frontier_, _Shipped_, and _Going cold_. Every row links to its
  record page. A task appears once, in the first section that claims it;
  _Going cold_ is the one exception. A stale row carries the stale chip
  wherever it appears.
- **Now is the work moving.** It lists tasks whose status word (ADR 0008) is
  `in_progress`, with when each started, its latest note, and its agent
  context.
- **Needs you** is the work page's needs-you set (ADR 0019, work-page
  refinement).
- **The frontier is the work that could move soon.** It holds every `todo`
  task with no hold that is `ready`, or `awaiting` only prerequisites whose
  status word is `in_progress`, `under_review`, or `ready`. Such a task is at
  most one step away. A container prerequisite counts by its rollup word,
  and inherited dependency edges count, as they do for `ready`. Grooming
  state (ADR 0033) splits these tasks into three groups:
  - _Runnable now_ is groomed and `ready`, in `next` order.
  - _Next to unlock_ is groomed and `awaiting`, grouped by prerequisite. A
    task waiting on several prerequisites appears under each.
  - _To groom_ is not groomed, `ready` or `awaiting`, in rank order. An
    initiative or phase that reads _to break down_ (ADR 0033 §6) follows
    the tasks, under the same one-step rule on its own dependencies.

  The frontier ends with _Waiting on others_, a folded group outside that
  rule. It lists every task blocked with owner `others`, started or not and
  at any distance, with each block's reason, oldest first. Blocks owned by
  `you` are in _Needs you_, so every blocked task has one home on the page.

  An unheld task that needs answers is in _Needs you_, not the frontier; a
  blocked task that needs answers keeps its block's home. An unheld task two
  or more steps away, and a parked task, are not rows; the board and the
  task browser list them.
- **Shipped is the last seven calendar days**, today included, in the
  caller's time zone (ADR 0029). It lists tasks done or abandoned in that
  window, newest first, grouped by day. An abandoned row shows its reason.
  Releases and session summaries are not rows; the daily briefing (MMR-442)
  covers what happened.
- **Going cold is every stale task in scope** (ADR 0019 §9), the same
  predicate as `?is=stale`, oldest first. It repeats rows shown in earlier
  sections so that it answers its own question: what has nobody touched in
  a while.
- **The rail is Direction, Structure, About, then Other views.** The
  direction leads in full as rendered markdown and is editable in place. The
  structure outline lists the scope's initiatives and phases and links each
  to its own page. About holds the description, artifacts, and details.
  Other views links to the board and the task browser. On a phone each rail
  section is a chip under the title that opens a bottom sheet.
- **The board is an optional view; the tree retires.** `/p/KEY/board` keeps
  the status columns, reached from the rail. The tree lens and its `?view=`
  parameter are removed. The cross-project Overview at `/` stays until the
  review page (MMR-440) replaces it. Where this ADR's earlier sections and
  ADR 0019 name the board as the primary lens, the work page now holds that
  place.

Considered and rejected:

- **Every awaiting task under Next to unlock.** On a deep plan it becomes a
  long list that is mostly not near, and the frontier stops meaning "what
  could move soon."
- **One section per task, with no exception.** Every stale task is in
  progress, ready, under review, or blocked, so earlier sections claim it
  and _Going cold_ would always be empty. Moving stale tasks out of _Now_
  instead would hide a stuck task from the section that shows running work.
- **A fixed count of recent finishes for Shipped.** It keeps a quiet
  project's section from going empty, but then Shipped no longer means
  recent.
- **The description folded under the title.** It is more visible but
  competes with the work for the top of the page; a phase's description
  often holds long settled decisions.
- **A cockpit of panes, or a single timeline** (the shaping mocks' variants B
  and C). Panes split the reading order and stack poorly on a phone; a
  timeline mixes rank order with dependency order on one axis.

## Refinement (2026-10-12, MMR-470): a container's work page keeps its timeline under a tab

The MMR-467 refinement gave the work page five sections and a four-part rail,
and left out the timeline a container page showed until then. An initiative's
or phase's notes record the decisions made about it (grooming outcomes, mock
approvals, scope calls), and the timeline's composer was the console's only way
to add one. The work page keeps them:

- **An initiative's or phase's work page has two tabs under its head: _Work_
  and _Timeline_.** _Work_ is the default and holds the five sections. _Timeline_
  holds the same timeline a task page shows: the container's creation, notes,
  and transitions, oldest first, with the note composer. The tab label carries
  the timeline's entry count.
- **The tab is in the URL** as `?tab=timeline`; the work tab has no parameter,
  so `/p/KEY/367` still opens on the work.
- **A project has no tabs.** A project record carries no notes, so it has no
  timeline to keep.
- The rail is the same under either tab.
- **The structure outline is the whole project's.** On every work page it lists
  the project's initiatives and phases and highlights the current scope, so a
  phase's page shows where the phase sits. The MMR-467 refinement's "the
  scope's initiatives and phases" means this outline.

Considered and rejected (mocked as variants A–C beside the chosen D):

- **A sixth main-column section after _Going cold_.** On a busy scope the
  newest decision lands below a long _Shipped_ list.
- **Notes in the rail under Direction.** The rail already carries the direction
  in full and the structure outline; notes would clamp to a few lines there.
- **The latest note under the head, with the timeline in a drawer.** It adds a
  drawer, a surface the console does not otherwise have, and a line to every
  page head.

## Refinement (2026-10-13, MMR-476): `/` opens the review page, and the Overview retires

§3 made `/` the Overview, a card per project grouped into Lanes. The Overview
told the operator how each project stood but not where their action was
needed, so it was skipped in practice. The console rebuild (MMR-356) replaces
it with a review page that lists only what needs the operator across
projects. §3 is revised, and the MMR-467 refinement's interim note (the
Overview stays until the review page lands) is settled:

- **`/` opens the review page.** Its head reads _Needs you_ with the count of
  decisions (ADR 0019, review-page refinement) and a _Work through these_
  control that opens the focus queue. When there are no decisions, _Decide_
  says so and names the work in flight and the latest finish, and _Triage_
  still renders when it has rows.
- **The main column is two sections: _Decide_, then _Triage when you have a
  minute_.**
  - _Decide_ lists the decisions grouped by project, in ADR 0019's order.
    Rows act in place as they do on a work page: _Approve_ and _Send back…_
    on a verdict, _Answer…_ on a question. A block on you has no action, as
    on the work page; it is cleared outside Mimir and unblocked from its task
    page.
  - _Triage_ is a table with one row per active (not archived, ADR 0015)
    project that has anything to triage, ordered by its triage count. Its columns are untriaged seeds, the age of the oldest one, tasks
    going cold, and `doctor` findings. A row opens in place to list the
    project's untriaged seeds, oldest first, each with _Promote…_, _Park…_,
    and _Reject…_. The going-cold count links to the project's work page,
    and the findings count links to `/doctor?project=KEY`.
- **`/` gains in-place seed triage.** Until now seeds were triaged only from
  each seed's page. `/seeds` stays the browser for every seed in every seed lane (ADR 0020;
  unrelated to the retired project Lane),
  and the seed page keeps the full set of seed actions.
- **The rail is the project list.** Every active project, in ADR 0019's
  project order, with its decisions in the
  attention hue, its triage count in quiet ink, and its in-flight count. Each
  links to its work page. The archived shelf and _New project_ sit under the
  list. On a phone the list is a _Projects_ chip under the title that opens a
  bottom sheet, as the work page's rail does.
- **The focus queue is a mode of `/`, in the URL as `/?mode=focus`.** It is
  a mode of the review page, not a page of its own, as `?tab=timeline` is a
  mode of a container's page (MMR-470 refinement), so the MMR-444 rule that
  a distinct page gets a path does not apply. The queue fixes its list when
  it opens, in ADR 0019's queue order; decisions that arrive later wait for
  the next pass. It shows one decision at a time with its path, description,
  and question or verdict, and the same actions as its row; a block on you
  shows a link to its task page. Acting advances to the next decision;
  _Skip_ advances without acting and leaves the decision on the page. When
  the list is exhausted, the queue returns to `/`. Seeds and findings stay
  out of it.
- **The Overview retires.** The project cards, the Lane grouping, and the
  _At rest_ strip are removed.

Considered and rejected (mocked as variants A and B beside the chosen C):

- **An inbox grouped by project, with seeds and findings inline** (A). It
  follows the phase description literally, but 33 seeds across nine projects
  pushed later projects' decisions below the fold.
- **Sections by kind with the project on each row** (B). Decisions read well,
  but the page loses the per-project grouping the work page uses, and the
  seed section is still the longest thing on the page.

## Refinement (2026-10-13, MMR-487): the board view retires

The MMR-467 refinement kept the board as an optional view one link away from
the work page. The work page and the `/tasks` browser now cover the questions
the board answered, so the console drops it. §4, the v0.9 refinement's board
half (the three-tier status lens), and the v0.11 refinement (the mobile board)
are retired with it. The v0.9 refinement's `/tasks` browser and the node `q`
search it added stay. The MMR-467 refinement is revised:

- **`/p/KEY/board` is removed.** The route, its swimlane bands and `?bands=`
  parameter, drag-to-reorder, and the folded direction row (the work page's
  rail carries the direction) leave the console. An old board link reads as
  no record, because `board` is not a record suffix. `mimir reorder` and
  the reorder endpoint are unchanged; only the console stops offering them.
- **The rail is Direction, Structure, About, Artifacts, then Other views.**
  Other views links to the project's tasks in the browser. Artifacts moves out
  of About into its own section when the scope has any: a project lists its
  five newest and, when it has more than five, links to all of them at
  `/artifacts?project=KEY`, and a container lists the
  artifacts attached to it. The artifact browser has no per-record filter, so
  a container has no all-link. The direction is clamped to six lines with a
  _Read more_ that opens the reading pane.

## Refinement (2026-10-13, MMR-492): the project browsers move under the project, and the shell gains a project sidebar

The MMR-444 refinement kept `/tasks`, `/seeds`, and `/artifacts` as top-level
browsers across all projects. With the review page owning the one
cross-project surface (MMR-476 refinement), a browser that spans projects
repeats a project filter on every visit and leaves the operator without a
sense of where they are. The browsers move under the project instead, and the
shell carries the project as a persistent frame. The MMR-444 rule "the
cross-project browsers stay top-level" is reversed, and the MMR-467
refinement's rail and the MMR-476 refinement's top bar are revised:

- **The browsers are `/p/KEY/tasks`, `/p/KEY/seeds`, and `/p/KEY/artifacts`.**
  These are the view segments the MMR-444 refinement reserved, and the
  reserved-shape rule is unchanged. Filters stay typed search parameters. The
  project filter chip leaves the browsers, because the path now names the
  project.
- **`/tasks`, `/seeds`, and `/artifacts` stop being pages and redirect.** With
  `?project=K` the redirect goes to the scoped route and keeps the other
  parameters, so `/tasks?project=MMR&status=blocked` becomes
  `/p/MMR/tasks?status=blocked`. Bare, it goes to the current project's browser.
  Links written before this change, such as the work page's
  `/artifacts?project=KEY`, keep working.
- **The current project is the one in the URL.** On a page outside a project
  (`/`, `/doctor`), it is the last project visited, remembered per device. With
  no history, it is the first project in the switcher's order.
- **The shell gains a persistent project sidebar.** It has three parts:
  - A switcher header that names the current project and opens the switcher.
  - The project's sections (_Work_, _Tasks_, _Seeds_, _Artifacts_), with the
    active one marked.
  - The project's initiative and phase outline, which marks the open record's
    place. The outline replaces the record page's breadcrumb, and the work
    page rail's Structure section (MMR-467 refinement) moves into it.

  On a phone the sidebar is a drawer, and a single parent link stands above a
  record's id in place of the breadcrumb. (The sidebar is a drawer below
  1024, a narrow desktop included: ADR 0019's MMR-720 refinement.)
- **The top bar keeps the brand, the jump palette, _Needs you_, and the theme
  toggle.** The _Tasks_, _Artifacts_, and _Seeds_ links, and the phone overflow
  menu's section items, move into the sidebar.
- **The switcher lists pinned projects first, then the rest by most recent
  activity.** Activity is the newest of the project's node updates,
  transitions, annotations, seeds, and artifacts. Archived projects (ADR 0015)
  sit in a collapsed section. A pin is a flag on the project in the store, so
  pins follow the operator across devices; the remembered current project is
  device-local.
- **The review page at `/` remains the one cross-project surface.**
  Cross-project search stays in the jump palette.
- **The work page's _All tasks_ link moves from the rail's Other views to the
  foot of its task list.** The MMR-487 refinement's Other views section is
  retired with the link; the rail is Direction, About, and Artifacts, with
  Structure now in the sidebar outline.

Considered and rejected:

- **Keeping the cross-project browsers beside the scoped ones.** Two ways to
  list the same tasks, one of which needs a project filter to be useful,
  against the principle of one obvious way to do a job.
- **Remembering the current project only in the URL.** Pages outside a project
  would have no project to show in the sidebar, and the browsers' bare
  redirects would have no target.

## Refinement (2026-10-13, MMR-503): `/` is a cross-project work page, and the sidebar's context can be All projects

_Amended 2026-11-23 (MMR-722): `/` is Home, one feed column with no rail. The
main column's three sections, the rail's project health strip, and _When you
have a minute_'s four row lists below are superseded by the MMR-722
refinement; the switcher and sidebar rules stand._

The MMR-476 refinement made `/` a review page with a triage table and a
project rail; the MMR-492 refinement then gave every project a work page and a
sidebar. Beside the work page, the review page's two sections and its
per-project table read as a different kind of page. `/` becomes the work
page's cross-project counterpart, in the same row style. The MMR-476
refinement's main column and rail are revised, and the MMR-492 refinement's
sidebar rule for pages outside a project is revised:

- **The main column is three sections: _Needs you_, _Now_, and _Shipped_.**
  - _Needs you_ lists the decisions (ADR 0019) with their in-place verbs, as
    the _Decide_ section did, in ADR 0019's order. Its _Work through these ·
    N_ control opens the focus queue at `/?mode=focus`, which is unchanged.
  - _Now_ lists the in-flight tasks across active projects.
  - _Shipped_ lists recently finished tasks across active projects.
  - Every row carries its project key and uses the work page's row style.
- **The rail holds the project health strip and _When you have a minute_.**
  - The strip has one row per active project (ADR 0015) with its decisions
    (in the attention hue), live count, and going-cold count. Rows list
    pinned projects first, then the rest by most recent activity, as the
    switcher does (MMR-492 refinement), and each links to `/p/KEY`. It is the
    one project listing on `/`, and its order replaces the project order the
    MMR-476 refinement gave the review page's list.
  - _When you have a minute_ has four groups: runnable now (tasks that can
    start, each with _Start_), to triage (untriaged seeds, each with its
    _Promote…_, _Park…_, and _Reject…_ verbs), going cold, and `doctor`
    findings (a count per project with findings, linking to
    `/doctor?project=KEY`). These replace the triage table, keep the MMR-476
    refinement's in-place seed triage, and keep findings in the triage tier
    that ADR 0019's MMR-476 refinement counts them in.
- **The per-project triage table and the review page's project rail retire.**
  The rail's archived shelf and _New project_ move to the switcher, which
  already lists archived projects and offers _New project_.
- **The switcher gains an _All projects_ entry, first in its list, that leads
  to `/`.** On `/` and `/doctor` the sidebar's context is All projects: its
  header reads _All projects_, and only _Work_ (which is `/`, marked current
  on `/`) sits under it. This revises the MMR-492 rule that, on a page outside a
  project, the current project is the last one visited. Bare `/tasks`,
  `/seeds`, and `/artifacts` still redirect to the last visited project's
  browser.

ADR 0019 is unchanged: the decisions set, its order, and the attention hue
are the same, findings stay in the review page's triage tier, and only their
placement on `/` moves.

Considered and rejected:

- **A literal mirror of the work page, with a project chip on every row and
  no rail.** It loses the at-a-glance health of each project.
- **Rows grouped under project subheads in every section.** It repeats the
  project list in each section.

## Refinement (2026-10-16, MMR-529): Start builds the shared shell and adds a container runtime

[ADR 0035](0035-tanstack-start-container-host.md) refines the original rejection
of a meta-framework and a second distributable. The host needs its own runtime
and release boundary, independent of the CLI's installation and service lifecycle.
The console remains a client-rendered SPA with TanStack Query fetching its data.

`packages/ui` becomes `packages/host` (`@mimir/host`). TanStack Start runs in
SPA mode on Nitro's Bun preset and prerenders a data-free `_shell.html`.
Client routes remain code-based in `src/router.tsx`, behind Start's router
entry. Start's generated route tree supplies the document shell and server
routes. Server rendering does not read the store.

The PWA precaches the final `packages/host/.output/public` output and uses
`/_shell.html` for navigation fallback. `/api`, `/trpc`, `/_serverFn`, and
`/health` are excluded. The service worker caches the shell, never API data.
The offline-read and no-offline-write rules remain in force.

The container mounts the transitional `/api` dispatcher from `@mimir/api`
over its SQLite store. The same dispatcher serves `mimir serve`. The compiled
binary embeds the final public assets and uses the prerendered shell as its
SPA fallback, so its console stays bundled with its binary.

This slice adds a container runtime without retiring `mimir serve`, changing
CLI installation, or completing the host cutover. ADR 0035 governs the later
configuration, transport, distribution, and ownership changes. Its validation
boundary applies to this integration slice.

## Refinement (2026-10-17, MMR-536): the Start host serves the console, and the binary embeds none

Decision 1 embedded the SPA in the compiled binary and served it from
`mimir serve`. The console is now served by the Start host
([ADR 0035](0035-tanstack-start-container-host.md)), and the binary neither
embeds nor serves it. `mimir serve` is removed, and `bun run build` no longer
builds the UI into the binary. The MMR-529 refinement's embedded-assets
paragraph is superseded.

The console's shape is unchanged: a client-rendered SPA with offline reads and
no offline write queue. Its version is the host image's version.
[Run the Mimir host](../guides/host.md) covers running it.

## Refinement (2026-10-19, MMR-541): the `/api` dispatcher is gone

The container no longer mounts the transitional `/api` dispatcher, and
`@mimir/api` no longer exists. The console reads and writes through server
functions over the Engine. The service worker still excludes `/api`, `/trpc`,
`/_serverFn`, and `/health` from navigation fallback, so a request to the
retired `/api` reaches the host's `410` tombstone rather than the cached shell.

## Refinement (2026-10-19, MMR-562): the All projects sidebar lists pinned projects and a project search

The MMR-503 refinement left only _Work_ under the All projects header, so
opening a pinned project from `/` took two clicks: open the switcher, then
pick. On `/` and `/doctor` the sidebar now holds a _Projects_ section under
_Work_. Project pages keep their sidebar unchanged.

- **The section lists the pinned projects at rest**, in the switcher's order,
  each a link to its work page with its decision count. With nothing pinned, it
  lists the five most recently active projects. A line under the rows counts
  the other active projects a search would find.
- **A search box above the rows filters every project in place**: pinned, then
  the rest, then archived projects. Focusing it turns the rows into the
  switcher's listbox and keys: the arrows move, Enter opens, and Alt+P pins.
  The switcher and the section share one implementation of the listbox, its
  rows, and its pin. Escape clears the search, and a second Escape leaves it.
  In the desktop sidebar, `/` focuses the search when focus is not in a text
  field; in the phone drawer, an open dialog, it does not.
- **Leaving the search clears it** and turns the rows back into links. The
  listbox sits in the page rather than over it, so it carries
  `data-inline-listbox` and the page's hotkeys, such as ⌘K for the jump
  palette, do not yield to it as they yield to a popup listbox.

Considered and rejected:

- **Pinned projects on every page, with the current project expanded in
  place.** One-click switching between projects too, but each pinned project
  pushes the current project's outline down, and the switcher popover would
  retire. The two-click cost this refinement removes was on `/`.
- **A rail of project tiles beside the sidebar.** One-click switching
  everywhere without disturbing the panel, but it adds chrome that ADR 0019
  does not describe, and a three-letter key is a tile's only label.

## 2026-10-19 refinement: queued reservations in Now (MMR-564)

The work page's Now section includes `queued` alongside `in_progress`. A queued
row reads “Queued” with its reservation time and run handles, distinguishing
reserved work from a worker's claim. The review page inherits this Now bucket,
and its project in-flight count includes both statuses. The overview's in-flight
list additionally includes `under_review`, as before. Frontier remains todo work;
its one-step prerequisite set remains `in_progress`, `under_review`, or `ready`.

A queued task's record offers Start, Cancel reservation, Mark done, and Abandon.
Cancellation requires a reason and calls `unqueue`; parking and blocking become
available after the reservation is released. The status badge, timeline, and
selectors use the shared queued status word.

## Refinement (2026-10-19, MMR-567): the All projects sidebar drops its project search

The MMR-562 refinement gave the _Projects_ section a search box. It filtered
the same projects as the switcher in the header above it, with fewer
controls: no _All projects_ entry, no archive fold, and no _New project_. Two
ways to find a project on one sidebar go against one obvious way to do a job,
so the search box goes. The section lists only the pinned projects as links,
or the five most recently active projects when none is pinned, and the
switcher finds every other project. The MMR-562 changes to the hotkeys, which
served only the search (`data-inline-listbox` and Shift on bare hotkeys), are
withdrawn with it. The switcher keeps the shared listbox, row, and pin
implementation in `components/project-options.tsx`.

## Refinement (2026-11-02, MMR-615): reviews are in Now

A task under review is work in flight, not a decision (ADR 0001 and ADR 0019,
MMR-615 refinements). This ADR's MMR-467 refinement (_Now_ and _Needs you_),
MMR-476 refinement (_Decide_'s verbs and the focus queue), MMR-503 refinement
(_Needs you_ on `/`), and the queued-reservations refinement (MMR-564, the
in-flight count) are revised:

- **_Now_ lists tasks whose status word is `queued`, `in_progress`, or
  `under_review`.** A review row reads _In review_ with when the task
  started, and it is read-only like every _Now_ row. A held review reads
  `blocked` or `parked` and has the hold's home.
- **_Needs you_ no longer includes reviews,** on a work page or on `/`. Its
  rows act in place with _Answer…_ on a question; a block on you has no
  action, as before. The focus queue shows each decision's question, or what
  its block waits on, and the same actions as its row.
- **_Approve_ and _Send back…_ are on the task page only,** in its verdict
  block.
- **The review page's project in-flight count includes reviews,** because it
  counts the same _Now_ bucket. It now matches the overview's in-flight list.

## Refinement (2026-11-14, MMR-675): staged tasks in Now and the Frontier

`staged` (ADR 0001, MMR-675 refinement) is work in flight, so it joins the
in-flight set this ADR's MMR-615 refinement defined:

- **_Now_ lists tasks whose status word is `queued`, `in_progress`,
  `under_review`, or `staged`.** A staged row reads _Staged · submitted …_,
  timed from its latest submit, as a review row is. The review page's project
  in-flight count and the overview's in-flight list include staged tasks too.
- **The Frontier's one-step prerequisite set is `in_progress`,
  `under_review`, `staged`, or `ready`.** A staged prerequisite is closer to
  done than one under review, so its dependents stay under _Next to unlock_.
- **A staged task's record offers Mark done, Send back…, Park, Block, and
  Abandon.** A task under review also offers Stage.

## Refinement (2026-11-18, MMR-715): a phone's top bar folds its rare controls into More

The MMR-492 refinement's top bar keeps the brand, the jump palette, _Needs
you_, and the theme toggle. On a phone (below Tailwind's `md`), those controls
and the installed console's update action did not fit at the 44px touch
target that ADR 0019 sets for phone controls. They had shrunk to five
different icon and box sizes instead. On a phone:

- **The top bar holds the project menu, the brand, _Jump to_, _Needs you_, and
  _More_.** Each icon control is 44px with a 22px icon, and the _Needs you_
  pill is 34px tall.
- **_More_ holds the update action and the theme toggle.** Both are used
  rarely. A waiting update marks the _More_ button with a dot and adds
  "update ready" to its name. Choosing the update action keeps the menu open,
  so a check shows its progress. Outside the installed console, _More_ offers
  only the theme.
- **From `md` up the top bar keeps its controls:** the update action and the
  theme toggle sit in the bar, at 36px with 18px icons.

The top bar's icon controls and the close buttons of the record-page sheet,
the _Needs you_ sheet, the _Direction_ dialog, and the decisions walkthrough
share one icon button (`components/ui/icon-button.tsx`) and one icon set
(`components/ui/icons.tsx`). Search fields and chip remove buttons take their
marks from the same icon set. A text character's size and shape depend on the
font, so these controls no longer draw their icons from one. The
walkthrough's bordered _Back_ button and the seed composer's _esc_ close keep
their own forms.

The top bar is solid `well-950` with no blur. Nothing scrolls under it, and
the translucent bar it replaces let the status bar fade into the page. The
browser chrome color (`theme-color` and the manifest's `theme_color`) is
`well-950` too, so the status bar and the top bar read as one band. The
manifest's `background_color` stays `well-900`, the page ground.

## Refinement (2026-11-19, MMR-733): Settings is a console section

The console has one Settings area. `/settings` is an index, and its pages are
`/settings/notifications`, `/settings/appearance`, `/settings/devices`,
`/settings/connections`, and `/settings/about`. `/pair` stays where it is, because `mimir pair` prints its
URL (ADR 0038).

- **The index** has two groups of rows. _This device_ holds Notifications
  first, which shows how this browser stands (ADR 0045's MMR-711 refinement
  describes the page), then Appearance, which shows the stored choice (Light,
  Dark, or Match system). _Host_ holds Devices
  (pairing requests waiting, in the attention color, else the paired count),
  Connections (the T3 state in a word or two), and About (the console
  version). Every row links to its page. On a desktop the index fills the main
  column beside the sidebar.
- **Each page** is one column no wider than 900px. Where the sidebar is not
  beside the page (below `lg`), it opens with a "← Settings" link, then its
  title. Devices holds the waiting and paired lists with the inline unpair
  confirmation. Connections holds the T3 Code card and shows the callback's
  `?t3=` outcome once; with T3 unconfigured it says that no connections are set
  up. Appearance is a three-way choice, and Match system clears the stored pick
  so the console follows the OS again. About shows the host and console
  versions, the update check when the console runs installed, and a link to
  Record health, which stays at `/doctor`.
- **The sidebar has a third context.** On `/settings`, its pages, and `/pair`
  it shows "← Back to work", then _This device_ (Notifications, Appearance) and _Host_
  (Devices with the waiting count, Connections, About). The current page takes
  the selection treatment, and on `/pair` Devices is the current section. The
  context shows with no project too. Below `lg` the same content is the drawer.
- **Devices leaves the All projects sidebar.** It lists Work and the Projects
  section only. `/devices` redirects to `/settings/devices`, keeping its
  search.
- **The "…" menu is the only top-bar control at every width.** It holds
  Settings, a separator, the theme switch, and the update check when the
  console runs installed. The update-ready dot stays on the "…" button. The
  wide top bar no longer carries the update and theme icons that the MMR-715
  refinement above kept from `md` up.

## Refinement (2026-11-19, MMR-734): the review page may carry a one-time suggestion card

The review page (`/`) may show one card above Needs you that suggests turning
on notifications, under the rules of ADR 0045's MMR-734 refinement. Once this
browser answers it, it never shows again. A rebuilt review page keeps it in
the same place.

## Refinement (2026-11-20, MMR-736): UI SDK replaces Base UI under the components

The stack's component layer is no longer shadcn/ui in its Base UI flavor.
[ADR 0046](0046-console-primitives-on-ui-sdk.md) moves the console's headless
behavior to UI SDK, pinned to an exact version. Only `components/ui` imports
it, and features build from the patterns in ADR 0019's MMR-736 refinement.

- **The rest of the stack stands:** Vite, React, TanStack Router and Query,
  Tailwind v4, `vite-plugin-pwa`, and vitest.
- **The vendored-source reason holds for the look and the components**, which
  stay the console's own code; only behavior is imported. The components live
  in `packages/host/src/components`, not the `packages/ui` that decision 2
  names.
- **These passages change with the patterns:**
  - The MMR-733 refinement's "inline unpair confirmation" on Devices becomes
    a Destructive confirm.
  - The MMR-715 refinement's _Direction_ dialog becomes a field of the
    container's form.
  - The seed composer becomes the seed form in the Form sheet, which keeps
    the `s` hotkey and Enter to file; its own _esc_ close becomes the sheet's
    close.

## Refinement (2026-11-23, MMR-722): Home

The readability phase (MMR-717, design of record in artifact MMR-a420) rebuilds
`/` from ADR 0019's feed blocks. The page is now called Home. It is one feed
column, 900 wide at most, with no rail: the projects are listed in the
sidebar, so the project health strip retires. This revises the MMR-503
refinement's main column and rail; the focus queue at `/?mode=focus` is
unchanged, and the MMR-734 refinement's suggestion card keeps its place above
Needs you.

- **A page head names the day and summarises it in one sentence.** The page
  title is the day in the browser's zone ("Monday, 23 November"). The
  sentence under it counts what needs you, what runs, and what shipped this
  week: "10 cards need you, holding 26 items. 9 tasks are running, and 104
  have shipped this week." Each clause names its own part, so a mixed page
  says which parts are quiet ("Nothing is running, and 12 tasks have shipped
  this week."); the needs-you clause is left out when nothing needs you, and
  "holding N items" when each card is one item. A page where nothing needs
  you, runs, or shipped reads "A quiet week: nothing is running, and nothing
  has shipped this week." A hairline divides the head from the feed, 20 below
  the sentence and 32 above the first section.
- **The sections run in this order**, each left out when it has nothing to
  show, as MMR-a420's principle 6 sets:
  1. the one-time notifications card, when it applies;
  2. _Needs you_, the Needs you deck (ADR 0019, MMR-721 refinement), whose
     cards open their preview; with no cards, the quiet line "Nothing needs
     you." takes its place;
  3. _Now_, title cards for the tasks in flight (status, ID, project, and
     age on the status line; no detail), most recent move first (the latest
     submit, else the start, the moment the card's age counts from), four
     on a phone and six from 768. A card opens its preview, which states the
     status and when it began, and the harness and branch when the task has
     them;
  4. _Shipped this week_, the Shipped summary: seven days ending today, and
     the done tasks by project, most first. An abandoned task did not ship
     and is not counted;
  5. _When you have a minute_, count rows in a framed row group: Seeds to
     triage (untriaged seeds across projects), Ready to start (the runnable
     tasks), Going cold, and Doctor findings. A row at zero is left out.
- **The counts.** The deck's head reads both numbers, "N cards, M items": the
  cards it shows, and the needs-you records they hold, which is the count the
  top-bar alert shows. The alert does not change. This narrows ADR 0019's
  MMR-721 rule that the deck's head counts cards alone, for Home. Now's head
  reads "6 of 9" on a desktop and "4 of 9" on a phone when the cap hides
  cards, and the plain count otherwise. Shipped's head counts the week's done
  tasks, the number the page sentence uses.
- **No See all, and plain rows, until the list pages land.** Home has no See
  all link. A row with no destination is plain, with no chevron and no hover
  fill: Shipped's rows by project and the spare-minute rows (ADR 0019,
  MMR-722 refinement). The MMR-724 list pages will give them destinations.
- **Home's spare-minute work no longer acts in place.** The rail's runnable
  tasks with _Start_ and untriaged seeds with their verbs (the MMR-476 and
  MMR-503 refinements' in-place triage) are now counts. Each project's work
  page still lists the runnable tasks and acts on them. The Seeds page lists
  the untriaged seeds and links to each one; the triage verbs are on each
  seed's own page. The deck's own actions (_Clear stop_, _Answer…_, _Review N
  decisions_) act from Home, and the alert's panel keeps its grouped rows.

Considered and rejected (mocked as variants A and C beside the chosen B):

- **The deck leading the page, with no page head** (A). Its alert counted
  cards too, which changes the MMR-476 rule that the alert counts records,
  and the Needs you page title and the project list would have to follow.
- **Needs you as the page's one 21px header over a tighter glance tier**
  (C). Its alert and deck head counted items and only the pager counted
  cards, which breaks ADR 0019's MMR-721 rule that the head's count and the
  pager's N match, and it departed from the 15px feed section head and the
  32 section gap for this page.

## Refinement (2026-11-24, MMR-726): record pages take a header and tabs

Project, initiative, phase, and task pages open with ADR 0019's record
header (its MMR-726 refinement): a trail of the record's ancestors, the
title, the status line, the summary, and the state's main action with More.
On a project, initiative, or phase, tabs follow it and hold everything else,
and the rail retires. This revises the MMR-467, MMR-470, MMR-487, and
MMR-495 refinements' rail and tabs; the work sections are unchanged until
MMR-727 rebuilds them on Home's pattern.

- **The container rail and its phone chips retire.** Direction, About, and
  Artifacts were text behind buttons that look like badges; they move into
  tabs. A container's page is one column, 900 wide at most.
- **An initiative or phase has four tabs: _Work_, _Details_, _Timeline_, and
  _Artifacts_.** _Work_ opens with the rollup's progress bar and its legend,
  then the work sections. _Details_ holds the Direction in full, which
  More's _Edit direction…_ rewrites (the section draws no button of its own;
  with none set it reads "No direction set."), the description, what the record depends on and what it blocks
  (each a link with its status as the header shows one, the dot right before
  a bright word), and its created, updated, and target dates. _Timeline_ is
  the MMR-470 refinement's, with its count. _Artifacts_ lists what is
  attached, newest first, with its count.
- **A project has tabs: _Work_, _Tasks_, _Seeds_, _Artifacts_, and
  _Details_.** This replaces the MMR-470 rule that a project has no tabs.
  _Work_ adds a _Record health_ row to the doctor panel, when the project has
  findings, under the progress bar; it replaces the findings chip. _Tasks_,
  _Seeds_, and _Artifacts_ are the project's browsers (the MMR-495
  refinement's `/p/KEY/tasks`, `/seeds`, and `/artifacts`) drawn under the
  same header and tab row, so the sidebar keeps its one job. A browser's own
  title gives way to its tab, and the task browser's _New task_ to the
  header's. _Details_ is the project's Direction, its description in full,
  and its dates. A project has no summary field, so its description is the
  header's summary as well.
- **The URL holds the tab.** Work has no parameter. An initiative's or
  phase's `?tab=` takes `details`, `timeline`, or `artifacts`; a project's
  `/p/KEY?tab=details` opens Details, and its browser tabs are their routes.
  A value the page does not know drops, and a reload opens the same tab.
  Arrow keys move along the tabs; on a project, whose tabs lead to other
  routes, Enter or a click opens one, so arrowing along the row does not
  load every page it passes.
- **A tab with nothing in it is hidden.** An initiative or phase with no
  task under it has no _Work_; _Artifacts_ shows once one is attached.
  _Details_ and _Timeline_ always have something (the dates, the creation).
  A project's _Work_ always shows, since what needs the operator and seeds
  to triage span the whole board; _Tasks_ hides while it holds no task,
  _Seeds_ while it has none, and _Artifacts_ while nothing is frozen to it.
  The tab on screen always shows. A URL that names a hidden tab, or none on
  a container with no _Work_, opens the first tab with something in it and
  is replaced with that tab, so the page stays on it when the hidden tab
  fills, and Back does not return to the hidden one.
- **A task's page keeps its body, rail, and Links, Agent, and Details chips**
  under the new header, until MMR-728 gives it the same tabs. Its Actions
  chip and rail section are retired into More.
- **The trail is the way up.** The "↑" link to the parent that a phone page
  showed above its ID retires; the trail's last step is the parent, on every
  width. The sidebar outline still shows where the record sits.

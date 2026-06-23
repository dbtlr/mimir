# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once it ships v1.0. Mimir is **pre-release** (`0.x`) and will be for a while;
minor releases may include breaking changes.

## [Unreleased]

Entries here have landed on `main` but have not yet been cut into a tagged
release. When a release is cut, this section is promoted to
`## v0.X.Y - YYYY-MM-DD` and a fresh `## [Unreleased]` header is added above it.

## v0.11.0 - 2026-06-22

The review & mobile release: an optional `under_review` ship-readiness gate
between `in_progress` and `done`, and a mobile board legibility pass.

### Added

- **`under_review` status** — an optional ship-readiness gate between
  `in_progress` and `done`. New `submit` and `return` verbs (CLI, MCP, and
  `POST /api/nodes/:id/submit|return`) drive it; the web console gains an Under
  Review board column. Approval reuses `done`; `stale` chases a review left too
  long. Migration 0006 widens the lifecycle CHECK. (MMR-84)

### Changed

- **Mobile board legibility pass** — the per-status tab row becomes a
  column-header dropdown that shows the current column and jumps to any other; the
  card title wins by weight; the drag-grip is desktop-only; `+ New task` is an
  icon button and the secondary nav folds into an overflow menu on mobile; and the
  header, toolbar, switcher, and cards share one consistent margin. (MMR-86)

## v0.10.0 - 2026-06-21

The ergonomics & orientation release: responses that orient you and point
onward, describable and renamable projects, and a new tree view.

### Added

- **Project descriptions and rename.** A project can carry a description and be
  renamed: `mimir create project "Name" --key KEY --desc "…"`,
  `mimir update KEY --desc "…"` / `--name "…"`, surfaced and editable in the web
  console. New `PATCH /api/projects/:key` (MMR-88, MMR-89).
- **`mimir tree <id>`** — a compact, recursive view of the hierarchy under any
  node, rooted at a project, initiative, or phase (MMR-90).
- **Self-orienting reads.** `get` / `status` now signpost when a status word is a
  rollup over a node's direct children and point onward (to `mimir tree` and the
  ready-task queue); node references carry titles. Hints render only in styled
  terminal output — `json` / `jsonl` / `ids` stay a clean machine contract
  (MMR-90).
- **Actionable error hints.** A lifecycle verb aimed at a container (e.g. `start`
  on a phase) names a ready task to start instead; referencing a project that
  doesn't exist tells you how to create it — consistently across the CLI, MCP,
  and HTTP surfaces (MMR-91).
- **Empty-result clarity.** `next` / `list` with no matches print a clear
  "No ready tasks" / "No tasks" line in the terminal, removing the
  blank-versus-failed ambiguity (MMR-95).

### Changed

- **Type filtering** uses the query operator family — `--eq type:phase`,
  `--in type:phase,task` — taught in `-h` / `--help` and the agent skill
  (MMR-94, MMR-92).
- **Agent skill** gained a bound-but-missing-project bootstrap recipe and
  clearer teaching of rollup-versus-leaf, the "what is this?" idiom
  (`get <id>`), container lifecycle, and the `-s` scope convention
  (MMR-92, MMR-96).

### Removed

- The non-functional `--type` flag (it was silently ignored). Use `--eq type:`
  / `--in type:` instead (MMR-94).

## v0.9.0 - 2026-06-17

The web-console polish release: a light theme, a rebuilt top bar (project
picker, global attention alert, "Mimir" rename), a denser board that
foregrounds the actionable set, a portfolio `/tasks` browser, and a batch of
ergonomic fixes.

### Added

- **Light mode.** The console gains a light theme alongside dark — it follows
  the OS preference by default, remembers an explicit pick, and toggles from the
  header. Faint text on dark cards is also more legible (MMR-74, MMR-77).
- **Project picker** in the top bar — switch between project boards from
  anywhere via a dropdown of projects (status + ready count), without returning
  to the fleet (MMR-79).
- **Global attention alert** in the top bar — the cross-project stuck set
  (blocked + stale) as a count badge + menu, on every route; selecting an item
  opens it on its board (MMR-80).
- **Reparent a task from the drawer** — the edit view gains a parent picker
  (the grouped initiative→phase list) that moves the task; reparenting is the
  `move` verb, kept distinct from the dumb field update (MMR-73).
- **`/tasks` browser** — a portfolio task list (sibling of `/artifacts`):
  filter by project and status universe, search titles, and open any task in
  the node drawer. Backed by a new `q` case-insensitive title substring on the
  node listing (`GET /api/nodes?q=`, core `listNodes`; LIKE, FTS5 deferred)
  (MMR-78).
- **Swipe between board columns on mobile** — a horizontal swipe moves to the
  previous/next column tab (MMR-70).

### Changed

- **The board foregrounds the actionable set** — Ready and In progress stay
  full columns; Parked, Blocked, and Awaiting collapse to count strips that
  expand on click; Done is windowed to recent completions with a "view all →"
  drill into `/tasks`. Refines ADR 0013 §4 (MMR-76).
- **Renamed the console to "Mimir"** (from "Operator Console") (MMR-80).
- **Fleet cards lead with the ready count** — the actionable number — in place
  of the in-flight/stale/blocked triplet (stuck work now lives in the attention
  alert) (MMR-82).
- **Console type scale is rem-relative.** Font sizes now derive from a single
  `html` base (bumped slightly) instead of hardcoded pixels, so the whole UI
  scales from one knob and honors the browser's font-size preference (MMR-71).
- **Task form shows the description up front** — no longer hidden behind the
  "More details" disclosure (MMR-75).

### Fixed

- **Buttons show a pointer cursor again** — Tailwind v4's preflight had reset
  enabled controls to the default cursor (MMR-69).
- **The artifacts list and reader scroll independently** — the console is now a
  fixed-height app shell, so panes scroll internally instead of the whole page
  (MMR-81).

## v0.8.0 - 2026-06-17

The authoring release: the operator console grows a full write/authoring surface,
and the node drawer gains a transition-history timeline.

### Added

- **Task authoring on the console** — create work from the board (a `+ New task`
  button opens a sheet with a grouped initiative→phase parent picker), edit a
  task's mutable fields inline in the drawer (title, description, priority, size,
  external ref), add freeform annotations from a composer, and add or remove tags
  inline. Status is never edited here — lifecycle stays the explicit transition
  verbs (MMR-64, MMR-65, MMR-66).
- **Task timeline** — the node drawer shows how a task reached its current state:
  its transition history (started / completed / parked / blocked / reparented /
  dependency changes, with reasons) merged with annotations into one
  chronological feed, split across All / Activity / Notes tabs. Backed by a new
  `history` facet on `GET /api/nodes/:id` (MMR-60).
- **Board card ancestry** — each task card shows its `initiative › phase`
  breadcrumb, not just the drawer (MMR-67).

### Changed

- **Board column order** is now Parked → Blocked → Awaiting → Ready → In Progress
  → Done (MMR-68).
- **Artifacts search** is controlled and debounced — typing no longer issues a
  query round-trip per keystroke, and the box re-syncs when the query changes
  from outside, e.g. Back/Forward (MMR-63).
- **Prerelease pruning** now runs at an official cut: cutting a release deletes
  prereleases from cycles older than the previous official (lag-by-one
  retention), where it previously only logged what it would delete (MMR-58).
- Toolchain: Vite 7→8 and `@vitejs/plugin-react` 5→6 (MMR-61); Vitest 4, jsdom 29,
  oxlint 1.70.

## v0.7.0 - 2026-06-16

The console release: the read-only operator console grows a write surface, and a
portfolio-wide artifacts browser for reading the work's frozen record.

### Added

- **Console intervention (write surface)** — drive task lifecycle and hold verbs
  from the board and the node drawer (`start` / `done` / `park` / `block` /
  `abandon` / `unpark` / `unblock`) via a per-card kebab menu that offers only the
  legal transitions, and reorder the ready queue by dragging a card's grip handle.
  `park` / `block` / `abandon` capture an optional reason; offline disables every
  write (no write queue) (MMR-51).
- **Portfolio artifacts browser** — a new `/artifacts` view searches and filters
  frozen artifacts (specs, plans, session logs) across every project by project,
  tag, date, and full text, and renders their markdown bodies with linked-node
  backlinks. A task's drawer links straight to its artifacts (MMR-52).
- `mimir service status` now supports structured output (`-f json` / `-f jsonl`)
  — a machine-readable report (loaded / running / pid / port / health /
  versions / recent events / paths) for scripts and health-checks (MMR-59).

### Changed

- `service` and `self-update` output now follows the standard CLI format
  contract. **Behavior change:** when stdout is not a TTY (piped, cron, CI),
  these commands now default to JSON instead of human prose — pass `-f records`
  for the prose form (MMR-59).

## v0.6.0 - 2026-06-14

The operations release: run `mimir serve` as a supervised service, keep it
current with in-place self-update, and pull pre-release builds from a continuous
channel for testing.

### Added

- **Continuous prerelease delivery** — every build-affecting merge to `main`
  publishes an installable `vX.Y.Z-next.N` prerelease (docs/vault-only merges
  produce nothing). `mimir --version` reports the exact tag the binary was built
  from. Install/update the prerelease channel with `MIMIR_NEXT=1 sh install.sh`,
  `mimir self-update --next`, or pin an exact build with `mimir self-update
--tag v0.6.0-next.5`. Default `install`/`self-update` stay on official
  releases. See CONTRIBUTING for the release procedure.
- **`serve` hunts for a free port** — when the requested (or default) port is
  taken, `serve` walks upward up to 20 ports and binds the first free one,
  always printing the actual bound URL (with a note when it differs from the
  request). Past the hunt span it fails with the normal error. A dev
  convenience: supervised deployments still pin the port and the proxy points
  at it (ADR 0012). Port precedence: `--port` flag > config `[serve] port` >
  default 64647; `--no-hunt` disables the walk and fails loudly on a taken
  port (required for supervised/launchd operation).
- **`mimir service`** (macOS): supervise `mimir serve` under launchd —
  `install [--port <n>] · uninstall · start · stop · restart · status`. The
  daemon runs on a declared port from the new global config
  (`~/.config/mimir/config.toml`, `[serve] port`; `service install --port`
  writes it) with `--no-hunt`, so a taken port fails loudly and launchd's
  KeepAlive retries until it frees — the proxy's target can never drift. Every
  lifecycle action is logged to `~/Library/Logs/mimir/service-events.jsonl`;
  `service status` reports pid, port health, running vs on-disk version
  ("restart pending"), and the recent events.
- **`mimir self-update`**: resolve the latest release, verify the platform
  binary against `SHA256SUMS`, atomically replace this binary, and restart the
  service if one is loaded.
- **`GET /api/health`** — `{status, version}`; no database touch, suitable
  as a proxy health check.

## v0.5.0 - 2026-06-12

The console release, part two: the binary now ships the web UI. This is also
the first release from the Bun-workspace monorepo.

### Added

- **The operator console** — a read-only web UI embedded in the binary and
  served by `mimir serve` alongside the API (ADR 0013). `/` is the fleet view
  (per-project status cards plus a cross-project attention strip of in-flight
  and stuck work); `/p/KEY` is the project surface — a kanban board whose
  columns are the status vocabulary (Ready in rank order _is_ the queue) with
  a tree lens one toggle away; any node opens a URL-addressable detail drawer
  (record, signals, dependencies, tags, annotations, artifact titles). The
  console is an installable PWA: works on desktop and mobile, polls while
  visible, and when the server is unreachable shows the last-synced board
  behind an explicit offline banner. No write affordances in this first cut.

### Changed

- **The repo is a Bun workspace** (ADR 0010 refinement): `packages/bin`
  (`@mimir/bin`, the binary) and `packages/contract` (`@mimir/contract`, the
  dependency-free wire-type leaf, now also carrying the error-envelope and
  `{items}` collection types), plus `packages/ui` (`@mimir/ui`). Installing
  from source is now clone-and-build; the `curl|sh` binary install is
  unchanged.

### Fixed

- The MCP tool schemas for `priority` and `size` now derive from the
  contract's value tuples instead of hand-inlined copies.

## v0.4.0 - 2026-06-11

The console release: the HTTP API ships in the binary, and the architecture
docs ship in the repo. After upgrading, re-run `mimir skill install` to
refresh installed copies of the embedded skill.

### Fixed

- Blank required tokens (`--to ''`, `--on ''`, `--before ''`/`--after ''`, a
  blank positional id, or a blank entry in a `--on` list) are now usage
  errors (exit 2) instead of resolving to `not_found` (exit 1) — a blank
  where an id belongs is a malformed invocation, not a lookup miss.
- **The throwaway in-memory database is gone** — the CLI acquires the store
  lazily, only when a verb actually touches data. Previously `main` kept a
  hand-maintained verb list to decide who got the real database; a verb
  missing from it silently ran against a throwaway in-memory store (the
  v0.2.0 `tag`/`untag` write-loss bug class). There is no list to forget
  anymore, `createDb` requires an explicit path (in-memory is test-only),
  and bare `mimir`/`--help`/unknown commands still never create a file.

### Changed

- **`update` accepts artifact ids** (`mimir update KEY-aN --title "…"`,
  `PATCH /api/artifacts/:id`, and the MCP `update` tool): title is an
  artifact's one mutable field, so a mistitled `attach` is no longer
  permanent. Content stays frozen (ADR 0004); node-only fields on an
  artifact id are a validation error. Re-tagging with `--note` already
  replaced the stored note (tag is an upsert) — now documented in the skill.
- The embedded skill teaches the `--col verdicts` read (the Phase-4 derived
  flags) alongside the `--is` filters; re-run `mimir skill install` after
  upgrading to refresh installed copies.
- Node-token rejection ("`X` is a project, not a task") is one core
  implementation behind the CLI, MCP, and HTTP guards instead of three
  transport-edge copies.

### Added

- **Architecture docs in-repo** (`docs/`): the twelve ADRs (`docs/decisions/`,
  Nygard convention) plus the two maintained engineering references —
  `docs/schema-reference.md` and `docs/output-contract-reference.md` — moved
  out of the maintainer's private workspace so code-comment citations resolve
  for every reader.
- **The HTTP API** (`mimir serve`, ADR 0012): the resource envelope for the
  operator-console UI — conventional REST over the core on native `Bun.serve`.
  Reads: `GET /api/projects` (+ per-project rollups), `GET /api/projects/:key`,
  `GET /api/projects/:key/tree` (the full nested hierarchy in board order),
  `GET /api/nodes` (flat, cross-project, the whole filter dialect as query
  params), `GET /api/nodes/:id`, annotations and artifacts as sub-resources,
  and `GET /api/transitions?since=<cursor>` (the polling feed). Writes are the
  core verbs as action sub-routes (`POST /api/nodes/:id/start` …); `PATCH
/api/nodes/:id` is exactly the dumb `update`. Every write echoes the full
  updated record; errors are the existing envelope plus a status code
  (`not_found` 404, `validation` 400, `conflict`/`invariant` 409). Collections
  return `{items: […]}` envelope objects (cursor room reserved; no pagination
  yet). Binds `127.0.0.1` only, `--port` defaults to `64647`; TLS/exposure
  belong to the proxy in front (auth deliberately open — ADR 0012).
- **`verdicts`** — the non-status derived predicates (`stale`, `blocking`,
  `orphaned`) as one read: always-on in API records, and available everywhere
  as a `--col verdicts` column on the CLI/MCP `get`.
- **Core resource reads** behind the API (transport-agnostic like everything
  else): `listProjects`, `projectTree`, `listTransitions`.

## v0.3.0 - 2026-06-11

The adoption release: the agent skill ships in the binary, and a working copy
binds to its project with a checked-in file. Pre-release: the breaking change
below ships without a deprecation shim — there are no external consumers.

> Upgrade note: the first run of v0.3.0 migrates the store (`0004`); after
> that, a v0.2.0 binary's `create project` will fail against it. Upgrade,
> don't mix.

### Added

- **The agent skill** (`mimir skill install`): the skill that teaches agents to
  drive Mimir — session-start orientation, the transition contract, the id
  grammar, the query gallery, tags, and setup — ships **embedded in the
  binary** (it can never skew from the surface the binary speaks) and installs
  with `mimir skill install [--global|--local] [--agent claude|codex]`
  (claude → `.claude/skills/mimir`, codex → `.agents/skills/mimir`; re-run
  after an upgrade to refresh).
- **Project Binding** (ADR 0011): `mimir bind <KEY>` writes a checked-in
  `.mimir.toml` (`project = "KEY"`) binding a working copy to its project.
  Every command resolves the nearest binding file (walking up from cwd) as
  the default `--scope`; an explicit `-s` overrides, and the literal
  `-s all` queries every project. The MCP server honors the same binding,
  resolved from its spawn cwd.
- `create project` now confirms the immutable key: interactive sessions get
  a prompt; non-interactive callers must pass `-y`/`--yes` (usage error,
  exit 2, otherwise).

### Removed

- **Breaking:** the `project.repo` / `project.path` columns and the
  `--repo`/`--path` flags on `create project` (migration `0004`). A stored
  filesystem path pins a project to one machine; the repo→project binding
  lives repo-side in `.mimir.toml` now (ADR 0011). Both columns were
  write-only — never rendered by any read surface.

## v0.2.0 - 2026-06-10

The first release carrying the **write surface** (v0.1.0 was read-only), plus
the contract revision groomed out of the first dogfood. Pre-release: the
breaking changes below ship without deprecation shims — there are no external
consumers.

### Added

- **The write surface** — all mutation/create verbs over both CLI and MCP:
  lifecycle (`start` · `done` · `abandon`), holds (`park`/`unpark` ·
  `block`/`unblock`), dependency edges (`depend`/`undepend --on`), structure
  (`move --to`, `reorder --top|--bottom|--before|--after`), data (`update`,
  `annotate`), `create project|initiative|phase|task`, and `attach`. Every
  mutation echoes the affected node; errors render as a structured
  `{"error":{code,message,hint?}}` envelope (machine formats) or a `✗` +
  `note:` line (human formats), with coarse `0`/`1`/`2` exit codes.
- **The identity grammar** — one rendered id per entity, spoken by every
  surface: project `KEY`, node `KEY-seq`, artifact `KEY-aN` (per-project
  sequence; migration backfills existing artifacts). Any id position accepts
  the full grammar; the verb rejects types it can't act on (`done MMR` →
  "MMR is a project, not a task"). `get KEY` / `status KEY` render the
  whole-project view and rollup.
- **The tag write surface** — `tag <ids> <tag>… [--note]` / `untag <ids>
<tag>…` reaching projects, nodes, and artifacts; repeatable `--tag` on
  every `create` and on `attach`. Vocabulary stays free-text; `untag` is a
  plain row delete, deliberately not transition-logged.
- **Query surface v2** — `--status` picks the selection universe (the closed
  status words plus `live` (default) / `terminal` / `all`; terminal orders by
  `completed_at` desc), `--is`/`--not-is` select the derived verdicts
  (`stale` · `blocking` · `orphaned`), and field operators filter within it:
  `--eq`/`--not-eq`, `--in`/`--not-in`, `--has`/`--missing`, and the date ops
  `--before`/`--on`/`--after`/`--not-before`/`--not-after` over the
  projection's bare fields (`tag` is a multi-valued pseudo-field). All
  AND-composed. A value fault (enum miss, bad date) warns and returns an
  empty set — exit 0, structured `{"warning":…}` envelope with zod-style
  `expected` info (folded into the payload over MCP); a structural fault
  (unknown field, wrong-type operator) is a usage error.
- **Artifact title + readback** — `title` is a required artifact column
  (CLI defaults it from the `--file` basename; existing rows backfill from
  the content's first markdown heading). `get KEY-aN` returns metadata +
  links + tags, and the frozen body via the opt-in `content` column.
- `create project` accepts a positional name like every other create type.

### Changed (breaking)

- The projected field `state` is renamed **`status`** on every surface —
  DTO/wire, table/records labels, MCP schemas. The `mimir status` verb is
  unchanged.
- `--predicate` is replaced by `--status` + `--is` + the field operators.
- The `--col` vocabulary is **flat** — the dot prefix (`--col .deps`) is
  dropped; `--col deps`. A dotted column is now a usage error.
- The artifact echo `#N` is replaced by the `KEY-aN` rendered id everywhere
  (echoes, facets, JSON/MCP); internal integer ids no longer cross the
  surface.
- `attach` requires a title (explicit over MCP; basename default on the CLI).

## v0.1.0 - 2026-06-05

The first pre-release: a usable read slice over a complete, storage-committed
core. Mimir holds work state in SQLite — the `project → initiative → phase →
task` tree with two-axis task status — and answers "what's next?" over both a
CLI and an MCP server, with every rollup and predicate derived live, never
stored. Write verbs exist in the core; exposing them on the transports is the
next slice.

### Added

- **The work model + schema.** A typed adjacency tree (`initiative | phase |
task`) under a `project`, with two stored status axes on tasks — `lifecycle`
  (todo → in_progress → done / abandoned) and a `hold` overlay (none / blocked /
  parked) — plus dependency edges, annotations, frozen artifacts, polymorphic
  tags, and an append-only transition log. Row-local CHECK constraints make
  structurally-illegal rows unrepresentable; the core owns the behavioral
  invariants the DB can't express.
- **Live derivation, never stored.** The single **State word** per node, the
  `interpret` rollup cascade over a node's children, and the predicates
  `ready` · `awaiting` · `blocked` · `blocking` · `stale` · `orphaned`.
- **Rank** — one relative order per project that wins over priority; priority
  and size are orthogonal filtering/advisory signals. Reorder (top / bottom /
  before / after) with an idempotent re-spread when integer gaps run out.
- **The read commands**, one intent layer rendered two ways:
  - `mimir next` — ready tasks in rank order, scope/priority/size filters.
  - `mimir list --predicate <p>` — broad selection (all / ready / awaiting /
    blocked / stale / blocking / orphaned).
  - `mimir get <KEY-seq>` — full record with cheap facets (`.history` opt-in).
  - `mimir status <KEY-seq>` — a node's rollup distribution + state.
- **Output formats** — styled `table` / `records` for a TTY, structural
  `ids` / `json` / `jsonl` for pipes (a versioned wire contract, never styled).
  The default follows the destination; `--format` overrides. Identity selection
  exits non-zero on a missing id; predicate selection exits 0 on empty.
- **MCP server** (`mimir mcp`) — the same intent layer as `next` / `get` /
  `list` / `status` tools over stdio, via the official MCP SDK.
- **Database location** — a single user-global store at
  `$XDG_DATA_HOME/mimir/mimir.db` (default `~/.local/share/mimir/mimir.db`);
  `MIMIR_DB` overrides. Migrations apply automatically on startup;
  `mimir migrate [status]` is also explicit.
- **Tooling** — `mimir --version`; the zero-warning quality gate (oxfmt +
  oxlint + type-aware typecheck) and a `bun:test` suite on in-memory SQLite;
  CI on every push/PR; this release pipeline (standalone binaries + a shell
  installer).

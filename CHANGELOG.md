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

### Added

- **Node dossier — deep-read detail overlay** (MMR-222). The node-detail
  surface (`?node=KEY-seq`) is rebuilt on the Meridian design system as a
  centered overlay over a dimmed board, replacing the right-anchored drawer at
  every mount (overview, tasks browser, project board/tree). One shared header
  (mono id, uppercase status pill, parent breadcrumb) sits over two columns: the
  left is the stable record — title, a violet **verdict block** shown only under
  review (a derived submitted-summary line + external-ref link over inline
  **Approve** / **Return with notes…**), full unclamped description, a
  **SIGNALS** / **BLOCKING** grid, and an **ARTIFACTS** chip row (❄ glyph); the
  right is the timeline ground on a recessed well — All / Activity / Notes tabs,
  a bounded feed with a bottom fade edge, filled status-colored dots for
  transitions versus outlined dots for notes, 3-line note clamping with expand
  in place, and a pinned append-only composer. The kebab is **retired** here:
  legal transitions surface as labeled verb chips (reason-carrying verbs open
  the shared reason dialog), alongside a **Move…** picker and **Edit**. Tags now
  render read-only in SIGNALS. The `?node=` URL contract (deep-link, Esc/✕
  close), TanStack Query data flow, invalidate-and-refetch writes, and offline
  inerting of every write affordance are preserved. Adds a reusable `pill` shape
  to the status-chip kit variant.

- **Node quick views** (MMR-223). Clicking a board card now opens a compact,
  read-only preview of that node in place — distinct from the full dossier — in
  two renderings gated on the board's existing `md:` split. On desktop it's a
  **drop panel** (6a): a full-width row inserted below the selected card's band
  row, the card marked with a ring (violet for under-review, teal otherwise) and
  a caret tying it to the panel, which shows the clamped description and signals
  on the left and, on the right, either the verdict block (**Approve** / **Return…**,
  the real `done`/`return` verbs) for under-review nodes or a status-context
  summary otherwise. On mobile it's a **shelf** (6c): a fixed bottom sheet with
  the id, status pill, title, clamped description, and three ≥44px actions — the
  primary verb, a **Verbs…** menu for the rest, and **Dossier ↗**. Esc closes the
  panel; ✕ closes either; only one is open at a time. The description and latest
  note are fetched per open (`nodeQuery`/`annotationsQuery`, mirroring the drawer)
  with a skeleton while loading; verbs run through the existing transition
  mutation and disable offline. The panel's **Full dossier ↗** and the shelf's
  **Dossier ↗** route through the existing `?node=` node-detail mechanism.

- **Mobile board** (MMR-224). The project board's phone surface
  (`/p/:key?view=board` below the `md` breakpoint) is rebuilt on the Meridian
  design system as a single-status view: one wash **status control** pill (dot +
  label + count + caret) that taps open a **nine-word bottom sheet** — a 2-column
  grid of every Status word in the canonical order with per-word counts, the
  active word carrying the wash-and-ring idiom — plus **swipe left/right** to page
  between statuses. The selected status's cards are grouped by band under inline
  band headers (name + `∞` for standing bands + hairline + per-status count),
  sourced from the shared band model, and rendered with the kebab-free board card
  at mobile touch sizing (13×14 padding, 15px title, 44px min hit target). The old
  six-tab column switcher is retired. Card taps route to node detail exactly as
  the desktop swimlane does; offline keeps the control and sheet browsable while
  card write affordances stay disabled. `new` and `abandoned` show their rollup
  counts in the sheet but are inert (the board never fetches their card lists).

- **Meridian wave-2 wiring** (MMR-258). Closes out the board/quick-view
  integration: the mobile board's card tap now opens the **shelf** (MMR-223)
  instead of routing straight to the dossier — its **Dossier ↗** still opens
  the full detail — and the shelf closes when the visible status page changes
  (swipe or the nine-word sheet). Under review, the shelf swaps its generic
  primary verb for the same **Approve** / **Return…** pair the desktop drop
  panel shows, with park/block/abandon still under **Verbs…**. The nine-word
  sheet's `new`/`abandoned` rows are now plain, quieter census rows — a count
  with no selection affordance — rather than disabled-looking dead buttons.
  The legacy kebab (`NodeCard`, `TransitionMenu`), unmounted since the Meridian
  rebuild, is removed.

- **Fixture vault generator** (MMR-255). A standalone dev script
  (`bun run fixtures:vault [path]`) seeds a throwaway Norn-managed vault with a
  one-of-everything set of work states — every Status word as a leaf and a
  container rollup, both open-ended-home readings, a backdated going-cold cohort
  (via a frozen clock), all four attention lanes across four plausibly-named
  projects, an orphan and an orphan-muted case, a dependency chain, tags,
  artifacts, and seeds in all four lanes — so the console's visual smokes can
  screenshot state-dependent UI treatments without pointing at a live personal
  vault. Built through the real core mutation path (no raw markdown writes); not
  wired into the release binary or CLI dispatch. Regenerates into a gitignored
  `.dev/fixture-vault` by default.
- **Board swimlanes** (MMR-221). The project board (`/p/:key?view=board`) is
  rebuilt on the Meridian design system as a band-spine × status-column grid.
  The header restyles to spec (title, key chip, status pill, rollup bar) and
  gains a **Bands** control that groups the board client-side — **Phase** (by
  nearest phase/initiative ancestor, the default), **Release** (by `release:*`
  tag, untagged trailing in *No release*), or **Off** (a flat grid) — as a new
  URL-addressable `?bands=` search param, default-stripped like `?view=`. A
  **HELD** ledge surfaces project-wide Parked / Blocked / Awaiting counts, and
  each swimlane cell carries the new card anatomy: the default live card, the
  under-review verdict card with inline **Approve** / **Return…** (the existing
  `done`/`return` verbs), the recessed Done card, and a lightweight cold marker
  on stale work. Data flow, drag-to-reorder, offline demotion, and the Done
  drill-through to `/tasks` are preserved.
- **Tree lens rebuilt as Meridian grouped panels** (MMR-225). The project tree
  lens (`/p/KEY?view=tree`) is re-cut into three flat visual levels: initiative
  (and standing-home) section headers, phase panels, and leaf rows — replacing
  the uniform nested-disclosure tree. Initiative headers carry an `INITIATIVE`
  microlabel, a derived `N done · M live · K review` leaf-count summary, and a
  rollup distribution bar over a teal child spine; standing homes read
  `STANDING` / `∞` / `OPEN FOR FILING` over a neutral spine. Phase panels always
  show a distribution bar plus an interpreted word (`in_progress` reads
  `IN MOTION`), never a bare status. Consecutive done phases fold to one recessed
  `Phases N–M` / `DONE · count` row, and a panel's parked leaves fold to a
  trailing `N parked · expand` row, both expandable in place. Under-review leaves
  gain inline Approve (`done`) / Return… (`return`, via the shared reason dialog)
  with a faint violet row wash; offline inerts them. The route, `?view=tree`
  search param, `TreeView` contract, and tree data fetch are unchanged.

- **Overview rebuilt to the Meridian console surface** (MMR-226). The `/`
  attention router is restyled to pixel-fidelity against the settled 3a mock: a
  desktop page header ("Projects" + count and the one solid "+ New project"
  action, disabled offline); four hue-keyed lanes (Awaiting you / Live / Needs
  unsticking / At rest) each led by a mono microlabel and a hairline rule that
  fades right, empty lanes omitted; project cards carrying a key/title/signal
  row, a distribution bar, and a grouped `live / ready / review / held`
  leaf-count row with per-lane treatment (violet border + glow and a
  "verdict waiting" count on Awaiting you, a red border and a blocked count on
  Needs unsticking, a live pip and a "moved …" recency tail on Live); the At-rest
  lane folds to a recessed strip of mono key chips, unfolding to the same card
  grid. The top-bar attention control becomes a calm "N for you" wash+ring pill
  (hidden at zero, never red or solid) opening a "Needs you" menu whose rows now
  render a `{status} · {ID} · {age}` meta line. Data flow, deep-links, polling,
  and offline demotion are unchanged.
- **Seed verbs across CLI, MCP, and HTTP** (MMR-245). The grooming-queue entity
  (MMR-244) gains its verb surface. `mimir seed "<title>" -k <kind> [-p KEY]
  [--desc …]` files a seed (target board and requester default from the bound
  board; filing into another board via `-p` records the bound board as the
  requester, else self-filed). `mimir seeds [-p KEY] [--requester KEY]
  [--status …] [--sort asc|desc] [--grouped]` reads the queue — live seeds
  oldest-first by default, a lane view (UNTRIAGED / READY TO RESOLVE / SETTLED)
  under `--grouped`. `mimir promote KEY-sN --parent <node> [task args]`
  germinates a seed into work via the existing create path (or `--link KEY-seq`
  records existing work), appends the spawned provenance link, and moves
  `new → promoted` on the first promote (repeatable). `mimir reject`/`resolve
  KEY-sN "<reason>"` are the terminal transitions (reason required); `mimir
  update KEY-sN` patches a live seed's title/kind/description. Tasks gain an
  `--upstream KEY-sN` flag on create/update exposing the requester-side seed
  pointer. MCP maps these 1:1 (`seed`, `seeds`, `get_seed`, `promote`, `reject`,
  `resolve`, plus `upstream` on the task tools); HTTP mirrors the artifacts
  resource — `GET`/`POST /api/seeds`, `GET`/`PATCH /api/seeds/:id`, and
  `POST /api/seeds/:id/{promote,reject,resolve}` — echoing full records. Every
  verb-facing read runs through one resolving seam that nulls an unknown
  requester and prunes a dangling `spawned` ref (and derives ready-to-resolve
  live), so a read never surfaces what the validator would drop; the `mimir
  doctor` seed/upstream severities are now truthful to that seam — dangling
  `spawned` and unknown `requester` are `error` (dropped/nulled on read), while
  a dangling `upstream` is `warn` (reference-only, surfaced for repair).
  - The seed wire carries a single-sourced `lane` (untriaged/ready/promoted/
    settled) so consumers derive nothing; `get KEY-sN` reads a seed on every
    surface; `seeds -p all` / `?project=all` reads every active board; and the
    `promote` echo carries a sibling `created` (the spawned task id) on MCP + HTTP.
    Archived-board consistency is enforced: a seed on an archived board refuses
    every mutation (no orphan task), an archived spawned board is hidden from the
    facet but counts as settled for ready-to-resolve, and an archived `requester`
    is nulled on read with a distinct `mimir doctor` `archived-requester` warn.

- **Triage pass — `mimir triage [KEY]`** (MMR-246). An explicit-run
  reconciliation over ONE board (bare `triage` uses the bound board; `triage KEY`
  targets another), self-contained — no vault-wide scans, no cross-board
  mutation. Three checks: (a) surfaces the board's new/untriaged seeds; (b) flags
  its promoted seeds whose spawned work has all settled (ready to resolve — an
  attention signal, **never** an auto-close); and (c) over the board's OWN tasks
  whose `upstream` seed went terminal (on any board), appends an idempotent
  annotation recording the resolution (`upstream KEY-sN resolved: <reason>` /
  `rejected: <reason>`, the reason pulled from the seed's `## History`) and
  suggests unblock for a blocked task. It **writes the check-(c) annotations by
  default** (running it is the intent) but **never transitions anything** —
  unblock/resolve stay operator suggestions; `--dry-run` previews with no writes.
  The annotation marker is machine-recognizable, so a re-run recognizes its own
  work and is a no-op (idempotent for serial re-runs; concurrent passes over one
  board can duplicate, so the pass is single-writer per board). Check (c) skips
  already-settled (`done`/`abandoned`) requester tasks (annotating them would
  re-activate their attention recency), and isolates each task: a per-task read
  fault or a corrupt `## Annotations` anchor (surfaced via the MMR-239
  section-resolution seam, pointing at `mimir doctor`) is recorded in the report's
  `failures` section and skipped rather than aborting the whole pass. A report,
  never a gate — it always exits 0. Surfaced on the CLI and MCP (`triage`, 1:1);
  the report is operator/agent-facing (the console's triage surface is the seeds
  queue UI, MMR-247), so HTTP is out of scope for the pass itself.

- **Seeds — the grooming-queue entity** (MMR-244, ADR 0020). A seed is a record
  filed against a project that implies no work, only triage (`idea`/`bug`/
  `feature`), with its own `KEY-sN` id grammar and a small lifecycle
  (`new → promoted | resolved | rejected`; `promoted → resolved | rejected`,
  terminal states set only by explicit verbs). It is the artifact model's sibling
  — project-anchored, **not** a tree node — living at `KEY/seeds/KEY-sN.md` as a
  markdown doc (`## Seed Description` + `## History` + `## Annotations`) the Norn
  vault owns; a `Store.seeds` seam parallels `Store.artifacts` (**Norn-backed
  only** — the retiring SQLite backend throws). Tasks gain a nullable `upstream`
  field holding a seed id (the requester-side pointer). The shared validator
  covers all of it — a foreign seed `kind`/`lifecycle` drops the record, an
  orphaned seed is dropped, a malformed task `upstream` is nulled on read, and
  an unknown `requester`, dangling `spawned`, or dangling `upstream` is
  surfaced for repair by `mimir doctor` (referential resolution lands with the
  verb surface). The verb surface (CLI/MCP/HTTP) and triage pass follow in
  MMR-245/246.

- **Dev builds refuse to manage the real launchd** (MMR-147). Every
  supervisor-mutating verb — `service install/uninstall/start/stop/restart`,
  `setup --install-service/--install-snapshot`, and self-update's daemon
  restart — now requires a production build; a dev/from-source invocation
  fails loudly instead of writing `~/Library/LaunchAgents` or driving
  `launchctl`, so a smoke or dev run can never clobber the installed daemon's
  unit by accident (it had, three times). `service status` stays open
  (read-only), and `MIMIR_ALLOW_REAL_SERVICE=1` is the explicit opt-in for
  deliberately managing the real supervisor from source.

- **`mimir doctor` surfaces unreadable body sections** (MMR-239). Native section
  reads (`vault.get { section }`) warn-and-omit a `## History`/`## Annotations`
  heading norn cannot resolve — a hand-edited duplicate (ambiguous) or a missing
  heading — so the transitions feed and the history/annotations facets read that
  section as empty, silently (ADR 0017 graceful degradation). Doctor now reports
  each such document (`error`), reading norn's own `section_failures` channel so
  the check cannot drift from what the reader actually sees. Each record-bearing
  heading is queried on its own so a failure isolates to one section; a
  per-document corruption, so it honors `-s`.
- **`mimir doctor` flags a stem-vs-`project` divergence** (MMR-231). A document
  whose `project` frontmatter is present but points at a different valid key than
  its own `KEY-seq` stem misfiles under scope — it falls out of
  `mimir doctor -s <its real key>` and into `-s <the wrong key>`. The reader
  ignores the field (it derives project from the stem) and norn's required-field
  validate catches only a *missing* project, so nothing surfaced a present-but-wrong
  one. A whole-vault `warn` (a scoped read structurally cannot see the misfiled doc).
- **Work-state documents carry a required `project` frontmatter field** (MMR-170,
  ADR 0016 refinement). Every node and project document now records its owning
  project as a `project` wikilink (`[[KEY]]`, self-referential on the project
  doc), mirroring the artifact seam — so Norn's frontmatter-only `vault.find` can
  scope work-state docs by project (`--eq project:KEY`), which the stem alone
  could not. Declared `project: wikilink` and **required** in the node/project
  schema rules (`VAULT_SCHEMA` 2 → 3): a scope query is only trustworthy if every
  in-scope document answers it, and the self-referential value is what makes the
  project document itself findable. The schema upgrade **backfills** the field
  onto existing documents (the value derived from each document's stem, never its
  path) before the marker advances, so a crash mid-upgrade retries; the reader
  still derives a node's project from its stem and ignores the field for
  correctness, so it is not a second source of truth. `mimir doctor -s <KEY>` now
  pushes the scope into the vault query instead of reading the whole vault and
  filtering in memory.
- **Open-ended containers** (MMR-204, ADR 0001/0008 refinement). A stored
  container-only boolean `open_ended` (phase/initiative) marks a purposefully
  standing home (Bugs, Polish, Ideas) that is filed against continuously and
  never rolls up to done. A derivation change, not a transition: an open-ended
  container never reduces to `done`/`abandoned` — idle or empty it reads `ready`
  ("open for filing"); when idle it drops out of its parent's rollup entirely, so
  a standing phase never strands a normal ancestor from auto-closing; the
  `orphaned` verdict is muted for tasks inside it. Authored with `create
  --open-ended` and toggled with `update --open-ended` / `--not-open-ended`
  (container-only; MCP `openEnded` and HTTP `open_ended` mirror it). Surfaced on
  reads (`open_ended` bare field) and as an "∞ open-ended" badge in the console.
  A foreign frontmatter value nulls the field on read and is reported by `mimir
  doctor` (MMR-177 tiering).
- **`mimir doctor` frontmatter parse-failed + untyped check** (MMR-191, ADR
  0017). A work-state document whose frontmatter fails to parse (YAML error,
  merge-conflict marker, truncation) or has a missing/foreign `type` is invisible
  to every reader and every other check — they all enumerate the vault by `type:`,
  so such a doc never appears. The new check reads norn's own `vault.validate`
  (the only pass that sees a doc by path, not type) and surfaces those documents,
  scoped to the three work-state path layouts (node `KEY/KEY-seq.md`, project
  `KEY/KEY.md`, artifact `KEY/artifacts/KEY-aN.md`). Informational severity,
  non-gating (doctor still exits 0); honors `-s`; a no-op on the SQLite backend.
- **`mimir doctor` CRLF hygiene check** (MMR-176, ADR 0016 Phase 3). A fourth
  diagnostic: it reports a document body whose lines end in CRLF (`\r\n`). Since
  the codec reads canonical-LF (MMR-167), CRLF is cosmetic — it reads fine — so
  this is a `warn` (surfaced, never gating), carrying the count of CRLF endings.
  Per-document, so it honors `-s`, like the body-section check.
- **`mimir doctor` node → missing-project check** (MMR-178, ADR 0016 Phase 3). A
  third diagnostic: it reports any node whose owning project — the `KEY` of its
  `KEY-seq` stem — has no document in the vault. Like a dangling reference, the
  Norn loader throws on it, so one such node breaks the whole vault load; the
  check is `error`, whole-vault, and vault-only (SQLite's `project_id` FK
  precludes it). Both referential checks now resolve against one raw
  `readVaultGraph` read of the vault below the loader (a single `find`), rather
  than a scan each.
- **`mimir doctor` dangling-reference check** (MMR-169, ADR 0016 Phase 3). A
  second diagnostic: it reports any node whose `parent` (a `KEY-seq`) or
  `depends_on` stem resolves to no node in the vault. A dangling reference is one
  cause of a vault that will not load — the Norn working-set loader throws on the
  *first* such reference, so a single orphan breaks every command and the loader
  names only one; doctor reads the raw references below the loader and enumerates
  them all. Always an `error` (the vault is unreadable until fixed), and
  whole-vault regardless of `-s` (the failure is global). Vault-only, like the
  body-section check — SQLite's `parent_id` foreign key precludes a dangling
  parent. (Scoped to unresolved parent/prerequisite stems; other load-breakers —
  cycles, a missing project — are separate checks.)
- **`mimir doctor` — vault diagnostics** (MMR-166, ADR 0016 Phase 3). A new
  command that runs a check registry over the vault and reports problems for a
  human to fix. Findings are severity-tiered: an **error** is a record the reader
  drops (a lost transition) and gates with a nonzero exit so it can gate a
  cutover; a **warn** is a heading-shaped line the reader still reads as content
  (preserved, but it looks like an intended record) — surfaced, non-gating.
  `--format json` emits a pretty findings array, `jsonl` one finding per line.
  The first check is **body-section record integrity**: it scans each
  node/project body for the malformed `## History` / `## Annotations` records the
  read path tolerate-and-skips (MMR-161) — an unknown transition kind, a missing
  or unparseable edge line, or a non-ISO annotation heading — which the writer's
  escaping never produces, so a hand edit is the only source. Scoped by `-s`
  (default: the `.mimir.toml` binding; `all` = every project). A no-op on the
  SQLite backend, where typed rows carry no malformable body sections — so it
  lights up at the Norn cutover.
- **Node `summary` — a short list lede** (MMR-162, ADR 0016 Refinement). A new
  optional, all-node field: a single-line summary (≤256 characters, embedded
  newlines stripped) surfaced in `list`/`next` rows and on the console board,
  distinct from the full `description` prose and authored rather than derived.
  `mimir create` / `mimir update` accept `--summary`; it is on the JSON/HTTP
  node contract and editable in the web UI.
- **`mimir migrate nodes` — the authoritative node/project migration** (MMR-155,
  ADR 0016 Phase 3) — the lossless SQLite→vault projection of work state, the
  node counterpart to `migrate artifacts`. Each project and node is written at
  its existing `KEY-seq` stem with its frontmatter preserved (`created_at`
  included — timestamps are written directly, never re-stamped), and its
  `## History` / `## Annotations` sections reconstructed from the transition and
  annotation rows. Idempotent — a re-run skips documents already present by their
  `created` + `title` fingerprint — and re-runnable against a copy (point
  `MIMIR_VAULT` at a copied vault); `--dry-run` reports the inventory without
  writing. SQLite stays the source of truth until the Phase 4 cutover.
- **`mimir setup` — the configuration wizard** (MMR-145, ADR 0016 Phase 2a) —
  one command for the first install and every later reconfiguration. It
  prefills the current answers, converges the vault at the chosen location
  (creating a fresh path, adopting an existing Mimir vault, or refusing a
  foreign non-empty directory), writes the global config, and installs or
  updates the launchd units you opt into — all idempotent, so re-running is
  safe. It installs and updates but never *removes*: declining an
  already-installed unit leaves it running and points at `mimir service
  uninstall`. Interactive at a TTY; non-interactively it takes flags
  (`--vault`, `--port`, `--install-service`, `--install-snapshot`,
  `--snapshot-interval`, `--upstream`) and requires `-y`, so a piped `mimir
  setup` never converges a vault or schedules a daemon silently. A `~/` path is
  expanded the way `serve`/`snapshot` resolve it, and off macOS the launchd
  questions are skipped (the vault + config still land). The global-config
  writer is now section-preserving — it merges over the raw file, so writing a
  `[serve] port` no longer clobbers a `[vault] path` and a malformed config is
  refused rather than silently overwritten.
- **`mimir vault snapshot` + a scheduled snapshot unit** (MMR-146, ADR 0016
  Phase 2a) — the vault's git commit cadence: periodic snapshots, not
  per-write commits. The command commits the vault's working tree when dirty
  (a clean tree is a silent no-op), then pushes; a rejected push reconciles
  with a diverged upstream via fetch + merge (not rebase — both sides
  preserved), aborting to a clean tree on conflict. It is quiet on success and
  loud (nonzero exit) only on a state needing a human — a missing vault, a
  failed commit, an unresolved conflict — and every git call is
  timeout-bounded against a hung `/Volumes` mount. Configured under
  `[vault.snapshot]` in the global config (`interval` seconds, `upstream`,
  `push`/`pull` toggles). Scheduling rides the `service` family via a unit
  selector — `mimir service <verb> [serve|snapshot|all]`. Snapshot is
  **opt-in**: `install` defaults to serve only, so the timer is set up
  deliberately with `service install snapshot` (or `install all`), while
  `uninstall` and the lifecycle verbs (`start`/`stop`/`restart`) sweep whatever
  is installed — a bare `uninstall` never orphans the timer, and a bare
  lifecycle verb never fails on a unit that was never set up. The
  snapshot unit is a `StartInterval` launchd unit (default 900s, the atlas
  precedent); `service status` reports both units.
- **Artifacts can be stored in the Norn vault** (MMR-143, ADR 0016 Phase 2a).
  A backend flag selects where artifacts live — SQLite (default) or the
  Norn-managed markdown vault. (MMR-235 later unified this into the whole-store
  selector `[store] backend` / `MIMIR_STORE_BACKEND`, keeping `[store] artifacts` /
  `MIMIR_ARTIFACT_STORE` as deprecated aliases.) Under the Norn backend
  an artifact is a real file at `KEY/artifacts/KEY-aN.md`: the stem is the id,
  frontmatter the queryable record (`title`, `project`, `anchor`, `tags`,
  `created`), the body the frozen content. All artifact operations —
  attach/get/update-title, the node and project artifact facets, the
  cross-project feed — route through a backend-neutral `ArtifactStore` seam
  keyed by external identity (`KEY-aN`), never a numeric id. Nodes stay in
  SQLite during Phase 2a, so an artifact's `anchor` is a wikilink that dangles
  in the vault but resolves cross-store in Mimir. Two intentional, documented
  deltas under the Norn backend: search (`q`) matches the title only (not
  content), and a tag carries no note. A backend-parametrized conformance
  suite holds both implementations to the same contract.
- **`mimir migrate-artifacts`** — copy existing SQLite artifacts into the Norn
  vault (MMR-144, ADR 0016 Phase 2a), the cutover step that makes the vault
  backend usable on real data. Each artifact is written at its existing
  identity, so the `KEY-aN` stem, `created` timestamp, anchor/project links,
  and tag values are all preserved; the frozen content becomes the file body.
  (A tag's *note* is dropped — vault frontmatter tags are plain, as under any
  Norn-backed tagging.) The
  run is **non-destructive** (SQLite is read-only and stays the default
  backend) and **idempotent** — an already-migrated artifact is skipped via the
  vault's create-exclusive write, so a re-run makes no duplicates. `--dry-run`
  reports what would move without writing. A cutover-only command, removed once
  the vault is the sole backend.
  — archive a project to make it and its whole subtree *go away*, reversibly.
  Archiving both **freezes** (no mutation is permitted on the project or any
  descendant — every lifecycle/hold/structure/data/create/tag/attach verb is
  rejected with a `conflict`) and **hides** (the project, its subtree, and its
  artifacts drop out of every default read — `next`, `list`, `tree`, `get`,
  `status`, and the Overview / `GET /api/projects`; `get`/`status`/`tree` on an
  archived target read as `not_found`). The sole opt-in is **`mimir list
  --status archived`**, which lists the archived projects (the door for
  recovery). `unarchive` reverses both; both transitions are reason-bearing and
  logged. Archive/unarchive and the door are available on every transport — CLI,
  HTTP (`POST /api/projects/:key/archive`|`/unarchive`,
  `GET /api/projects?status=archived`), and MCP (`archive`/`unarchive` tools,
  `list` with `status: "archived"`); the project resource carries `archived_at`.
  Schema: `project.archived_at`, and the `transition_log` generalizes from
  node-keyed to entity-keyed (a nullable `project_id`, XOR with `node_id`,
  `kind` gains `archive`).

- **Archiving a project releases the live work that depended on it** (MMR-124,
  ADR 0015 Refinement). A node in an archived project now counts as *settled*
  for dependency gating — the same release an `abandoned` prerequisite triggers
  — so a task in another project that depended into it stops `awaiting` and
  becomes `ready`, instead of stalling forever on a frozen, hidden prerequisite.
  The edge is preserved (derived live), so `unarchive` re-gates it. `archive`
  warns, naming the out-of-project dependents it released
  (`released N dependent(s): …`).

- **Per-command help: `mimir <cmd> -h` / `--help`** (MMR-118). Each verb now
  prints its own usage, arguments, and flags instead of the generic top-level
  help — so a forgotten flag is recoverable in-CLI rather than by grepping the
  source. The two tiers follow the output contract: `-h` is terse (usage +
  args + flags), `--help` adds worked examples. `create <type> --help` (e.g.
  `create task --help`) shows that type's own flags; a verb without a dedicated
  descriptor falls back to the top-level help.

- **Vault bootstrap groundwork** (MMR-142, ADR 0016 Phase 2a + Refinement).
  The Norn-vault foundation, not yet reachable from any command — the Norn
  backend work wires it in. Vault path resolution mirrors `MIMIR_DB`
  (`MIMIR_VAULT` env > `[vault] path` in the global config > the
  build-profile default: `$XDG_DATA_HOME/mimir/vault` in production, the
  repo-local `.dev/vault` from source). Bootstrap is one idempotent
  convergence with three outcomes: **created** (empty/absent dir — scaffold
  the `.mimir-vault.toml` identity marker + generated `.norn/config.yaml`
  rules, `git init`, initial commit), **converged** (recognized vault —
  regenerate drifted rules, bump an older schema forward, re-init missing
  git; no-op when current), **refused** (a non-empty non-vault directory is
  never adopted; a marker schema newer than the binary is the downgrade
  guard). Mount-safety: only the derived default path may auto-create — an
  explicitly configured path that is absent is a fail-fast error, so a
  daemon on a late-mounted volume retries instead of scaffolding a fresh
  vault at the mountpoint.

- **Persistent Norn MCP client** (MMR-141, ADR 0016 Phase 2a). The transport
  half of the Norn backend, not yet wired to any command: one `norn mcp`
  subprocess per vault over stdio (lazy spawn, warm cache), with tool calls
  **serialized structurally** (norn's await-each-response contract enforced
  by an internal queue, so mutation ordering holds by construction). A died
  subprocess is respawned lazily on the next call; an in-flight death
  retries a read once transparently but **never replays a mutation** (an
  ambiguous `confirm: true` failure must not double-apply). Typed wrappers
  cover the tools the artifact path drives (`find`/`count`/`get`/`new`/
  `set`/`edit`/`validate`/`describe`), unwrapping `structuredContent` and
  raising norn `isError` results as typed validation errors. Verified
  against a live `norn mcp` (v0.41.0): dry-run-by-default mutations,
  create→find→get round-trip, and stored-wikilink field matching.

- **Meridian design-system foundation for the console** (MMR-219). The operator
  console (`packages/ui`) is re-based on the Meridian token system: the `@theme`
  block is remapped hex-for-hex in both themes to flat wells (the body grid +
  vignette atmosphere is gone — depth is carried by tone and hairlines alone),
  paired status tokens (`--color-status-<word>` + `-foreground`) across the
  closed nine-word vocabulary, and new `action`, `attention`/`attention-solid`,
  `accent-foreground`, `ink-ghost`, and `well-recessed` roles. The type base
  drops to `100%` so a semantic rem scale (`--text-page` → `--text-micro`)
  renders spec-true px at the 16px browser default; the legacy `--text-3xs/2xs/md`
  steps and the `--color-well-700` step are retired and their call sites
  re-classed. Instrument Sans (self-hosted) replaces Archivo. A CVA primitive kit
  lands in `components/ui` — status chips (the wash + inset-ring idiom, nine
  literal variants), `StatusDot`, `ActionButton` (action / attention / outline),
  `SegmentedControl`, and `Card` (recessed + status-left-border variants, a
  light-only lift) — with status-chip treatments moved out of the `lib/status.ts`
  string soup into the variants. Loading skeletons are now static recessed blocks
  (off the motion budget). A dev-only `/kit` showcase renders the whole
  foundation over both themes for regression-at-a-glance; it is gated on
  `import.meta.env.DEV` and dropped from the production bundle.

### Changed

- **Body-section reads go through native `norn get --section`** (MMR-187, NRN-102/
  NRN-173). The Norn read path — a node's `## Task Description` / `## History` /
  `## Annotations` facets and the cross-node transitions feed — now asks norn for
  the exact sections via `vault.get { section }`, instead of fetching the whole
  `.body` and slicing it client-side. Section boundaries are norn's (the same
  semantics a section *write* uses), so a read mirrors a write by construction and
  the client-side slicer is retired. Behavior-preserving; no change to facet
  output. (The `mimir doctor` body-section lint still reads the whole body — it
  reports whole-document line numbers across sections.)
- **Node write path adopts norn 0.45 structured-apply capabilities** (MMR-199,
  MMR-201; ADR 0016/0018). `vault.apply { parents: true }` (NRN-174) now mints a
  new project's `KEY/` directory during the create, retiring the pre-apply local
  `mkdirSync` — Mimir issues **no direct filesystem writes**, so the ADR 0018
  invariant (Mimir talks only to Norn) holds with no exception, and the stray
  empty directory a failed-validation plan used to leave behind is gone. The
  create-sequence resolution now reads each report op's structured `op_id` and
  resolved `stem` fields (NRN-175) instead of regex-parsing norn's human summary
  text, so a reworded summary can no longer break id allocation; a create that
  cannot resolve an applied stem still fails the whole transact rather than
  leaking a provisional id. Create semantics are unchanged; the one behavioral
  difference is that a create whose plan fails validation no longer leaves an
  empty `KEY/` directory behind.
- **CLI guess-tolerance: `--col` CSV, `--size` prefixes, clearer column errors**
  (MMR-212, mined from a real-session corpus). `--col` now accepts a
  comma-separated list (`--col history,annotations`) in addition to the repeated
  form — previously the whole `"history,annotations"` string was tested as one
  column and rejected. `--size` now accepts any unambiguous prefix
  (`--size m` → `medium`, `s`/`l` likewise), honoring the `--size <s|m|l>` the
  help already advertised. And naming a base (always-shown) column — the
  21-occurrence `--col id,type,status` miss, which treats `--col` as a projection
  — now gets a tailored hint (`--col adds optional columns; 'id' is always shown`)
  instead of a bare `unknown column`. (Per-command help — the third item mined —
  already shipped in MMR-211.)
  The store composition root now switches nodes *and* artifacts together behind a single
  `[store] backend = "sqlite" | "norn"` key (env override `MIMIR_STORE_BACKEND`), replacing
  the transitional artifact-only `[store] artifacts` key / `MIMIR_ARTIFACT_STORE`. The Norn
  branch returns the complete Norn store (`createNornWriteStore` — nodes, artifacts, body
  sections, transitions), so the node backend is no longer pinned to SQLite; the retired
  artifact-only `withArtifactStore` shim is removed. **The default is unchanged (`sqlite`)** —
  this only makes the Norn node backend selectable; the cutover flip is a separate step
  (MMR-232). The old `[store] artifacts` key and `MIMIR_ARTIFACT_STORE` env are honored as
  deprecated aliases for one release, so an existing config never silently falls back to the
  sqlite default; both are removed at the cutover.
- **Adopt norn 0.45: the `vault.apply` tool rename and its in-band refusal signal**
  (MMR-207, subsumes MMR-202). norn 0.45 renames the MCP plan-apply tool
  `vault.apply_plan` → `vault.apply` (NRN-185) and, more consequentially, reports a
  precondition refusal (a CAS drift) **in-band** — `isError: false`, a report whose
  `outcome` is `refused`/`failed` with a structured `error.code` — instead of the
  pre-0.45 thrown MCP error. The node write path's optimistic-concurrency retry
  therefore no longer detects drift by catching a throw and prose-matching
  `stale repair plan for`; it classifies the returned report by `outcome`, replaying
  only a `refused` whose failed ops all carry a CAS-drift code
  (`expected-old-value-mismatch` / `stale-document-hash`), and treating any other
  refusal or a partial `failed` apply as terminal (never a blind replay). Without
  this, a lost update under 0.45 would be silently swallowed as success with nothing
  written. Same-commit with the binary adoption; live parity verified against norn
  0.45. Restart any persistent `norn mcp` client after upgrading (tool contract +
  cache schema change). A norn-side follow-up to also set `isError` on a not-applied
  outcome is tracked upstream.
- **Dependency bumps** (dependabot reconcile). `vite` 8.0.16→8.1.3, `tailwindcss`
  and `@tailwindcss/vite` 4.3.0→4.3.2, `@tanstack/react-router` 1.170.15→1.170.17,
  and the `actions/checkout` CI action v6→v7. The `vite` bump moved the root
  `dependencies` pin and the workspace `overrides` pin together (both were pinning
  the resolution), so the whole workspace still resolves a single vite. Lint,
  format, and type check, the bin/helpers and UI test suites, and the UI production
  build all pass on the new versions. (The `oxlint` 1.70→1.72 bump is held back — it
  enables new `node/no-sync` and `unicorn/max-nested-calls` rules that fire 235× on
  the existing tree; that is a lint-policy decision, tracked separately.)
- **The Norn transitions feed excludes validator-dropped nodes** (MMR-189, ADR
  0017). The cross-node feed fanned `## History` out of every parseable-stem
  document, so a node the working-set reader drops (missing project, invalid
  `lifecycle`/`hold`, absent/unparseable frontmatter) still surfaced its
  transitions — diverging from the FK-backed SQLite feed and violating the
  show-correctly-or-drop bar. The feed now classifies a document against the
  shared validator's survivor set (`validate(vaultGraphFromDocs(docs))`), derived
  from the feed's own single vault read, so a node's transitions appear iff the
  reader shows the node. A cycle drop is edge-only — the node survives, so its
  transitions still appear. No effect on the SQLite backend.
- **`mimir doctor` is a non-gating diagnostic; the referential checks share one
  validator pass** (MMR-182, ADR 0017). Doctor now always exits `0` on a
  successful run regardless of findings — surfacing issues _is_ its job — so a
  nonzero exit is reserved for doctor itself failing (the vault read throws). The
  per-finding `error`/`warn` severity becomes an informational triage label, no
  longer an exit gate (superseding the MMR-166 behavior where an `error` gated
  with exit 1). Internally, the four checks that render the validator's `dropped[]`
  (dangling references, missing project, acyclicity, field validity) now read one
  shared `validate()` result the command computes once, instead of each recomputing
  a whole validator pass. No effect on the SQLite backend (doctor no-ops there).
- **The shared validator vets node fields; the reader tolerates malformed ones**
  (MMR-177, ADR 0017). `validate()` gains a field-validity pass, tiered by whether
  a field is load-bearing: a task whose `lifecycle` is missing or foreign, or whose
  `hold` is a foreign value, is **dropped** (the field drives status derivation, so
  there is no truthful way to show the node) — like a missing container, it hides
  and its inbound edges cascade; a foreign `priority`/`size` drops only the
  **field** (null is a truthful "unset") and the node survives. So `loadNornSnapshot`
  no longer throws on any field-level corruption — the last reader throw class is
  retired — and `mimir doctor` reports every dropped node and field. The tiering
  rule lives only in the validator; the reader nulls a foreign `priority`/`size`
  over the same `@mimir/contract` vocabulary. A field-clean vault is unaffected
  (byte-identical to SQLite). No effect on the SQLite backend.
- **The shared validator breaks relational cycles; the reader tolerates them**
  (MMR-174, ADR 0017). `validate()` gains an acyclicity rule: it detects `parent`
  and `depends_on` cycles (the two relations independently) over the surviving
  subgraph and drops each cycle's closing (back) edge — the one found by a DFS in
  the loader's canonical `(key, seq)` order — yielding a DAG. A dropped
  `cycle-parent` edge floats the node to its project root; a dropped
  `cycle-depends-on` edge is pruned. A self-dependency is the degenerate length-1
  cycle, so the Norn reader no longer throws on it (`loadNornSnapshot`): a cyclic
  hand edit degrades the read to a valid acyclic subgraph instead of a wrong or
  failed load. `mimir doctor` reports every dropped cycle edge. A cycle-free vault
  is unaffected (byte-identical to SQLite). No effect on the SQLite backend.
- **The Norn vault reader is data-tolerant of referential corruption** (MMR-181,
  ADR 0017). `loadNornSnapshot` now routes the raw relational graph through the
  shared validator and builds only over the valid subgraph, so a dangling
  `parent`/`depends_on` or a node whose project has no document degrades the read
  to a valid closed subgraph — the edge is dropped (a dangling parent floats the
  node to its project root) or the node is hidden — instead of throwing and taking
  the whole load down. A clean vault drops nothing and stays byte-identical to
  SQLite (proven by the backend-parity harness). Field-level corruption (a task
  missing its `lifecycle`, a foreign enum value) and a self-dependency still throw
  loud, pending their own validator rules (MMR-177, MMR-174); until those land the
  reader is tolerant of referential corruption only. No effect on the SQLite
  backend, which remains the active read path until the Phase-4 cutover.
- **`mimir doctor`'s referential checks derive from one shared validator**
  (MMR-180, ADR 0017). A new `validate(rawGraph) → { valid subgraph, dropped[] }`
  module is the single source of truth for what is invalid in a Norn-backed
  vault: it drops nodes whose owning project is absent (missing container) and
  edges whose `parent`/`depends_on` resolves to no *surviving* node (dangling).
  The dangling-reference (MMR-169) and missing-project (MMR-178) checks are now
  thin adapters that render its drops, so there is exactly one detector — the
  tolerant reader (forthcoming) will drop the same edges doctor reports, with no
  risk of drift. Resolving edges against the *surviving* set (not the raw set)
  makes the cascade correct: a `depends_on`/`parent` pointing at a node hidden by
  a missing project is now itself reported as dangling — a case the two separate
  detectors could not see. No change on the SQLite backend (doctor no-ops there).
- **The core is the sole stamper of a transition's `at` and an annotation's
  `created_at`** (MMR-173, ADR 0016 Phase 3). These two timestamps were the last
  the SQLite backend left to its column default (its own DB clock) while the Norn
  backend stamped them in the write path; the mutation layer now stamps both
  through the single `now()` clock, so the two backends persist an identical
  value for a transition's `at` and an annotation's `created_at`. (Node/project
  creation timestamps still take the SQLite column default — a separate, known
  backend divergence the conformance harness normalizes.) Format and precision
  are unchanged (ISO-8601, UTC, millisecond). This closes the last divergence
  blocking body-section **write** parity, so
  the A/B conformance harness now diffs `## History` / `## Annotations` /
  `## Task Description` after every write verb across both backends.
- **The cross-node transition feed is a backend-neutral seam; the last SQLite
  read-path dependency is gone** (MMR-160, ADR 0016 Phase 3). `GET
  /api/transitions` now routes through a `TransitionsFeed` seam — the SQLite
  backend reads the append-only `transition_log` (unchanged behavior), the Norn
  backend fans every node/project `## History` section out of the vault and
  merges them into one chronologically ordered stream. Every transport's token
  resolution and write-echo moves off the raw `db` executor onto the working-set
  snapshot both backends produce, and the transitional `store.db` member leaves
  the `Store` interface entirely. The production SQLite path is unchanged; this
  is the groundwork that lets the Norn backend become selectable at cutover.
- **Node `description` is body-authoritative** (MMR-162, ADR 0016 Refinement).
  The full prose now lives only in the `## Task Description` body section — read
  on a detail `get` (as the `description` facet) and no longer carried in bulk
  `list`/`next` rows, and no longer a frontmatter field. This preserves
  paragraph breaks that frontmatter YAML serialization dropped and spares bulk
  views the cost of reading prose; the short `summary` (above) is the new list
  lede. Existing stores migrate losslessly via `mimir migrate nodes`.
- **Per-node body-section facets read through a backend-neutral seam** (MMR-154,
  ADR 0016 Phase 3). A node's `## History` and `## Annotations` facets now route
  through a `BodySectionStore` seam — the SQLite backend reads the
  `transition_log` / `annotation` tables (unchanged behavior), the Norn backend
  slices the sections out of the document body and parses them through the shared
  record codec. `annotate` gains a real Norn write path (`append_to_section`),
  and the codec is extended to the `## Annotations` record grammar. Groundwork
  for the vault backend; the production SQLite path is unchanged.
- **Migration commands unified under `mimir migrate <sub>`** (MMR-159). The
  schema migrator moves from `mimir migrate [status]` to `mimir migrate schema
  [status]`, and the artifact cutover from `mimir migrate-artifacts` to `mimir
  migrate artifacts` — both behave exactly as before, only the invocation
  changed. A bare `mimir migrate` now lists the subcommands. This is a namespace
  for forthcoming migrations (the authoritative node/project migration lands
  here as `migrate nodes`).
- **`next` and `list` order across projects by project key, not creation order**
  (MMR-151). Cross-project ordering previously keyed on an internal surrogate id
  (effectively the order projects were created); it now keys on the project key,
  so ordering is deterministic and stable. Only unscoped, multi-project `next`/
  `list` output is affected — a single project, or a `--scope`d query, is
  unchanged. (Surfaced by the Phase 2b read-path parity harness, which requires
  identical output across storage backends.)
- **Vault schema bumped to 2 — node/project rules** (MMR-149, ADR 0016 Phase
  2b). The generated `.norn/config.yaml` now carries validation rules for
  `project` and the node types (`task`/`phase`/`initiative`) alongside the
  artifact rule; an existing vault regenerates its rules through the converge
  upgrade path on next open. Groundwork for reading node work-state from the
  vault — the Norn node read path (`loadWorkingSetOverNorn`) lands behind the
  test harness and is not yet wired into any runtime backend selection.
- **Read-path facets derive from the working-set snapshot** (MMR-148, ADR 0016
  Phase 2b) — `get`/`tree`/`status` facet assembly, project tags, and
  `KEY-seq` token resolution now project off the same in-memory working set as
  status derivation instead of firing per-read SQLite queries, and that
  snapshot loads inside one read transaction for a consistent view. Behavior-
  preserving, with one visible refinement: tag lists (`--col tags`) now render
  in a stable order — `created_at`, then tag name — so tags stamped in the same
  instant no longer sort arbitrarily.
- **`mimir service status` / lifecycle JSON envelopes are now multi-unit**
  (MMR-146). With serve and snapshot both managed under `service`, the
  structured output carries a unit array rather than a single daemon's fields:
  `service status --format json` emits `{ config, recent_events, units: [...] }`
  (per-unit `loaded`/`running`/`pid`/`plist`/`log`, plus serve's
  `port`/`health` and snapshot's `interval_seconds`), and `service <verb>
  --format json` emits `{ actions: [...] }` (one entry per unit acted on). A
  script that read the old top-level `service status` fields must reach into
  `units[]`.
- **Status derivation is computed in-memory over one snapshot** (MMR-133/134,
  ADR 0016 Phase 0). Every read view — `next`, `list`, `get`, `status`, `tree`,
  and the Overview — now loads the work state as one bulk projection and
  derives status words, rollups, and predicates in memory, instead of firing a
  cascade of per-node queries. A scoped `list --status all` drops from ~1,200
  queries to 4; a whole project tree is 5; the full Overview is 15. Output is
  unchanged (verified byte-identical against the previous binary across the
  read surface). One pathological shape improves: a derivation cycle closed
  through container dependencies — which previously hung forever — now fails
  fast with a diagnosable `invariant` error.

- **A dependency on a container now gates its descendant tasks.** A task's
  effective prerequisites are its own edges plus any inherited from an ancestor
  (phase/initiative/project), so a descendant reads `awaiting` — and drops out
  of `ready`/`next` — until the prerequisite settles. Previously a
  container-level edge only marked the prerequisite `blocking` and gated nothing
  on the dependent side. The gate is advisory (a manual `start` is still
  allowed) and todo-only (an already-started descendant is unaffected). The
  `deps` facet gains `awaitingOn` (wire `awaiting_on`) — the unsettled effective
  prerequisites, each tagged with the ancestor it is inherited `via` — and the
  CLI record + console drawer show an "awaiting on … (via …)" line. `depend`
  and `move` now reject a configuration that would put a dependency edge in an
  ancestor/descendant lineage (inheritance would otherwise deadlock it). See
  ADR 0001 (Refinement).
- **HTTP and MCP now validate `priority`/`size` against the allowed values**
  instead of casting raw request input — an invalid value returns a graceful
  validation error rather than reaching the store.
- **Adopted `@dbtlr/tooling`** (shared Vite+ lint/format/type config) and added a
  dependency-free **`@mimir/helpers`** package (typed `parseJson` + `isMember`).
  The strict ruleset is enabled; conformance is largely complete, with a few
  rules still disabled pending follow-up (react-perf, `no-await-in-loop`, and
  per-response API-client schema validation).
- **Renamed the Overview's project classifier from "attention band" to `Lane`.**
  The classifier borrowed the top-bar alert's word; the four highest-wins
  standings a project resolves to are now **Lanes**, and **Attention** names the
  top-bar alert only. Lane values (`awaiting_you`/`live`/`needs_unsticking`/
  `at_rest`) and the going-cold modifier are unchanged. The projects read facet's
  field is renamed on the wire: `attention.band` → `attention.lane`.
- **The attention alert surfaces stale-only items as "going cold"** instead of
  their status word. A stale `in_progress`/`ready` task pulled into the alert by
  the stale arm showed a misleading healthy status dot; it now reads as a
  going-cold nudge (the alert still keeps it — a rotted started task needs you).
- **Running from source now targets an isolated dev store and port, never
  production** (MMR-117). `bun run mimir …` and tests default to a gitignored,
  repo-local `.dev/mimir.db` on port **64747**, so a from-source run can no
  longer read or mutate the installed daemon's work-state or collide with its
  port (both previously resolved the same `~/.local/share/mimir/mimir.db` and
  64647 — a from-source `serve` alongside the daemon spun on the shared SQLite
  lock and hung). A build profile drives the default: release binaries bake
  `MIMIR_BUILD_PROFILE=production` via `bun build --define` (the same idiom as
  the version stamp) to target the user-global store and port 64647; an
  uncompiled run stays in dev. Production defaults and the `MIMIR_DB` override
  are unchanged, and `serve` gains a `MIMIR_PORT` env override (precedence:
  `--port` > `MIMIR_PORT` > config > default) mirroring `MIMIR_DB`.

### Fixed

- **The write path no longer silently erases a pruned dangling `depends_on`**
  (MMR-186, ADR 0017). The data-tolerant reader drops a dangling or cycle-broken
  `depends_on` edge on load, so the in-memory working set omits it; a later
  `transact` that rewrote `depends_on` regenerated the field from survivors alone
  and, because the compare-and-set baseline was taken from the raw on-disk value,
  quietly deleted the ref from the document — auto-repairing corruption that
  `mimir doctor` is meant to keep surfacing, with no `## History` audit. The
  write path now re-merges the validator's pruned `depends_on` refs into the
  rewritten field, so the reference survives the write and `doctor` keeps
  reporting it. Preservation only — repair stays the deliberate `doctor --fix`
  decision (MMR-183). A `parent` edge is unaffected: it is single-valued and only
  a `move_node` rewrites it, so the overwrite is the operator's explicit intent.
- **`mimir doctor` no longer false-cleans a section whose heading has trailing
  whitespace** (MMR-171). The body-section scan located a `## History`/
  `## Annotations` section with an exact match, missing a heading carrying trailing
  spaces or tabs (`## History `) — silently skipping the malformed-record scan for a
  section norn's native resolver reads fine. The anchor now tolerates trailing
  whitespace (exact-equality, so `## History Extra` is still a different section);
  CRLF was already handled (MMR-167), and duplicate/shadowed headings are reported
  by the new section-resolution check (MMR-239). A guard (MMR-209) also makes the
  doctor drop→check partition total, so a new validator drop rule is a compile error
  until it is routed to a check rather than silently rendering in none.
- **Web UI restored on the Norn backend** (MMR-233, ADR 0016/0018). Post-cutover,
  the pinned SQLite-era `serve` binary busy-spun at 100% CPU on the live store and
  the UI was down by choice (MMR-147 occurrence). The `serve` launchd unit now
  bakes the resolved **absolute** `norn` binary path as `MIMIR_NORN` at
  `service install` time, with an install-time preflight that fails loudly when
  `norn` is not on `PATH`. launchd hands the daemon only a minimal `PATH` with no
  `~`/`$VAR` expansion, and the daemon shells out to `norn` (ADR 0018), so a bare
  `norn` would install a unit that boots green and then fails every request;
  baking the absolute makes the daemon hermetic. An **explicit** `[vault] path`
  (env or config) is likewise required to exist and baked as `MIMIR_VAULT`; the
  **auto-creatable default** vault is deliberately left unbaked so the daemon's
  first-boot `converge` still materializes it (baking it would flip
  `resolveVault`'s `allowCreate` off and strand a fresh install). The SQLite
  backend still carries only `MIMIR_DB`. Verified end-to-end: the console loads,
  reads live work-state from the Norn vault, and idles at 0% CPU.
- **`service install` no longer loses the launchd bootstrap race** (MMR-233).
  `install` boots out any loaded unit before bootstrapping the refreshed plist,
  but `launchctl bootout` returns before launchd has finished the teardown, so the
  immediate `bootstrap` intermittently failed with error 5 ("Input/output error")
  and left nothing loaded. Bootstrap now retries a bounded number of times on
  exactly that race code, waiting for the teardown to settle between attempts; any
  other exit surfaces at once, and a race that outlives the budget still surfaces
  as the usual load error. `service start` shares the retry (a `stop`→`start` hits
  the same race).
- **Node write path replays a concurrent-write drift again under norn 0.45.1**
  (MMR-237). norn 0.45.1 (NRN-219) flipped a not-applied `vault.apply` to
  `isError: true` while preserving the structured report — but MMR-207's drift
  handling was written for 0.45.0's `isError: false`, so the client threw the report
  away on `isError` and a CAS drift became a hard failure instead of a transparent
  reload-and-replay (invisible to the suite, which only exercised the happy path).
  `applyPlan` now tolerates the `isError` signal and returns the structured report for
  the write path to classify by `outcome` (a genuine tool error carrying no report
  still throws), restoring the optimistic-concurrency retry. Guarded by a live
  integration test that drives a real CAS refusal against the installed norn.
- **Node migration re-run stays idempotent across CRLF line endings** (MMR-172,
  ADR 0016 Phase 3). `migrate nodes` judged whether a doc was already migrated by
  a raw byte compare of the on-disk body against the freshly reconstructed one,
  trimming only the trailing edge. A prior migration's doc re-saved with CRLF (a
  Windows editor, git `autocrlf`) kept interior `\r`, so the compare diverged and
  the create-exclusive re-run rethrew a path-collision instead of reporting
  `skipped` — breaking the documented "re-run is idempotent" guarantee. Both
  sides are now normalized to the codec's canonical LF before comparison (the
  same MMR-167 line-ending rule the read path applies), exported as a single
  shared `toCanonicalLf` so the two can't drift.
- **Unknown verbs and flags hard-error instead of dumping help** (MMR-211). An
  unknown verb (`mimir add`, `mimir edit`) — even with `-h`/`--help` — printed the
  full top-level help and exited `0`, which an agent could read as task data and
  then act on stale context. An unknown flag exited `2` but dumped the entire
  144-line help body to stderr. Both are now a hard usage error: exit `2`, a
  concise one-line message, and a `did-you-mean` suggestion (nearest verb / flag
  by edit distance) plus a pointer to the relevant help — never the help body.
  Real verbs without a help descriptor (`service`, `skill`, `self-update`) still
  fall back to the top-level help on `-h`. `-f`/`--format` already behave
  identically (verified); a `COMMANDS` set is the single authority for what counts
  as a real verb.
- **Aliased wikilinks in relational frontmatter** (MMR-190, ADR 0017). The
  `collapse` decoder stripped a wikilink's `[[ ]]` brackets but not its `|alias`
  display segment, so `[[MMR-2|Some Title]]` decoded to the literal
  `MMR-2|Some Title`. An aliased `parent` then failed to parse and floated the
  node silently to root with no drop and no doctor finding (the "silently wrong"
  class); an aliased `depends_on` dangled with a misleading ref string. `collapse`
  now drops the alias segment and trims, so an aliased ref resolves through the
  normal valid/dangling path. Because `collapse` is the single shared decode seam,
  the fix applies uniformly to node `parent`/`depends_on` refs and artifact
  anchors. No effect on the SQLite backend.
- **CRLF line endings in body-section reads** (MMR-167, ADR 0016 Phase 3). A
  vault file saved with `\r\n` — a Windows editor, or git `autocrlf` — left a
  trailing `\r` on every line that the `$`-anchored `## History` / `## Annotations`
  record grammar never matched, so every record in that section silently vanished
  on read (and `mimir doctor` reported a false clean). Body reads now normalize
  line endings, so CRLF-saved records read back identically to LF. Pre-existing
  (not an MMR-161 regression); surfaced by the MMR-161 review.
- **Body-section reads are hardened against hand-edited vault content**
  (MMR-161, ADR 0016 Refinement). The `## History` / `## Annotations` record
  split now anchors on the record grammar — `### <at> — <kind>` for history,
  `### <ISO createdAt>` for annotations — rather than any `### ` line. A
  heading-shaped line a hand edit leaves inside a reason or annotation (Mimir's
  own writes escape these) no longer splits one record into two and silently
  sheds the orphaned tail; it stays content of its record. Reads stay tolerant
  and never throw — a malformed record is skipped, consistent with the
  frontmatter read path — and the vault-editing rules are documented in ADR
  0016. Actively reporting malformed records is deferred to a vault-lint surface
  (MMR-166).
- **`depend` and `move` reject a write that would close a derivation cycle
  through container rollups** (MMR-140). A verb-constructible shape — a task in
  initiative A depending on container C, while a task in C depends back on A —
  closes a loop that the same-lineage and raw dependency-cycle guards cannot
  see; reads on that shape failed with a diagnosable `invariant` (and, before
  the in-memory derivation, recursed forever). The verbs now simulate the
  candidate edge or re-parent over the working-set snapshot and reuse the
  runtime cycle detection to reject it up front (`validation`), so the broken
  shape can no longer be written. The guard checks only the written node
  against a before/after baseline — a cycle already present in legacy data
  never rejects an unrelated write — and treats archived projects as live, so
  a loop threaded through an archived container (dormant at read time, live
  again on unarchive) is refused at the write that would create it.

## v0.12.0 - 2026-06-28

The attention-router release. The `/` page (renamed from "fleet" to **Overview**)
becomes a cross-project attention-router, project cards show per-state vitals, and
the global alert surfaces work awaiting you — plus the **`reopen`** verb for
exiting a terminal state.

### Added

- **`reopen` — exit a terminal state (`done`/`abandoned`) → `in_progress`**
  (MMR-104). The deliberate correction path for a task closed too early: re-ranks
  at the bottom, clears `completed_at`, optional reason, append-only (the original
  terminal transition survives). Across the CLI (`mimir reopen`), MCP, HTTP
  (`POST /api/nodes/:id/reopen`), and the console (a **Reopen** action on the
  previously dead-end terminal cards).
- **The Overview page is a cross-project attention-router** (MMR-100/101/102).
  The `/` page groups every project into four highest-wins attention-bands —
  **Awaiting you** (a review awaits) → **Live** (work in motion) → **Needs
  unsticking** (blocked/awaiting) → **At rest** — recency-ordered within each,
  At-rest folded to an expandable strip. Ordered by how much your action moves
  each project. Backed by a derived `attention` facet on the projects read.
- **Project card vitals** (MMR-105/106). Each card shows the five actionable-state
  leaf counts — review · in prog · ready · await · blocked — as a proportion bar
  plus a count legend, with a **going cold** marker for stale projects. Backed by
  a new per-project `leafCounts` facet on the projects read.
- **`under_review` joins the global attention alert** (MMR-103). The top-bar
  alert now surfaces "Awaiting you" reviews alongside blocked + stale, ordered by
  how much your action moves it.

### Changed

- **The `/` page is renamed "fleet" → "Overview"** and the project card component
  `FleetCard` → `ProjectCard` (MMR-108) — the nautical metaphor never told you
  what the page was.
- **Console design-system consolidation** (MMR-107): a named type scale replaces
  scattered bespoke sizes, dark secondary-text contrast now clears WCAG AA, chip
  radii are unified, and cards are crisp opaque panels (the prior blur and
  translucency dropped).
- **The project card replaces its single ready-count hero and full distribution
  bar with the vitals panel** (MMR-106).

## v0.11.1 - 2026-06-23

A mobile legibility fast-follow to v0.11.0 (board, tree, fleet, and top-nav
menus), plus a fix for the card status-color border that had been rendering grey.

### Fixed

- **The card status-colored left edge rendered grey on every card** — a runtime
  `.replace()` built a `border-l-status-*` class Tailwind never compiled, so the
  board cards (and the switcher trigger accent) lost their status color signal.
  Now driven by literal classes. (MMR-99)

### Changed

- **Mobile legibility pass — board, tree, fleet, and top-nav menus** (MMR-99). A
  mobile-only type scale (desktop's dense scale is unchanged): board card and
  tree titles win at a readable size; the tree gains visible hierarchy connectors,
  a container/task size step, an SVG expand caret with a real tap target, two-line
  task titles, and per-row status letters; fleet cards get a status-colored left
  rule and a single ready-count hero; the project-picker and attention menus move
  to 44px touch rows with higher-contrast popups, the attention rows surface the
  block reason, and the top-bar triggers grow to a comfortable tap size.

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

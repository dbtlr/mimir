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

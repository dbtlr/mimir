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

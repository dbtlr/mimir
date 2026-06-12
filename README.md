# mimir

Mimir is the source of truth for **work state** — tasks, the work hierarchy, and
the frozen artifacts attached to them. It is the _work_ tool in a three-part
split along the founding distinction of knowledge vs. work: **Norn** keeps
knowledge, **Mimir** holds work state, **Saga** weaves them into a session.

Work state is ephemeral and fast-changing, so it lives in a structured store
(SQLite) where it is the source of truth — markdown is a _projection_, not the
store. Status rollups and dependency predicates are **derived live, never
stored** (caching them is the sync problem Mimir exists to remove). The same
core query layer serves an agent (via MCP) and a human/scripts (via a CLI).

> **Status:** **pre-release** (`0.x`). Phases 0–2 are built — the
> storage-committed core (schema, derivation, rank, mutation verbs) and the
> first read slice over both **CLI** and **MCP**. Write verbs exist in the core;
> exposing them on the transports is the next slice.

## Install

**Standalone binary** (no Bun needed on the target):

```sh
curl -fsSL https://raw.githubusercontent.com/dbtlr/mimir/main/install.sh | sh
```

Installs the binary for your platform from the latest [release](https://github.com/dbtlr/mimir/releases)
to `~/.local/bin` (override with `MIMIR_INSTALL_DIR`, pin with `MIMIR_VERSION`).

**From source** (requires [Bun](https://bun.sh) `1.3.14`):

```sh
git clone https://github.com/dbtlr/mimir && cd mimir && bun install
bun run build    # compiles dist/mimir; or `bun run mimir <verb>` straight from source
```

## Quickstart

```sh
mimir --version
mimir --help
mimir migrate        # create / migrate the database (applied automatically on first run)
```

The database lives at `$XDG_DATA_HOME/mimir/mimir.db` (default
`~/.local/share/mimir/mimir.db`), so `mimir` works from any directory; set
`MIMIR_DB` to use a per-project store instead.

Every entity has one rendered id, spoken by every surface: a project is the
bare `KEY`, a tree node is `KEY-seq` (`MMR-16`), an artifact is `KEY-aN`
(`MMR-a1`). Any id position takes the full grammar — the verb rejects what it
can't act on.

The read commands (one intent layer, rendered as CLI or MCP):

```sh
mimir next                        # ready tasks in rank order — "what's next"
mimir next --scope MMR -p p0      # filter by project / priority (signals, not sort)
mimir list --status done          # universe: status words, or live|terminal|all
mimir list --is stale             # verdicts: stale|blocking|orphaned (--not-is negates)
mimir list --eq priority:p1 --missing size --after created_at:2026-06-01
mimir get MMR                     # the whole-project view (rollup + roots)
mimir get MMR-16                  # full record for one node (KEY-seq id)
mimir get MMR-16 --col history    # add the transition log
mimir get MMR-a1 --col content    # an artifact, with its frozen body
mimir status MMR-3                # an initiative/phase rollup (distribution + status)
mimir next --format json | jq .   # structured, pipe-safe output
```

Selection is AND-composed: `--status` picks the universe, `--is`/`--not-is`
verdicts and the field operators (`--eq` `--not-eq` `--in` `--not-in` `--has`
`--missing` + date ops) filter within it. A value miss (`--eq priority:p9`)
warns and returns an empty set (exit 0); an unknown field is a usage error
(exit 2).

The write verbs:

```sh
mimir create task "wire the API" --parent MMR-2 --priority p1 --tag api
mimir start MMR-3 && mimir done MMR-3
mimir depend MMR-4 --on MMR-3     # MMR-4 waits on MMR-3
mimir tag MMR-3,MMR-a1 spec v2    # tag tasks, projects, artifacts (free-text)
mimir attach MMR-3 --file plan.md # freeze an artifact (title from basename)
```

Formats: `table` / `records` (styled TTY) and `ids` / `json` / `jsonl`
(structural, never styled). The default follows the destination — a table for a
TTY set, `ids` when piped — and `--format` overrides. Identity selection
(`get`/`status`) exits non-zero on a missing id; set selection (`next`/`list`)
exits 0 on an empty result.

Run as an MCP server for an agent:

```sh
mimir mcp     # JSON-RPC over stdio; the same read + write surface as tools
```

## The model

```
project → initiative → phase → task        (the work tree, via parent_id)
```

- **Two status axes** on tasks: `lifecycle` (todo → in_progress → done /
  abandoned) and a `hold` overlay (none / blocked / parked). Non-leaf nodes
  store **no** status — their truth is the live **distribution** over children,
  reduced to one **status word** by a canonical `interpret` cascade.
- **Rank** is a single relative order that wins over priority; priority/size are
  orthogonal _signals_ that filter and advise, never the sort.
- **Derived, never stored:** `ready`, `awaiting`, `blocked`, `blocking`,
  `stale`, `orphaned`, and every rollup.

The reasoning behind the model lives in
[`docs/decisions/`](docs/decisions/README.md) (the ADRs), with the concrete
schema in [`docs/schema-reference.md`](docs/schema-reference.md) and the
CLI/MCP output contract in
[`docs/output-contract-reference.md`](docs/output-contract-reference.md).

## Development

```sh
bun install
bun run verify    # the full gate: format, lint, typecheck, test
```

`verify` is `bun run check` (oxfmt + oxlint + type-aware typecheck, zero-warning)
plus `bun test` (the suite on in-memory SQLite) — the same gate CI enforces.
`main` is protected; changes land via PR. See
[CONTRIBUTING.md](./CONTRIBUTING.md), [CHANGELOG.md](./CHANGELOG.md), and
[SECURITY.md](./SECURITY.md).

Architecture — one core, thin transports:

```
packages/contract/   @mimir/contract — pure DTO + wire types (the dependency-free leaf; the UI imports it)
packages/bin/        @mimir/bin — the binary
  src/db/            Kysely instance, schema/migrations, the Migrator
  src/core/          storage-committed domain logic: derivation, rank, verbs, intent layer
  src/cli/           the human transport (parseArgs + styled/structured renderers)
  src/mcp/           the agent transport (official MCP SDK over stdio)
  src/http/          the UI transport (resource-shaped REST over Bun.serve)
  src/main.ts        composition root — dispatches subcommands
packages/ui/         @mimir/ui — the operator console SPA (embedded in the binary)
```

The layering `contract ← db ← core ← transports` is enforced by an oxlint
`no-restricted-imports` rule: `core` may not import a transport, `db` may not
import `core`, and the transports may not import each other or `db`.

## License

[MIT](./LICENSE)

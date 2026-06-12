# Contributing to mimir

Thanks for considering a contribution. `mimir` is the source of truth for work
state — tasks, the work hierarchy, and the artifacts attached to them.
Contributions of all sizes are welcome — bug reports, doc fixes, test additions,
and feature work.

## Getting started

Install [Bun](https://bun.sh) `1.3.14` (pinned in `.tool-versions`; `mise install`
picks it up), then:

```bash
bun install
bun run verify    # the full gate: format, lint, typecheck, test (what CI runs)
```

`verify` is `bun run check` (oxfmt + oxlint + type-aware typecheck, zero-warning)
plus `bun test` (the suite on in-memory SQLite).

## Project shape

One core, thin transports, in a Bun workspace. `packages/contract`
(`@mimir/contract`) is the dependency-free type leaf — the wire vocabulary
every consumer parses. `packages/bin` (`@mimir/bin`) is the binary: `src/db`
owns persistence; `src/core` is the storage-committed domain logic (derivation,
rank, mutation verbs, intent layer); `src/cli`, `src/mcp`, and `src/http` are
the transports; `src/main.ts` is the composition root. `packages/ui`
(`@mimir/ui`) is the operator-console SPA, embedded in the binary at build
time. Inside the binary the layering `contract ← db ← core ← transports` is
enforced by an oxlint rule — `core` may not import a transport, `db` may not
import `core`, transports may not import each other or `db`.

## Pull requests

`main` is protected: changes land via PR with a green CI check.

- Keep PRs small and focused — one logical change per PR.
- Run `bun run verify` locally before pushing. CI runs the same gate.
- If the change affects CLI/MCP behavior, output format, the schema, or
  configuration, add a `CHANGELOG.md` entry under `[Unreleased]` in the
  appropriate `Added` / `Changed` / `Removed` / `Fixed` heading
  ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/)).

## Commit messages

Conventional, plain-English commit messages. The first line is a short
imperative summary (under ~72 chars); body paragraphs explain the _why_, not the
_what_. `git log` is the best style reference.

## Releases

Releases are tag-driven. To cut one: promote `[Unreleased]` in `CHANGELOG.md` to
`## vX.Y.Z - YYYY-MM-DD`, bump `version` in `package.json` (the single source —
`mimir --version` and the MCP server read it), then push a `vX.Y.Z` tag. The
release workflow builds standalone binaries per platform and publishes a GitHub
Release with notes pulled from the changelog.

## Code of conduct

Be respectful. Assume good faith. Disagreements about design are normal;
personal attacks are not.

## Security

Security issues should not be filed as public issues. See [`SECURITY.md`](SECURITY.md).

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
  ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/)). The
  `changelog-guard` check enforces this: a PR touching build-affecting paths
  (`packages/**`, `package.json`, `bun.lock`, `install.sh`, the release
  workflows) fails CI unless it adds an `[Unreleased]` entry. For a genuinely
  behavior-preserving change (internal refactor, test- or build-meta only),
  apply the `skip-changelog` label with a one-line reason instead.

## Commit messages

Conventional, plain-English commit messages. The first line is a short
imperative summary (under ~72 chars); body paragraphs explain the _why_, not the
_what_. `git log` is the best style reference.

## Releases

Releases are tag-driven, and the binary reports the exact tag it was built from
(`--version` is injected at compile time; `packages/bin/package.json` is the
fallback for local builds).

**Continuous prereleases.** Between releases, `packages/bin/package.json` carries
the next target as `X.Y.Z-next` (declared, never auto-written). Every
build-affecting merge to `main` auto-publishes a `vX.Y.Z-next.N` prerelease
(docs/vault-only merges produce nothing — the tagger is path-filtered). Install
or update one with `MIMIR_NEXT=1 sh install.sh`, `mimir self-update --next`, or
pin a build with `mimir self-update --tag v0.6.0-next.5`.

**Cutting an official release** is a two-commit dance:

1. **Cut commit:** bump `packages/bin/package.json` from `X.Y.Z-next` to
   `X.Y.Z`, promote `[Unreleased]` in `CHANGELOG.md` to `## vX.Y.Z - YYYY-MM-DD`,
   add a fresh `[Unreleased]`. Merge, then push the tag `vX.Y.Z`. The release
   workflow builds the per-platform binaries and publishes a GitHub Release
   (non-prerelease) with notes pulled from the changelog.
2. **Open the next cycle (required):** bump `packages/bin/package.json` to the
   next `-next` (e.g. `X.(Y+1).0-next`, or a major bump if that's the call) and
   merge. This resumes the prerelease stream. The version guard fails any
   build-affecting change that lands while a released clean version has no
   next-cycle bump, so forgetting this step is loud, not silent.

> Retention/pruning of old prereleases is tracked separately (a future cut
> step); for now prereleases accumulate.

## Code of conduct

Be respectful. Assume good faith. Disagreements about design are normal;
personal attacks are not.

## Security

Security issues should not be filed as public issues. See [`SECURITY.md`](SECURITY.md).

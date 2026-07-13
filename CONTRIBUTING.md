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
plus `bun test`. The store-backed suites run against a temporary Norn vault, so
they need the `norn` binary on `PATH` (they skip cleanly without it).

## Project shape

One core, thin transports, in a Bun workspace. `packages/contract`
(`@mimir/contract`) is the dependency-free type leaf — the wire vocabulary
every consumer parses. `packages/bin` (`@mimir/bin`) is the binary: `src/core`
is the domain logic (derivation, rank, mutation verbs, intent layer) over the
`Store` seam; `src/norn` speaks to the `norn` binary that owns the vault;
`src/cli`, `src/mcp`, and `src/http` are the transports; `src/main.ts` is the
composition root. `packages/ui` (`@mimir/ui`) is the operator-console SPA,
embedded in the binary at build time. Inside the binary the layering
`contract ← core ← transports` is enforced by an oxlint rule — `core` may not
import a transport, and transports may not import each other.

## Pull requests

`main` is protected: changes land via PR with a green CI check.

- Keep PRs small and focused — one logical change per PR.
- Run `bun run verify` locally before pushing. CI runs the same gate.
- If the change affects CLI/MCP behavior, output format, the schema, or
  configuration, add a changelog fragment: a `.changes/<slug>.md` file (the
  task id is the conventional slug) with the entry under the appropriate
  `### Added` / `### Changed` / `### Removed` / `### Fixed` heading
  ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/); format details in
  [`.changes/README.md`](.changes/README.md)). `CHANGELOG.md` itself is written
  only at the release cut, which compiles the pending fragments — so parallel
  PRs never conflict on it. The `changelog-guard` check enforces this: a PR
  touching build-affecting paths (`packages/**`, `package.json`, `bun.lock`,
  `install.sh`, the release workflows) fails CI unless it touches a fragment.
  For a genuinely behavior-preserving change (internal refactor, test- or
  build-meta only), apply the `skip-changelog` label with a one-line reason
  instead.

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

**Cutting an official release** is a two-commit procedure. A _cut commit_ bumps
`packages/bin/package.json` `X.Y.Z-next` → `X.Y.Z`, compiles the pending
`.changes/` fragments into a new `## vX.Y.Z - YYYY-MM-DD` section
(`bun run changelog:compile --write --version X.Y.Z`, which also deletes the
compiled fragments), and pushes the `vX.Y.Z` tag — the release workflow then builds the per-platform
binaries and publishes a non-prerelease GitHub Release with notes pulled from the
changelog. A _next-cycle commit_ then bumps to the next `-next` to resume the
prerelease stream; the version guard makes a forgotten next-cycle bump loud, not
silent. An official cut also prunes old prereleases lag-by-one, keeping the
previous official's cycle trail one release longer.

The full operational runbook — exact commands and the post-publish verify gate —
lives in the `release-cut` skill (`.claude/skills/release-cut/`).

## Code of conduct

Be respectful. Assume good faith. Disagreements about design are normal;
personal attacks are not.

## Security

Security issues should not be filed as public issues. See [`SECURITY.md`](SECURITY.md).

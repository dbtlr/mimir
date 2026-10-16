---
description: Repository structure, runtime setup, checks, and contribution workflow.
---

# Contributing to mimir

Thanks for considering a contribution. `mimir` is the source of truth for work
state — tasks, the work hierarchy, and the artifacts attached to them.
Contributions of all sizes are welcome — bug reports, doc fixes, test additions,
and feature work.

## Getting started

Install [Bun](https://bun.sh) `1.4.3` (pinned in `.tool-versions`; `mise install`
picks it up), then:

```bash
bun install
bun run verify         # format, lint, types, binary tests, and UI tests
bun run test:postgres  # disposable real-Postgres integration lane
bun run test:sandbox   # build and native snapshot rehearsal
```

`verify` is `bun run check` (oxfmt + oxlint + type-aware typecheck, zero-warning)
plus binary and UI tests. SQLite-backed suites use in-memory databases (a temporary file
where the file itself is under test) and need nothing installed. Postgres unit tests use PGlite.
The Postgres and sandbox lanes need Docker; CI runs both alongside `verify`.
See the [sandbox guide](docs/guides/development-sandboxes.md)
for fixtures, snapshots, and candidate migration tests.

For host and PWA changes, run the local integration gates:

```bash
bun run test:host      # dev browser and disposable SQLite container checks
bun run test:pwa       # browser update lifecycle across two host builds
```

`test:host` also runs in CI. It checks the isolated development server and
needs Docker for the SQLite and Postgres image checks. It uses a temporary volume, an owned Postgres container, and random loopback
ports, then removes its containers, network, volume, and image. `test:pwa` is a manual
browser lane outside `verify` and CI. Browser checks need Chromium:
`bun run --cwd packages/host playwright install chromium`.

## Project shape

One core, thin transports, in a Bun workspace. `packages/contract`
(`@mimir/contract`) is the transport-free leaf — DTOs, enums, zod Engine schemas,
and the shared `MimirError` class. `packages/core` (`@mimir/core`) is the domain logic
(derivation, rank, mutation verbs, intent layer) over the `Store` seam, plus
the store backends, the doctor, the installation record, and the runtime
config; `src/store-sql` is the one SQL store, written once, with
`src/store-sqlite` (the default local file) and `src/store-postgres` (the
shared database) supplying each dialect's connection, DDL, and column
encodings. Its public surface is the entry `src/index.ts`; test fixtures sit
behind `@mimir/core/testing`. `packages/bin` (`@mimir/bin`) is the binary:
`src/cli`, `src/mcp`, and `src/http` are the transports; `src/main.ts` is the
composition root. `packages/api` (`@mimir/api`) owns the transitional `/api`
route table, request dispatcher, response envelope, and HTTP guards. Both the
binary and the host use this package. Its handlers take standard `Request`
objects and explicit route parameters. The layering
`contract ← core ← bin` is enforced by an oxlint rule — `@mimir/core` may not
import `@mimir/bin`, bin reaches core only through its two entries, and
transports may not import each other.

`packages/host` (`@mimir/host`) contains the operator console and the TanStack
Start host. Start runs in SPA mode on Nitro's Bun preset. The client routes
remain code-based in `src/router.tsx`, behind `src/start-router.tsx`.
`src/start-routes` supplies Start's generated route tree, including the `/api/$`
server route. The host imports `@mimir/api`, never `@mimir/bin`.

`bun run build:ui` builds the host and prerenders a data-free `_shell.html`.
The final client assets and PWA output live in `packages/host/.output/public`.
The service worker precaches that shell and excludes `/api`, `/trpc`,
`/_serverFn`, and `/health` from navigation fallback. `bun run build` embeds
those same public assets in the compiled binary for `mimir serve`.

The root `Dockerfile` builds a separate host runtime from `oven/bun:1.4.3`.
It runs as the `bun` user and reads validated environment configuration at boot,
without reading the CLI's `config.toml`. SQLite defaults to `/data` in the image;
`MIMIR_DATABASE_URL` or `MIMIR_DATABASE_URL_FILE` selects Postgres. Setting both
refuses startup. `MIMIR_PORT` defaults to `64647`.

The image build defines Postgres authority; runtime environment variables cannot
grant it to development hosts. The host migrates before serving, logs applied
migrations, and refuses a newer schema with an instruction to update the image.
Development defaults to `.dev/host` beneath `packages/host` and port `64747`,
separate from the live console origin. Use the
[sandbox host launcher](docs/guides/development-sandboxes.md) for owned Postgres.
The shared network guards cover every host route, including static assets.
`MIMIR_HOSTS` enables optional Host filtering; `MIMIR_URL` adds its hostname only
when filtering is enabled. Cross-origin writes are always refused. `/health`
reports the build and supported schema without querying the store, and Docker
probes its JSON response with Bun. `/api/doctor` keeps the store's diagnostic
facet without CLI configuration findings.
tRPC, image publishing, and deployment remain later migration work. The existing CLI installation and
`mimir serve` workflows remain available.

The host API is unauthenticated: every reachable client can read and mutate
the store. Publish local test ports on loopback
(`-p 127.0.0.1:64647:64647`). Hosted port publishing must restrict access to
the single-user tailnet, as ADR 0035 requires.

The client/host split starts with `Engine.getNode` and `Engine.done`.
`LocalEngine` owns a `Store` and delegates to the existing domain functions;
`@mimir/wire/server` adapts an Engine to tRPC, and `@mimir/wire/client` provides
the store-free `RemoteEngine`. The two wire entries share only types across
the client/server boundary. Engine inputs and outputs come from contract
schemas, and the procedure table is checked against the Engine's methods.
Superjson preserves `Date` values and explicit `undefined` across the wire.
Engine timestamps, including nested facet timestamps, are `Date` values;
the existing intent DTOs and CLI, MCP, and HTTP renderings keep strings.
Existing transports keep their direct-call paths until their migration phase.

## Pull requests

`main` is protected: changes land via PR with a green CI check.

- Keep PRs small and focused — one logical change per PR.
- Run `bun run verify` locally before pushing. CI runs the same gate.
- If the change affects CLI/MCP behavior, output format, the schema, or
  configuration, add a changelog fragment: a `.changes/<slug>.md` file (the
  task id is the conventional slug) with the entry under the appropriate
  Keep-a-Changelog heading — `### Added` / `### Changed` / `### Deprecated` /
  `### Removed` / `### Fixed` / `### Security`
  ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/); format details in
  [`.changes/README.md`](.changes/README.md)). `CHANGELOG.md` itself is written
  only at the release cut, which compiles the pending fragments — so parallel
  PRs never conflict on it. The `changelog-guard` check enforces this: a PR
  touching build-affecting paths (`packages/**`, `skills/mimir/**`,
  `package.json`, `bun.lock`, `install.sh`, the release workflows) fails CI
  unless it touches a fragment.
  For a genuinely behavior-preserving change (internal refactor, test- or
  build-meta only), apply the `skip-changelog` label with a one-line reason
  instead.

## Landing PRs

`main`'s branch protection requires status checks to be **strict** — a PR
must be up to date with `main` before its checks count toward merge. With
more than one PR open at once, this forces a serial rebase train: only one PR
can be up to date and mergeable at a time, and merging it makes every other
open PR behind again, needing its own rebase and a fresh CI cycle. Budget for
one full CI cycle per PR in the train, not one for the whole batch. Land PRs
in dependency order, and have whichever PR first touches shared plumbing
(config, shared types, a common seam) own that change — don't let two PRs in
the same train edit the same shared surface independently.

A few sharp edges in the tooling around this:

- **A `gh pr merge` on a behind branch can defer silently.** If the target
  branch isn't up to date with `main`, `gh pr merge` may queue or defer the
  merge rather than merging immediately or failing loudly — and still exit
  `0`. Don't treat a zero exit as "merged." Check `mergeStateStatus` (or the
  PR's merged state) after the command returns to confirm the merge actually
  landed, not just that the command didn't error.
- **`gh pr checks` can report the prior commit's results right after a
  push.** There's a gap between a push registering and CI re-running checks
  against the new head SHA; `gh pr checks` polled in that gap can show the
  previous SHA's (possibly green) results, which reads as "already passing"
  when the new commit hasn't been checked yet. Poll check-runs against the
  head SHA explicitly rather than trusting the first `gh pr checks` result
  after a push.
- **Re-settle after every merge.** Before handing a branch off (or moving to
  the next PR in the train), rebase it onto the latest `origin/main` and
  re-verify — don't leave a branch behind for someone else to discover at
  merge time. After each PR in the train lands, re-settle the next one before
  attempting its merge.

## Commit messages

Conventional, plain-English commit messages. The first line is a short
imperative summary (under ~72 chars); body paragraphs explain the _why_, not the
_what_. `git log` is the best style reference.

## Documentation

Read the [documentation writing guide](docs/writing-style.md) before changing
the README or user guides. Public documentation should be concise, concrete,
and verified against the current product surfaces. Do not copy command help
into narrative guides.

## Releases

Releases are tag-driven, and the binary reports the exact tag it was built from
(`--version` is injected at compile time; `packages/bin/package.json` is the
fallback for local builds).

**Continuous prereleases.** Between releases, `packages/bin/package.json` carries
the next target as `X.Y.Z-next` (declared, never auto-written). Every
build-affecting merge to `main` auto-publishes a `vX.Y.Z-next.N` prerelease
(docs-only merges produce nothing — the tagger is path-filtered). Install
or update one with `MIMIR_NEXT=1 sh install.sh`, `mimir self-update --next`, or
pin a build with `mimir self-update --tag v0.6.0-next.5`.

**Cutting an official release** is a two-commit procedure. A _cut commit_ bumps
`packages/bin/package.json` `X.Y.Z-next` → `X.Y.Z` (syncing `bun.lock`'s
matching version line alongside it), compiles the pending `.changes/`
fragments into a new `## vX.Y.Z - YYYY-MM-DD` section (`bun run
changelog:compile --write --version X.Y.Z`, which also deletes the compiled
fragments), and pushes the `vX.Y.Z` tag — the release workflow then builds the
per-platform binaries and publishes a non-prerelease GitHub Release with notes
pulled from the changelog. A _next-cycle commit_ then bumps to the next
`-next` (again syncing `bun.lock`) to resume the prerelease stream; the
version guard makes a forgotten next-cycle bump loud, not silent. An official
cut also prunes old prereleases lag-by-one, keeping the previous official's
cycle trail one release longer.

The full operational runbook — exact commands and the post-publish verify gate —
lives in the `release-cut` skill (`.claude/skills/release-cut/`).

## Code of conduct

Be respectful. Assume good faith. Disagreements about design are normal;
personal attacks are not.

## Security

Security issues should not be filed as public issues. See [`SECURITY.md`](SECURITY.md).

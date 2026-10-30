---
description: Repository structure, runtime setup, checks, and contribution workflow.
---

# Contributing to mimir

Thanks for considering a contribution. `mimir` is the source of truth for work
state — tasks, the work hierarchy, and the artifacts attached to them.
Contributions of all sizes are welcome — bug reports, doc fixes, test additions,
and feature work.

## Getting started

Install [Bun](https://bun.sh) `1.4.4` (pinned in `.tool-versions`; `mise install`
picks it up), then:

```bash
bun install
bun run verify         # format, lint, types, binary tests, and UI tests
bun run test:postgres  # disposable real-Postgres integration lane
bun run test:sandbox   # build, then the installer and MCP-binding lifecycle tests
```

`verify` is `bun run check` (oxfmt + oxlint + type-aware typecheck, zero-warning)
plus binary and UI tests. SQLite-backed suites use in-memory databases (a temporary file
where the file itself is under test) and need nothing installed. Postgres unit tests use PGlite.
The Postgres and sandbox lanes need Docker; CI runs both alongside `verify`.
See the [sandbox guide](docs/guides/development-sandboxes.md)
for the test lanes, the development host against disposable Postgres, the
installer lifecycle, and skill evaluation.

The CLI, host admin CLI, and sandbox use Loom 0.16. Keep every `@loomcli`
dependency, the `@loomcli/loom` toolchain in `packages/cli` included, pinned to the
same exact version. `vp check` loads Loom's lint
rules, and `bun test` checks that each application assembles with
`assertAssembles`. A `views()` default must name a view supplied in that
same call; re-supply the default view to preserve the existing format order.

Pull requests run the complete ordinary suite once in Linux CI. The Release
matrix runs `bun run test:native` on macOS ARM64, Linux x64, and Linux ARM64.
This subset covers native SQLite files and process races, installation receipts,
filesystem permissions, Git subprocesses, process cleanup, and time-zone formatting.
Tag and manually dispatched release runs keep the complete suite on each platform.
Platform-specific failures outside the native subset can therefore surface at release time.

After compilation, every Release matrix job tests its candidate binary before upload.
The CLI creates isolated SQLite boards, reports its build version and installation
protocol, and serves MCP calls over real subprocess stdio. The same fixture runs
in `test:sandbox` with `dist/mimir`. To test another compiled candidate:

```bash
MIMIR_TEST_BINARY=dist/mimir-linux-x64 MIMIR_SANDBOX_LIFECYCLE_TEST=1 \
  bun test packages/sandbox/src/mcp-binding.integration.test.ts
```

`MIMIR_TEST_BINARY` selects the file to copy into a disposable directory. A missing
candidate fails the enabled fixture. The fixture expects a `MIMIR_TEST_BINARY`
candidate to report the version in `packages/cli/package.json`, which the release
workflow stamps before it builds, and the default `dist/mimir` to report the CLI's
development version.

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

## Tests that time out

When a test times out under load, find and fix what makes it slow. Do not raise
Testing Library's `asyncUtilTimeout`, a per-call timeout, or the Vitest test
timeout, even as a backstop: a longer timeout hides the cost until the next load
spike fails the test again. Time the queries and the render separately. A
role query with a name walks the accessibility tree, so over a large DOM use a
text query or mount a narrower fixture instead (MMR-500 traced one timeout to a
named-role query over more than 100 links). Confirm the fix with a stress run
under the default timeouts.

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
behind `@mimir/core/testing`.

`packages/cli` (`@mimir/cli`) is the `mimir` binary: the CLI and the MCP
server, both on Loom (ADR 0037). Its commands are Loom declarations that call
only the Engine; `src/app.ts` is the composition root and the only module that
imports `@mimir/core`, which the lint rule enforces, and `src/main.ts` is the
entry. The layering `contract ← core ← cli` is enforced by an oxlint rule:
`@mimir/core` may not import `@mimir/cli`, and the CLI reaches core only through
its two entries. The parity cases pin each command's output as snapshots in
`src/parity-pins`; re-record them with `bun run pins:update`. Help pages are
pinned in `src/help-pages`. `scripts/` holds the release and developer tooling
(changelog compiler, release publisher, docs fixture). `bun run
build` compiles the binary into `dist/mimir` with `loom build`; the skill's
`mimir …` invocations are checked against the command graph by the drift guard
in `src/testing/skill-invocations.test.ts`. `packages/cli/install.sh` is the installer
`loom init --only install` renders, and `src/installer.test.ts` fails when it
drifts. The root `install.sh`, which the install URL serves, is a byte-for-byte
copy of it until Loom can render the installer at the root (LM-s40); after a
re-render, copy it to the root, and the same test fails while the two differ.

`packages/host` (`@mimir/host`) contains the operator console and the TanStack
Start host. Start runs in SPA mode on Nitro's Bun preset. The client routes
remain code-based in `src/router.tsx`, behind `src/start-router.tsx`.
`src/start-routes` supplies Start's generated route tree, including the `/health`
and `/trpc/$` server routes. The host imports `@mimir/wire/server`,
never `@mimir/cli`. One host runtime shares a store and `LocalEngine` across the
server bundles; `hostRuntime()` exposes the Engine for console server functions.

`bun run build:ui` builds the host and prerenders a data-free `_shell.html`.
Prerendering ignores deployment configuration and uses a loopback-only request
guard. Serving launchers still validate the complete runtime configuration.
The final client assets and PWA output live in `packages/host/.output/public`.
The service worker precaches that shell and excludes `/auth`, `/trpc`,
`/_serverFn`, and `/health` from navigation fallback. The compiled `mimir`
binary does not embed them: the console ships only in the host image.

The root `Dockerfile` builds a separate host runtime from `oven/bun:1.4.4`.
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
reports the build, minimum client, and supported schema without querying the
store. Docker probes its JSON response with Bun. The console's `doctor` server function keeps the
store's diagnostic facet without CLI configuration findings.
`/trpc` serves the Engine through the same host guards. Every tRPC call requires
`x-mimir-version` inside the host's version window:
no older than `MIN_CLIENT` and no newer than the host by minor version.
`RemoteEngine` takes the client build version and an optional headers hook.
Version refusals carry a `MimirError` and the CLI or host update remedy.
After the version check, every tRPC procedure requires `Authorization: Bearer`
with an active device token. Missing or invalid tokens receive a uniform
`UNAUTHORIZED` transport error. Outside the version and bearer checks,
`POST /auth/pairing/requests` files a pairing request and `POST /auth/pairing/poll`
collects `{device, token}` once the operator approves its code on the host. The
host-wide creation limit refuses new requests after ten in a rolling ten minutes.
Unexpected tRPC and server-function faults log structured diagnostics on stderr. tRPC replies
omit stacks and replace internal library messages with a generic failure and doctor hint;
domain errors retain their codes, messages, and hints.

The console remains unauthenticated: every reachable client can read and mutate
the store through server functions. Publish local test ports on loopback
(`-p 127.0.0.1:64647:64647`). Hosted port publishing must restrict access to
the single-user tailnet, as ADR 0035 requires.

The Engine carries every CLI and MCP read (`next`, `list`, `projects`,
`getNode`, `getArtifact`, `getSeed`, `status`, `tree`, `overview`,
`artifacts`, `search`, `seeds`, `scratchList`, `scratchGet`) and every node
write (`create`, `update`, `updateProject`, `updateArtifact`, `annotate`,
`attach`, `depend`, `undepend`, `move`, `reorder`, `groom`, `tag`, `untag`, and
the fourteen uniform verbs, which are derived from the operation facts), plus every seed write
(`seedCreate`, `seedPromote`, `seedResolve`, `seedReject`, `seedPark`,
`seedUnpark`, `seedUpdate`, `triage`) and Scratchpad write (`scratchCreate`,
`scratchUpdate`, `scratchCheckpoint`, `scratchAgendaAdd`,
`scratchAgendaComplete`, `scratchAgendaSupersede`, `scratchFreeze`,
`scratchDiscard`). Board reads name their project; only `projects` spans projects.
`LocalEngine` owns a `Store` and delegates to the existing domain functions;
`@mimir/wire/server` adapts an Engine to tRPC, and `@mimir/wire/client` provides
the store-free `RemoteEngine`. The two wire entries share only types across
the client/server boundary. Engine inputs and outputs come from contract
schemas, and the procedure table is checked against the Engine's methods.
Each decoded output schema is checked against the core projection it
replaces, and the wire tests compare every read locally and remotely.
Superjson preserves `Date` values and explicit `undefined` across the wire.
Engine timestamps, including nested facet timestamps, are `Date` values;
the existing intent DTOs and CLI and MCP renderings keep strings.
Existing transports keep their direct-call paths until their migration phase.

## Engine contract changes

`bun run verify` compares the Engine and console schemas with the checked-in
input and output JSON Schema snapshot at `packages/contract/engine-schemas.json`.
After changing a schema, run `bun run contract:snapshot` and include its diff.
Review the diff for compatibility and raise `MIN_CLIENT` in `@mimir/contract`
when the change breaks older clients. Contract changes belong in minor releases;
patch releases leave the schemas unchanged (ADR 0038).
The generator labels Superjson Dates explicitly and admits only supported
schema types, checks, and options. New behavior needs an explicit snapshot
representation before the Engine can use it. Checks are admitted only on the
schema types whose JSON conversion represents them. Conversion ignores Zod
metadata so annotations cannot override validation constraints. Unsupported
constraints or transforms stop generation instead of disappearing from
compatibility review.

## Pull requests

`main` is protected: changes land via PR with a green CI check.

- Keep PRs small and focused — one logical change per PR.
- Run `bun run verify` locally before pushing. CI runs the same gate.
- If the change affects CLI/MCP behavior, output format, the schema, or
  configuration, add a changelog fragment to `packages/cli/.changes/`, in
  Loom's grammar ([the fragment guide](packages/cli/.changes/README.md),
  [ADR 0039](docs/decisions/0039-changelog-and-versioning-on-loom.md)). The
  file name sets the kind: `breaking.<slug>.md` for a change a user must adapt
  to (it ends with a `### Migration` section), `feature.<slug>.md` for a
  feature, and `<slug>.md` for a fix; the task id is the conventional slug.
  The kinds decide the next version, so a cycle that changes the Engine
  contract, additively included, carries a breaking fragment; the guard
  refuses an Engine schema snapshot or `MIN_CLIENT` change without one. `packages/cli/CHANGELOG.md` itself is written only at the
  release cut, so parallel PRs never conflict on it. Run
  `bun run --cwd packages/cli loom changelog check` to validate fragments. The
  `changelog-guard` check enforces this: a PR touching build-affecting paths
  (`packages/**`, `skills/mimir/**`, `package.json`, `bun.lock`, `install.sh`,
  the release workflows) fails CI unless it touches a fragment.
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

Releases are tag-driven, and the binary reports the exact tag it was built from.
The release workflow stamps the tag's version into `packages/cli/package.json`
and compiles with `loom build --release`, which bakes that version into the
binary's release facts; `mimir version` and self-update read them. Between cuts
`packages/cli/package.json` holds the last release, and a source or local build
reports the next minor's development version (`0.25.0` reports `0.26.0-next`).

**Continuous prereleases.** Every build-affecting merge to `main` auto-publishes
a `vX.Y.Z-next.N` prerelease, where `X.Y.Z` is the version the pending
fragments decide (`loom changelog write --dry-run`) and `N` counts up per
version. Docs-only merges, and merges while no fragment is pending, produce
nothing. Install one with `./install.sh 0.26.0-next.5` (a version
argument), update to the newest with `mimir self-update --channel next`, or pin
a build with `mimir self-update 0.26.0-next.5`.

**Cutting an official release** is one commit and a tag. The cut commit runs
`loom changelog write` in `packages/cli`, which prepends the
`## vX.Y.Z - YYYY-MM-DD` section to `packages/cli/CHANGELOG.md`, sets
`packages/cli/package.json` to `X.Y.Z`, and deletes the consumed fragments;
`bun install` then refreshes `bun.lock`. After it merges, the `vX.Y.Z` tag
starts the release workflow, which builds the per-platform binaries and
publishes a non-prerelease GitHub Release with notes pulled from the changelog.
There is no next-cycle commit: the next fragment to merge starts the next
prerelease stream. An official cut also prunes old prereleases lag-by-one,
keeping the previous official's cycle trail one release longer.

The full operational runbook — exact commands and the post-publish verify gate —
lives in the `release-cut` skill (`.claude/skills/release-cut/`).

## The live deployment

Mimir has one live deployment: the maintainer's installed CLI and the host
container that owns its store. A separate infrastructure repository, Fleet,
deploys the host and its proxy route, and Fleet's own sessions make those
changes.

- **Deployment changes go to Fleet.** When a Mimir change needs the host
  deployed differently (its service, proxy route, or container settings), file
  a seed on Fleet's board (`FLT`) that states the facts the deployment must
  meet, even when the Mimir task spells out the steps. Do not edit the
  infrastructure repository or run its commands from a Mimir session. Set the
  Mimir task's upstream to the seed, block the task, and check the live host
  when Fleet resolves the seed.
- **Leave the live install alone.** Do not upgrade the live CLI or move the host
  to a prerelease because a task's done criteria say the live install runs the
  new build. The host updates before its clients (ADR 0038), and Fleet deploys
  it. Split the live upgrade into its own parked task tied to the next stable
  release, close the code task when its code merges, and ask before running
  anything against the live install.
- **Prefer the clean change.** The live deployment has no other users. A
  breaking change still carries its fragment and migration section, but a
  release nobody installed needs no deprecation aliases, compatibility shims,
  or notes about what its installs lose. Keep the live install's own upgrade
  path working, and revisit this when Mimir gains outside users.

## Code of conduct

Be respectful. Assume good faith. Disagreements about design are normal;
personal attacks are not.

## Security

Security issues should not be filed as public issues. See [`SECURITY.md`](SECURITY.md).

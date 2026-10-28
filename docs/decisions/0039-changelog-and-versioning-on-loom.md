---
title: 'ADR 0039: Changelog and versioning on Loom'
description: The CLI package's changelog fragments, in Loom's three kinds, decide the next version, and `loom changelog write` cuts it. package.json holds the last release between cuts; the prerelease tagger and untagged builds derive their versions from it. Release orchestration stays mimir's own.
status: accepted
date: 2026-10-28
---

# ADR 0039: Changelog and versioning on Loom

Supersedes [ADR 0022](0022-changelog-fragments-compiled-at-cut.md). Fragments
stay: one file per change, reviewed in the PR, compiled only at the cut. What
changes is whose grammar they use and what decides the version.

## Decision

- **The changelog belongs to the CLI package.** Fragments live in
  `packages/cli/.changes/` and the changelog in `packages/cli/CHANGELOG.md`.
  `loom changelog check` validates fragments; `loom changelog write` cuts a
  release ([Loom ADR 0067](https://github.com/dbtlr/loomcli/blob/main/docs/decisions/0067-a-packages-changelog-cuts-its-version-from-three-fragment-kinds.md)).
  `.changes/README.md` is the guide `loom init` writes.
- **The fragment's kind decides the version.** `breaking.<slug>.md`,
  `feature.<slug>.md`, and `<slug>.md` (a fix). On `0.x`, a breaking fragment
  bumps the minor and anything else the patch. ADR 0038 allows an Engine
  contract change, additive included, only in a minor release, so a cycle that
  changes the contract carries at least one breaking fragment, with the
  `### Migration` section Loom requires; for an additive change the migration
  is to update the host before its clients. `changelog-guard` refuses a PR
  that changes the Engine schema snapshot or `MIN_CLIENT` while no breaking
  fragment is pending.
- **`packages/cli/package.json` holds the last release between cuts.** `write`
  sets it at the cut; nothing else stores a version. Only the CLI package
  carries the release version; `core` and `wire` do not track it.
- **Prerelease versions are computed, never stored.** On each build-affecting
  merge to `main`, the tagger reads the next version from
  `loom changelog write --dry-run` and tags `v<next>-next.N`, where `N` is one
  above the highest existing tag for that version. With no pending fragment
  there is nothing to release, and it tags nothing. The next version only
  rises between cuts: the tagger refuses a version below a prerelease already
  published since the last release, which reverting the cycle's only breaking
  fragment would cause. The release workflow stamps the tag's version into
  `package.json` before `loom build --release`.
- **An untagged build reports the next minor's development version.** A
  source run, a local build, a PR build, and the host bundle without a stamped
  version report `<major>.<minor + 1>.0-next` from `packages/cli/src/version.ts`
  (`0.25.0` reports `0.26.0-next`). That is the floor a cycle sets when it
  raises `MIN_CLIENT`, so a source CLI stays inside a source host's version
  window.
- **Release orchestration stays mimir's own.** Loom keeps PR guards, GitHub
  publishing, prerelease channels, and release workflows out of its contract,
  so `changelog-guard.yml`, `prerelease.yml`, `release.yml`, and
  `publish-release.ts` remain. The cut is one commit (`loom changelog write`,
  then `bun install` for `bun.lock`) and a tag after it merges; there is no
  cycle-open commit and no version guard.

This decision holds on `0.x`. At `1.0` a breaking fragment bumps the major,
so the minor-release rule for Engine changes and the development version's
`<minor + 1>` both need an addendum here and in ADR 0038.

## Why

- **One changelog grammar across the toolset.** mimir's CLI is a Loom
  application (ADR 0037). Loom owns a fragment format, a validator, and a cut
  that sets the version; keeping a second compiler in mimir duplicated all
  three.
- **The version follows from what changed.** Under ADR 0022 a person declared
  the next version as `X.Y.Z-next` in `package.json` and bumped it again after
  each cut; a forgotten bump stopped prereleases, so a version guard existed
  to catch it. When fragments carry their kind, the cut computes the version,
  and the declaration, the cycle-open commit, and its guard have no job left.
- **Breaking changes are explicit at review time.** A fragment's kind is in
  its file name, and a breaking one carries its migration, so the reviewer
  sees the version consequence and the upgrade path in the PR.

## Considered and rejected

- **Keep ADR 0022's compiler and adopt only Loom's build.** It leaves two
  fragment grammars in one toolset, and the hand-declared version keeps its
  cycle-open commit and guard.
- **Lower `MIN_CLIENT` to the last release so untagged builds pass the
  window.** It works until the next raise of `MIN_CLIENT`, when every source
  build falls below it again for the rest of the cycle.
- **Derive untagged builds' version from the pending fragments.** Listing
  `.changes/` for a `breaking.` name would report the cycle's exact next
  version and keep a source CLI inside a patch cycle's prerelease host's
  window. But the version module runs in three places that share no file
  access at that point: a source run, a compiled development binary (which
  carries no `.changes/`), and Vite's Node config loader. Baking a listing at
  build time would need a second build-time mechanism beside Loom's release
  facts. The next minor needs neither.

## Consequences

- An untagged build's version can name a higher minor than the cycle
  releases: in a patch-only cycle a source CLI reports `0.27.0-next` while
  prereleases are `0.26.1-next.N`, so a released or prerelease host of that
  cycle refuses the source CLI as newer than the host. Test a source CLI
  against a source host (`bun run dev`), or against a prerelease of a cycle
  that carries a breaking fragment.
- Ordering inside a release section follows the commit that added each
  fragment, so `write` needs full git history; the tagger checks out with
  full history.
- A build-affecting merge while no fragment is pending, such as a
  `skip-changelog` refactor right after a cut, publishes no prerelease.

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
  contract change only in a minor release, so one ships as a breaking
  fragment, with the `### Migration` section Loom requires.
- **`packages/cli/package.json` holds the last release between cuts.** `write`
  sets it at the cut; nothing else stores a version. Only the CLI package
  carries the release version; `core` and `wire` do not track it.
- **Prerelease versions are computed, never stored.** On each build-affecting
  merge to `main`, the tagger reads the next version from
  `loom changelog write --dry-run` and tags `v<next>-next.N`, where `N` is one
  above the highest existing tag for that version. With no pending fragment
  there is nothing to release, and it tags nothing. The release workflow
  stamps the tag's version into `package.json` before `loom build --release`.
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
- **Stamp untagged builds from `loom changelog write --dry-run`.** It reports
  the exact next version, but every source run would need Loom and the full
  git history, and a patch-only cycle gains nothing a development build needs.

## Consequences

- An untagged build's version can name a higher minor than the cycle
  releases (a patch-only cycle still reports the next minor). That matters
  only for a development CLI against a released host, which development
  directories already keep apart.
- Ordering inside a release section follows the commit that added each
  fragment, so `write` needs full git history; the tagger checks out with
  full history.
- A build-affecting merge while no fragment is pending, such as a
  `skip-changelog` refactor right after a cut, publishes no prerelease.

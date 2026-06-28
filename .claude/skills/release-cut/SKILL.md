---
name: release-cut
description: Cut an official mimir release — the two-commit procedure (promote the changelog + tag, verify, open the next cycle). Use when the user grants a release cut: "cut the release", "cut vX.Y.Z", "release the cycle".
---

# Cutting a release

A **cut** is **two commits with a tag between them**: one promotes the release and
fires the build, one opens the next development cycle. Between them sits a **verify
gate** — an official release is not done until it's verified, not glanced at.

Between releases, `packages/bin/package.json` carries `X.Y.Z-next`. The cut turns
that into `X.Y.Z`, then into `X.(Y+1).0-next`.

## 1. Pre-cut checks

- On `main`, working tree clean, fetched fresh (`git fetch && git status`).
- `bun run verify` is green.
- `## [Unreleased]` in `CHANGELOG.md` has real entries. An empty section means
  there is nothing to ship — stop. (`finishing-work` + `changelog-guard` keep this
  section honest per-PR; the cut trusts it.)
- Target version = the `-next` base in `packages/bin/package.json`
  (`0.13.0-next` → `0.13.0`).

## 2. Cut commit (PR)

On a branch:

- Bump `packages/bin/package.json` `"version"` from `X.Y.Z-next` to `X.Y.Z`.
- In `CHANGELOG.md`, rename `## [Unreleased]` to `## vX.Y.Z - YYYY-MM-DD` (today's
  date) and add a fresh empty `## [Unreleased]` above it.
- _Optional, only when the release warrants it:_ refresh the README (status
  callout, screenshots). Not a gate — skip it for a routine cut.

Open the PR, let CI pass, merge. Then push the annotated tag:

```bash
git checkout main && git pull
git tag -a vX.Y.Z -m "Release vX.Y.Z" && git push origin vX.Y.Z
```

The tag fires `release.yml`: it builds the three platform binaries, checksums them,
extracts the release notes **from the CHANGELOG section you just promoted**,
publishes the GitHub Release, and (official tags only) prunes old prereleases.

## 3. Verify gate — not a glance

Wait for the release run to finish (`gh run watch`), then confirm **every** item:

```bash
gh release view vX.Y.Z --json isPrerelease,tagName,assets \
  --jq '{prerelease: .isPrerelease, assets: [.assets[].name]}'
```

- `prerelease` is `false`.
- assets are exactly the three binaries — `mimir-darwin-arm64`, `mimir-linux-x64`,
  `mimir-linux-arm64` — plus `SHA256SUMS`. (Keep this list in sync with
  `release.yml`'s build matrix.)
- Download one binary and confirm its checksum matches `SHA256SUMS`.
- The built/installed binary reports `--version` = `X.Y.Z`.
- Prune ran lag-by-one: only the just-shipped cycle's `vX.Y.Z-next.*` trail
  remains; older prerelease cycles are gone (`gh release list`).

A failure here is a release problem — fix forward, do not paper over it.

## 4. Open the next cycle (PR, required)

Bump `packages/bin/package.json` `"version"` to `X.(Y+1).0-next` (or a major bump
if that's the call); open the PR; merge. Confirm the prerelease stream resumes
(`vX.(Y+1).0-next.1` publishes) and `version-guard` is green.

This step is required: `version-guard` fails any build-affecting change that lands
while a released clean version has no next cycle open — so skipping it is loud, not
silent. Close it here, as the cut's last move, not as a later follow-up.

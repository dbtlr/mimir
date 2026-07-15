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
- `.changes/` has real pending fragments — preview the section they compile to
  with `bun run changelog:compile`. No fragments means there is nothing to ship —
  stop. (`finishing-work` + `changelog-guard` keep the fragments honest per-PR;
  the cut trusts them.)
- Target version = the `-next` base in `packages/bin/package.json`
  (`0.13.0-next` → `0.13.0`).

## 2. Cut commit (PR)

On a branch:

- Bump `packages/bin/package.json` `"version"` from `X.Y.Z-next` to `X.Y.Z`.
- Sync `bun.lock`: edit the `"version"` line under its `"packages/bin"` entry
  to match. `bun install` (plain, `--force`, or `--lockfile-only`) never
  rewrites this field — Bun resolves workspace deps by path, so it's metadata
  only and `--frozen-lockfile` validates fine either way — a hand edit is the
  only thing that closes it. Skipping this is what leaves a stray
  `chore: sync bun.lock` follow-up commit next cycle.
- Compile the changelog: `bun run changelog:compile --write --version X.Y.Z` —
  writes the `## vX.Y.Z - YYYY-MM-DD` section into `CHANGELOG.md` and deletes
  the compiled fragments.
- Stage and commit together: `packages/bin/package.json`, `bun.lock`,
  `CHANGELOG.md`, and the deleted `.changes/*.md` fragments (the fragment
  deletions are what satisfy `changelog-guard` on this PR). No `git add -A`.
- _Optional, only when the release warrants it:_ refresh the README (status
  callout, screenshots). Not a gate — skip it for a routine cut.

Open the PR, let CI pass, merge. Then **immediately** — before any other merge —
tag the cut commit (now `main`'s HEAD) and push:

```bash
git checkout main && git pull
git tag -a vX.Y.Z -m "Release vX.Y.Z" && git push origin vX.Y.Z
```

Don't let another PR merge between the cut merge and the tag push: the tag must
sit on the cut commit, or a stray change gets baked into the binaries while its
`.changes/` fragment stays pending for the _next_ cut — binary and notes diverge
silently. Push the tag with your
own credentials, **not** a bot / `GITHUB_TOKEN`: GitHub's anti-recursion guard
suppresses the `push: tags` trigger for `GITHUB_TOKEN`-authored pushes, so the
build silently won't fire (this is why the prerelease tagger uses
`workflow_dispatch`).

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
- Prune ran lag-by-one: the just-shipped cycle's `vX.Y.Z-next.*` trail **and the
  previous official's cycle trail** both remain; only cycles older than the
  previous official are gone (`gh release list`). An early cut with no qualifying
  older cycle deletes nothing — that's correct, not a failure.

A failure here is a release problem — fix forward, do not paper over it.

## 4. Open the next cycle (PR, required)

Bump `packages/bin/package.json` `"version"` to `X.(Y+1).0-next` (or a major bump
if that's the call); sync `bun.lock`'s `"packages/bin"` `"version"` line to match
(same hand edit as the cut commit — `bun install` won't do it). Stage
`packages/bin/package.json` and `bun.lock` together, no `git add -A`; open the
PR; merge. Confirm the prerelease stream resumes (`vX.(Y+1).0-next.1` publishes)
and `version-guard` is green.

This step is required: `version-guard` fails any build-affecting change that lands
while a released clean version has no next cycle open — so skipping it is loud, not
silent. Close it here, as the cut's last move, not as a later follow-up.

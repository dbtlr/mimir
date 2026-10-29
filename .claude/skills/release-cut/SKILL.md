---
name: release-cut
description: Cut an official mimir release — one cut commit (`loom changelog write`), a tag, and the verify gate. Use when the user grants a release cut: "cut the release", "cut vX.Y.Z", "release the cycle".
---

# Cutting a release

A **cut** is **one commit and a tag**, then a **verify gate** — an official release
is not done until it's verified, not glanced at.

Between releases, `packages/cli/package.json` holds the last release. The pending
fragments in `packages/cli/.changes/` decide the next version (ADR 0039):
`loom changelog write` computes it, writes the release section, sets the version,
and deletes the fragments. There is no cycle to open afterwards.

## 1. Pre-cut checks

- On `main`, working tree clean, fetched fresh (`git fetch && git status`).
- `bun run verify` is green.
- Preview the release: `bun run --cwd packages/cli loom changelog write --dry-run`
  prints the section and `Next version: X.Y.Z`. That is the target version. It
  fails when no fragments are pending — then there is nothing to ship; stop.
  (`finishing-work` + `changelog-guard` keep the fragments honest per-PR; the cut
  trusts them.)
- No published prerelease has a base above `X.Y.Z` (`gh release list`); a cut
  below one leaves `self-update --channel next` serving the higher build. The
  prerelease tagger refuses that state, so a red tagger run on `main` means
  resolve it first: restore the breaking fragment, or delete those prereleases.

## 2. Cut commit (PR)

On a branch:

- Cut the changelog: `bun run --cwd packages/cli loom changelog write` (add
  `--date YYYY-MM-DD` to date it other than today). It prepends the
  `## vX.Y.Z - YYYY-MM-DD` section to `packages/cli/CHANGELOG.md`, sets
  `packages/cli/package.json` `"version"` to `X.Y.Z`, and deletes the consumed
  fragments. It needs full git history; a shallow clone fails it.
- Refresh the lockfile: `bun install`, which rewrites the `"version"` line under
  `bun.lock`'s `"packages/cli"` entry.
- Stage and commit together: `packages/cli/package.json`, `bun.lock`,
  `packages/cli/CHANGELOG.md`, and the deleted `packages/cli/.changes/` fragments
  (the fragment deletions are what satisfy `changelog-guard` on this PR). No
  `git add -A`.
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
fragment stays pending for the _next_ cut — binary and notes diverge
silently. Push the tag with your
own credentials, **not** a bot / `GITHUB_TOKEN`: GitHub's anti-recursion guard
suppresses the `push: tags` trigger for `GITHUB_TOKEN`-authored pushes, so the
build silently won't fire (this is why the prerelease tagger uses
`workflow_dispatch`).

The tag fires `release.yml`: it builds the three platform binaries, checksums them,
extracts the release notes **from the changelog section you just cut**,
publishes the GitHub Release, and (official tags only) prunes old prereleases.

Publication is staged (MMR-387): the release starts as a **draft**, each asset is
uploaded with bounded retries and verified by size + SHA-256, and only the exact
complete set flips it public. If the `publish` job fails, the draft stays behind
with a per-asset diagnosis in the log — **re-run the failed `publish` job**
(`gh run rerun <run-id> --failed`); it resumes from the draft with the same build
artifacts, keeping verified assets and re-sending the rest. Do not rebuild, retag,
or upload by hand. A release that is already public is never modified: a re-run
against a complete one is a no-op, against an incomplete one a refusal.

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
- A binary installed by `packages/cli/install.sh` (not a bare download, which `self-update`
  refuses as "installed some other way") reports `mimir version` = `X.Y.Z`, and
  `mimir self-update --check` does not refuse it.
- Prune ran lag-by-one: the just-shipped cycle's `vX.Y.Z-next.*` trail **and the
  previous official's cycle trail** both remain; only cycles older than the
  previous official are gone (`gh release list`). An early cut with no qualifying
  older cycle deletes nothing — that's correct, not a failure.

A failure here is a release problem — fix forward, do not paper over it.

## 4. After the cut

Nothing reopens a cycle: `package.json` now holds `X.Y.Z`, and the next merge that
adds a fragment publishes `vX.Y.(Z+1)-next.1` or `vX.(Y+1).0-next.1`, whichever the
pending fragments decide. Until then, build-affecting merges publish no prerelease.

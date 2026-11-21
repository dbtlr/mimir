---
title: 'ADR 0047: Below 1.0, a feature advances the minor'
description: On 0.x, a breaking or feature fragment bumps the minor and only a fix-only cycle bumps the patch, as Loom's changelog cut computes it from 0.19.0 on. Supersedes ADR 0039's rule that only a breaking fragment bumps the minor.
status: accepted
date: 2026-11-21
---

# ADR 0047: Below 1.0, a feature advances the minor

Supersedes the 0.x version rule in [ADR 0039](0039-changelog-and-versioning-on-loom.md)
("The fragment's kind decides the version"). The rest of ADR 0039 stands.

## Decision

- **On `0.x`, a breaking or a feature fragment bumps the minor.** A cycle whose
  pending fragments are all fixes bumps the patch. From `0.30.0`, a cycle with
  one `feature.<slug>.md` cuts `0.31.0`; a fix-only cycle cuts `0.30.1`.
- **`loom changelog write` computes it.** Loom 0.19.0 made this the cut's rule
  below `1.0.0`, with no setting to keep the old one
  ([Loom ADR 0145](https://github.com/dbtlr/loomcli/blob/main/docs/decisions/0145-below-1-0-0-a-feature-fragment-advances-the-minor.md)).
  A `--target` or a prerelease below the computed minimum fails the cut.
- **The Engine contract rule is unchanged.** ADR 0038 still allows a contract
  change only in a minor release, and `changelog-guard` still requires a
  pending breaking fragment for one, because that fragment carries the
  host-first migration.
- **The version window is unchanged.** ADR 0038's upper bound still refuses a
  client on a newer minor than its host, so after a feature release the host
  updates before its CLIs, even when the Engine contract did not change.

## Why

- **Mimir's release tooling is Loom's.** ADR 0039 hands the version to
  `loom changelog write`. Keeping the old rule would mean pinning Loom below
  0.19.0 or computing versions outside it, which brings back the second
  version mechanism ADR 0039 removed.
- **A patch release holds only fixes.** A reader of the version learns whether
  a release adds anything, not only whether it breaks anything.

## Considered and rejected

- **Pin Loom below 0.19.0.** It keeps the old rule and gives up every later
  Loom release.
- **Compute the version outside `loom changelog write`.** It brings back the
  second version mechanism ADR 0039 removed.
- **Tie the window's upper bound to the Engine contract instead of the minor.**
  It would keep feature releases inside the window, but it adds a second
  version to keep honest, and one operator updates host and CLIs together.

## Consequences

- Minor releases come more often: nearly every cycle carries a feature.
- After a feature release, a CLI that updates before its host is refused as
  newer than the host, with the remedy to update the host first. Under ADR
  0039's rule the same release was a patch, inside the window.
- The prerelease tagger's refusal of a next version below a published
  prerelease now also follows reverting the cycle's only feature fragment, not
  only its only breaking fragment.
- ADR 0039's note on untagged builds now applies to fix-only cycles: there a
  source CLI reports the next minor's `-next` version while prereleases are
  the next patch's.

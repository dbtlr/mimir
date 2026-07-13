---
title: 'ADR 0022: Changelog fragments, compiled at the cut'
status: accepted
date: 2026-07-13
---

# ADR 0022: Changelog fragments, compiled at the cut

A PR records its changelog entry as a **fragment file** — `.changes/<slug>.md`,
written in the Keep-a-Changelog grammar (`### Added` / `### Changed` / … H3
headings plus bullets). `CHANGELOG.md` holds **only released sections** and is
written by exactly one writer: the release cut, which compiles the pending
fragments into the new `## vX.Y.Z - YYYY-MM-DD` section and deletes them in the
same commit (`bun run changelog:compile --write --version X.Y.Z`). There is no
`[Unreleased]` section — `.changes/` _is_ the unreleased set, and
`bun run changelog:compile` previews it.

- **The slug is any unique name**; the task id (`mmr-267.md`) is the
  convention. Uniqueness is the only requirement — it is what kills the
  conflicts.
- **The fragment grammar is the final grammar.** H3 headings from the closed
  Keep-a-Changelog set (`Added | Changed | Deprecated | Removed | Fixed |
Security`), bullets beneath them, nothing else. The compiler concatenates
  verbatim; it never rewrites prose.
- **`changelog-guard` becomes a presence + parse check**: a build-affecting PR
  must touch a flat `.changes/*.md` fragment or carry the `skip-changelog`
  label, and fragments present on head must parse — the guard runs the
  compiler's own `--check` mode, so the grammar exists exactly once. No
  content diffing.
- **Compilation is deterministic and pure-git**: categories in canonical
  Keep-a-Changelog order; within a category, fragments in landing order (the
  commit date each file was added, filename as tie-break).

## Why

- **The single append point was the defect, not the per-PR policy.** Every PR
  appended a bullet at the same insertion point under `[Unreleased]`, so
  parallel branches collided structurally — nearly every rebase in the v0.13.0
  merge train conflicted on `CHANGELOG.md`. A fragment is one new file with a
  unique name; two branches adding different files cannot conflict. The
  per-PR-entry completion criterion (the part that worked — it ended the v0.12
  drift) is preserved intact.
- **The entry stays inside the review boundary.** The fragment rides the PR
  diff: reviewed with the code, immutable after merge (fixing it is a new
  reviewed commit), attributable via `git blame`, and available offline. These
  properties hold at any number of writers.
- **The guard's false verdicts die structurally.** The old guard diffed
  `[Unreleased]` bullets between base and head (`comm -13`), which produced
  both a false PASS (editing an existing bullet reads as an addition) and a
  false FAIL (rewrapping prose inside a bullet adds no new bullet line —
  MMR-123's PR #95). Checking presence and shape of files in the diff has no
  diff-interpretation step, so neither failure mode exists.
- **No `[Unreleased]` section, because its job moved.** Its entire role was to
  be the accumulation point; `.changes/` is the accumulation point now. A
  permanently empty stub would exist only to satisfy the template shape, and
  a non-empty one would reintroduce the shared append point. The changelog
  header prose points at `.changes/` instead, and the preview command answers
  "what is unreleased".
- **The release seam is unchanged.** The cut still produces a
  `## vX.Y.Z - YYYY-MM-DD` section in `CHANGELOG.md`; `release.yml` still
  extracts release notes from it; Keep-a-Changelog output is preserved. Only
  how the section gets written changes.

## Considered and rejected

- **PR-description-sourced entries, compiled at the cut** — a `## Changelog`
  section in each PR body, harvested via the forge API at release. Attractive
  because it reuses an authoring moment that already exists (the PR summary)
  and makes pre-cut fixes free (edit the description, no commit). Rejected:
  the entry escapes the review boundary — mutable after approval and after
  merge, outside git until the cut, unattributable, and the compile step
  depends on the forge API. Those costs are invisible exactly as long as the
  set of people who can edit entries equals the set who would review them;
  fragments cost one extra file per PR and hold at any writer count.
- **A merge driver / union strategy for the current file** — GitHub does not
  honor custom merge drivers server-side, so the primary conflict surface (the
  rebase/update-branch path on PRs) is untouched; a union merge on an ordered
  list also silently duplicates or misorders lines. Fixes none of the guard's
  papercuts.
- **Compiling from commit messages (conventional-commits style)** — zero
  authoring cost, but couples release-notes quality to commit subjects,
  is unfixable after merge, and produces a materially worse Keep-a-Changelog
  document than deliberately written entries. The repo's entry voice
  (bolded lead, task id, prose body) does not fit a commit subject.
- **Keeping an `[Unreleased]` stub section** — see Why; a stub is dead weight
  and a live section is the defect again.

## Consequences

- New top-level `.changes/` directory (its `README.md` documents the grammar
  and is excluded from compilation and the guard's fragment match).
- `packages/bin/scripts/compile-changelog.ts` (`bun run changelog:compile`)
  owns parsing, ordering, rendering, section insertion, and fragment deletion;
  parse failures name the offending file and line. The parser is strict — an
  unknown heading or non-bullet prose is an error — and the guard runs the
  same parser (`--check`), so garbage is caught at PR time, not cut time, and
  the two can never disagree.
- `changelog-guard` keeps its applicability logic (build-affecting path list,
  `skip-changelog` label, always-runnable required check) and swaps the
  bullet-diff for fragment presence plus the `--check` parse (the parse steps
  set up Bun, so the guard job is no longer checkout-only on fragment-carrying
  PRs). A delete-only fragment change passes — that is the release-cut PR
  itself. Of the MMR-109 papercuts, the bullet-diff false PASS/FAIL are
  retired; the build-affecting path list triplication and the label
  re-trigger flash remain (unchanged scope).
- The release cut gains one mechanical step (`changelog:compile --write`) and
  loses one (hand-promoting `[Unreleased]`); its "empty section means nothing
  to ship" precondition becomes "no fragments means nothing to ship".
  `CONTRIBUTING.md` and the `finishing-work` / `release-cut` skills are
  updated to match.
- A changelog entry can no longer be edited without a commit once merged —
  accepted deliberately; pre-cut fixes are a normal (skip-labeled) PR touching
  the fragment.

---
name: finishing-work
description: The ordered gates a change clears before it's done in the mimir repo — verify, smoke, CHANGELOG, review, submit. Use when finishing a piece of work here: about to declare a task done, open a PR, or run `mimir submit`.
---

# Finishing work

`done` is the **last** gate, not the first thing you reach for. A change clears
these gates in order; the work isn't finished until every one is green. This
is this repo's process for the mimir skill's `done` claim (complete and
verified): what verification means _in this repo_, and the completion gate
that holds a task in `under_review` until merge.

## The gates

1. **Verify green** — `bun run verify` (format · lint · type · test) exits 0 with
   zero warnings. Warnings are errors here; a yellow gate is a red gate.
2. **Smoke** — run the real artifact against representative data, matched to the
   surface you touched: CLI through a pseudo-TTY, HTTP via `curl` against the
   development host (`bun run dev:ui`), UI via Playwright. Smoke against a
   throwaway store, never the live one. A source-run CLI (`bun run mimir`)
   with no sandbox authority and no `[host]` in its configuration uses the
   checkout's `.dev/store.sqlite`, whatever `HOME` and `XDG_*` say; resetting
   it, a copied build, and the project binding are in `docs/guides/development-sandboxes.md` ("Smoke-test a CLI
   build"). The
   development host uses `packages/host/.dev/host`, or a scratch
   `MIMIR_DATA_DIR`. Tests are necessary, not sufficient — smoke is where
   integration bugs surface.
3. **CHANGELOG** — the gate that gets skipped. See below.
4. **Review** — an adversarial whole-branch review (`/code-review` or a fresh
   reviewer subagent). Every finding settles before merge, with its evidence
   kept: see [Settling review findings](#settling-review-findings).
5. **Submit** — `mimir submit <id>` (→ `under_review`) and open the PR. Who
   merges follows the merge disposition an annotation on the task records
   when the work is agreed: the operator, or the agent once checks are green
   and every finding has settled. When no annotation records one, the
   operator merges.
6. **Done** — `mimir done <id>` once the PR has merged, whoever merged it.

## Settling review findings

A finding settles in one of four ways, and its evidence goes on the record
whatever the outcome: what was found, the case for acting, and the case
against. That trail is the handoff: a later session decides, or resumes, from
it without re-running the review. Findings that arrive after submit, from PR
reviewers or automated checks, settle the same way, and the task stays
`under_review` while they are fixed.

- **Fixed** in this change. The commit message names the finding and the
  evidence that made it a defect.
- **Dismissed.** Annotate the task under review with the finding, its
  evidence, and the reason it was dismissed.
- **Deferred to a task** (`mimir create task`), when the work is wanted but
  falls outside this change. The description carries the evidence that the
  change is needed, the case against it, and why that case lost.
- **Filed as a seed** (`mimir seed`), when whether to do the work at all is
  still open. The description states the open question and the evidence on
  both sides, unresolved, so the choice can be argued from the record. A
  finding for another board is a seed on that board too, stating the ask and
  the evidence behind it.

A defect in the change under review is already decided: fix it, or defer it to
a task when fixing it would break the change's scope. Seeds hold findings
beyond the change.

Evidence too long for a description or annotation goes in a frozen artifact
linked to the task that carries it: `mimir attach <id> --file …`. A seed takes
no annotations or linked artifacts, so attach a seed's evidence to the seed's
own project (`mimir attach --project <KEY> --file …`) and cite the artifact's
`KEY-aN` id in the seed's description.

## The CHANGELOG gate

A user-facing change needs a **changelog fragment** in `packages/cli/.changes/`,
in Loom's grammar (the guide is `packages/cli/.changes/README.md`; ADR 0039). The
file name is the kind, with the task id as the slug:

- `breaking.mmr-267.md` — a change a user or script must adapt to: a removed or
  renamed command, flag, or output field, or any Engine contract change,
  additive included (its migration: update the host before its clients). It
  ends with the `### Migration` section and its five labels. `changelog-guard`
  refuses an Engine schema snapshot or `MIN_CLIENT` change while no breaking
  fragment is pending.
- `feature.mmr-267.md` — something new, or a compatible change.
- `mmr-267.md` — a fix.

The body is `- ` bullets in the repo's entry voice (bolded lead, task id, prose
body), no headings except a breaking fragment's migration. Links are relative to
`packages/cli/` (`../../docs/…`). The kind decides the next version, so choose it
deliberately. Add the fragment on the branch, in the same PR — not at the release
cut. v0.12 deferred every entry to the cut and the per-PR record drifted for a
whole cycle. Never edit `packages/cli/CHANGELOG.md` directly — the release cut's
`loom changelog write` writes it; the fragment is what makes parallel PRs
conflict-free.

**Completion criterion:** either the PR adds a fragment for this change and
`bun run --cwd packages/cli loom changelog check` passes, **or** the PR carries the
`skip-changelog` label. One of the two is true before you submit — there is no
third option.

CI enforces exactly this: `changelog-guard` fails any PR touching build-affecting
paths (`packages/**`, `skills/**`, `package.json`, `bun.lock`, `Dockerfile`,
`.dockerignore`, `install.sh`, the release workflows) that touches no
`packages/cli/.changes/` fragment and has no label, and runs `loom changelog
check` on the fragments it finds, the validator the cut itself runs. The label is the **only** legitimate
way past a missing fragment.

**The escape hatch** — `skip-changelog` — is for a genuinely behavior-preserving
change (an internal refactor, a test-only or build-meta edit). Once the PR exists
(gate 5), apply it with a one-line reason; it stays visible on the PR at merge:

```bash
gh pr edit --add-label skip-changelog   # then say why in a PR comment
```

If you're reaching for the label because writing the entry is annoying, write the
entry. The hatch is for _no user-facing change_, not for _can't be bothered_.


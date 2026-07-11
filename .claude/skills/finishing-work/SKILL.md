---
name: finishing-work
description: The ordered gates a change clears before it's done in the mimir repo — verify, smoke, CHANGELOG, review, submit. Use when finishing a piece of work here: about to declare a task done, open a PR, or run `mimir submit`.
---

# Finishing work

`done` is the **last** gate, not the first thing you reach for. A change clears
these gates in order; the work isn't finished until every one is green. This
specializes the mimir skill's rule ("`done` only after verification") with what
verification means _in this repo_.

## The gates

1. **Verify green** — `bun run verify` (format · lint · type · test) exits 0 with
   zero warnings. Warnings are errors here; a yellow gate is a red gate.
2. **Smoke** — run the real artifact against representative data, matched to the
   surface you touched: CLI through a pseudo-TTY, HTTP via `curl` against a live
   `mimir serve`, UI via Playwright. Tests are necessary, not sufficient — smoke
   is where integration bugs surface.
3. **CHANGELOG** — the gate that gets skipped. See below.
4. **Review** — an adversarial whole-branch review (`/code-review` or a fresh
   reviewer subagent); every finding terminates as fixed, consciously dismissed
   with a reason, or deferred to a **task** (`mimir create task`) — never left
   open, and never parked as a seed on this board (a finding with a statable fix
   is already triaged; seeds are for cross-board asks or undecided own-board
   ideas, and a review finding is neither).
5. **Submit** — `mimir submit <id>` (→ `under_review`) and open the PR. The work is
   now Drew's to merge; you do not merge to `main`.
6. **Done** — `mimir done <id>` **only after Drew merges**, never before.

## The CHANGELOG gate

A user-facing change needs a `CHANGELOG.md` entry under `[Unreleased]`, in the right
`Added` / `Changed` / `Removed` / `Fixed` heading ([Keep a Changelog]). Add it on
the branch, in the same PR — not at the release cut. v0.12 deferred every entry to
the cut and the per-PR record drifted for a whole cycle.

**Completion criterion:** either `[Unreleased]` has gained a line for this change,
**or** the PR carries the `skip-changelog` label. One of the two is true before you
submit — there is no third option.

CI enforces exactly this: `changelog-guard` fails any PR touching build-affecting
paths (`packages/**`, `package.json`, `bun.lock`, `install.sh`, the release
workflows) that adds no `[Unreleased]` line and has no label. The label is the
**only** legitimate way past a missing entry.

**The escape hatch** — `skip-changelog` — is for a genuinely behavior-preserving
change (an internal refactor, a test-only or build-meta edit). Once the PR exists
(gate 5), apply it with a one-line reason; it stays visible on the PR at merge:

```bash
gh pr edit --add-label skip-changelog   # then say why in a PR comment
```

If you're reaching for the label because writing the entry is annoying, write the
entry. The hatch is for _no user-facing change_, not for _can't be bothered_.

[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/

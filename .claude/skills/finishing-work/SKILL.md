---
name: finishing-work
description: The ordered gates a change clears before it's done in the mimir repo — verify, smoke, CHANGELOG, review, submit. Use when finishing a piece of work here: about to declare a task done, open a PR, or run `mimir submit`.
---

# Finishing work

`done` is the **last** gate, not the first thing you reach for. A change clears
these gates in order; the work isn't finished until every one is green. This
specializes the mimir skill's rule (`done` after verification, with the
project's own completion gate taking precedence) with what verification means
_in this repo_.

## The gates

1. **Verify green** — `bun run verify` (format · lint · type · test) exits 0 with
   zero warnings. Warnings are errors here; a yellow gate is a red gate.
2. **Smoke** — run the real artifact against representative data, matched to the
   surface you touched: CLI through a pseudo-TTY, HTTP via `curl` against the
   development host (`bun run dev:ui`), UI via Playwright. Smoke against a
   throwaway store (a sandbox installation for the CLI, a scratch
   `MIMIR_DATA_DIR` for the host), never the live one. Tests are
   necessary, not sufficient — smoke is where integration bugs surface.
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

A user-facing change needs a **changelog fragment** in `packages/cli/.changes/`,
in Loom's grammar (the guide is `packages/cli/.changes/README.md`; ADR 0039). The
file name is the kind, with the task id as the slug:

- `breaking.mmr-267.md` — a change a user or script must adapt to: a removed or
  renamed command, flag, or output field, or an Engine contract change. It ends
  with the `### Migration` section and its five labels.
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
paths (`packages/**`, `skills/mimir/**`, `package.json`, `bun.lock`,
`install.sh`, the release workflows) that touches no `packages/cli/.changes/`
fragment and has no label, and runs `loom changelog check` on the fragments it
finds, the validator the cut itself runs. The label is the **only** legitimate
way past a missing fragment.

**The escape hatch** — `skip-changelog` — is for a genuinely behavior-preserving
change (an internal refactor, a test-only or build-meta edit). Once the PR exists
(gate 5), apply it with a one-line reason; it stays visible on the PR at merge:

```bash
gh pr edit --add-label skip-changelog   # then say why in a PR comment
```

If you're reaching for the label because writing the entry is annoying, write the
entry. The hatch is for _no user-facing change_, not for _can't be bothered_.


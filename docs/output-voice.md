---
title: 'mimir Output Voice Guide'
status: accepted
date: 2026-07-16
---

# mimir Output Voice Guide

How mimir's output **speaks**. Companion to the
[Output Contract Reference](output-contract-reference.md), which governs what
the output _is_ — formats, envelopes, exit codes, streams; this guide governs
tone, mood, casing, tags, separators, and message grammar. The contract
reference's deferred "branding/voice pass" is this document (settled at
MMR-213). Where the two could conflict, the contract reference and its ADRs
win — voice styles messages, it never changes shape.

Scope: every human-facing string on every transport — CLI message/hint lines,
help text, table headers, and the `message`/`hint` fields of the shared error
envelope (which the CLI, MCP, and HTTP surfaces carry verbatim). Structured
formats (`ids`/`json`/`jsonl`) never carry style, but their `message` strings
follow this guide's grammar. **Warnings are the non-fatal sibling of
errors** and follow every rule here: same message grammar, and their
`note:` line carries the correction itself (`note: expected p0, p1, p2, p3`)
— the statable-fix rung of the hint ladder.

## First principle: always helpful

**An error without a next move is an incomplete message.** Every usage,
not-found, wrong-type, and validation error carries a hint line with the best
next step; even internal or store failures point somewhere (`note: run
'mimir doctor'`). Every other rule below serves this one.

## Mood: fact, then remediation

- **The message line states a fact** — about the world or the operation:
  `started MMR-277 · todo → in_progress`, `MMR-9 doesn't exist`. Always
  declarative. No subject pronouns ("I", "you", "we"), no exclamation, no
  apology, no celebration. The tool is an instrument reporting state, not an
  assistant conversing.
- **The hint line (`note:`) is the only home of imperatives** — remediation
  is inherently an instruction: `note: run 'mimir get -h' for its flags`.
  This `note:`-only rule scopes to error output (the message + hint pair); a
  report or orientation body (overview's hygiene rows, the MMR-184 trailer) may
  carry a row-bound inline pointer in the `fact — next move` shape (`2 untriaged
seeds — run 'mimir triage MMR'`).
- **Questions are allowed only as suggestion hints** — `did you mean
'status'?` lives in the hint slot, nowhere else.

## Casing and punctuation

- **Lowercase-initial everywhere** — messages, hints, help summaries, section
  headers (`untriaged (3)`, never `UNTRIAGED (3)`). Emphasis is color/bold's
  job, never the shift key.
- Ids keep their casing (`MMR-42`). Tool names follow their own style guides:
  `norn` and `mimir` are always lowercase, even sentence-initial.
- **No trailing periods on any single-line output** — messages, hints, help
  fragments in both help tiers. The `-h`/`--help` tiers differ in coverage,
  never in punctuation.
- **Single-quote a literal named in prose** — a command, flag, or value
  referred to inside a sentence: `did you mean 'status'?`. Structural
  operands are not prose and stay unquoted: transition and arrow operands
  (`todo → in_progress`), `·`-separated clauses, and a runnable command
  after a statable-fix hint (`note: create it: mimir create project …`).

## Tags: a two-tier grammar

- **Tier 1 — universal outcomes, exactly three:** `[ok]`, `[err]`, `[warn]`
  (glyphs `✓`/`✗`/`⚠` in styled output; the bracket word is the ASCII form).
  Short spellings always — never `[error]`. Only tier 1 tags carry color and
  glyph.
- **Tier 2 — domain tags:** a lowercase bracketed word or short phrase with
  no glyph, for a stage/outcome vocabulary a command owns (doctor repair's
  `[planned]` `[fixed]` `[skipped]` `[failed]` `[detail]`; triage's
  `[dry run — no annotations written]`). Styled output may render a tier-2
  tag dim and parenthesized; the bracket form is the plain rendering.
  Extensible, but a domain vocabulary never restyles a tier-1 meaning — a
  command's terminal verdict is always tier 1.
- **Progress and info lines are plain** — no tag (`updating 0.15.0 → 0.16.0`).
  Tags mark outcomes and findings, not narration.
- **All tags render through the shared render helpers.** Inline escape-code
  literals are a defect, not a style choice.

## Separators and arrows

- **`·` is the clause separator** — it joins independent facts on one line:
  `started MMR-277 · todo → in_progress`, `plist X · log Y`. Never use `·`
  inside a clause; a clause that seems to need one gets reworded. `·` keeps
  its glyph in plain output — it separates and carries no information, so
  no ASCII form is needed.
- **Arrows are `→` styled, `->` plain**, rendered by a shared helper, and
  **always read left to right — never a right-to-left arrow**. Transitions
  read old → new (`todo → in_progress`); other arrows read subject →
  destination (`moved MMR-1 → MMR-2`). Arrows carry direction — real
  information — which is why they swap under `--ascii` while `·` doesn't.
  A relation that reads backwards is reworded by reordering its operands,
  never by flipping the glyph.

## Message grammar

- **Name the offending token as the subject** whenever one exists:
  `MMR-9 doesn't exist` — never `the record was not found` (buries the
  subject) or `no project MMR` (a headline, not a sentence). Wrong-type
  follows the same shape: `MMR-9 is a project, not a task`.
- **Contractions are house voice**: `doesn't exist`, not `does not exist`.
- **Constraint violations state the constraint, never the operator's fault**:
  `a task cannot depend on itself`, `cross-project move is not supported`.
- **Failed operations state the outcome with a definite article**:
  `the seed write did not complete`.
- **Terminology is the domain model's**: `project` / `initiative` / `phase` /
  `task` / `artifact` / `seed`; `id`, never `identifier`; `status`, never
  `state`.
- **Mutation echoes**: lowercase past-tense verb, id, then `·`-separated
  clauses — `submitted MMR-277 · in_progress → under_review`, with reasons
  appended as their own clause.

## The hint ladder

One hint per error — the most specific rung that applies, never zero
(first principle), never two:

1. **The statable fix**, when the command knows it:
   `note: create it: mimir create project …`
2. **The near-match suggestion**, when an edit-distance candidate exists:
   `note: did you mean '--force'?`
3. **The narrowest help pointer** otherwise: `note: run 'mimir <cmd> -h' for
its flags` when the command is known; `note: run 'mimir --help' to see
the commands` when it isn't.

For a constraint error with no remediation (`cross-project move is not
supported`), the hint names the nearest supported alternative — still one
move (`note: create a task in the target project instead`). A help pointer
that adds nothing is filler, not help; helpfulness is the measure, not the
mere presence of a `note:` line.

**Library text never ships.** Every argument-parse failure is intercepted and
re-synthesized in house voice (`unknown flag '--unknwon'`, `'--to' expects a
value`); a runtime library's message is an implementation detail, same as a
stack trace — it appears in no output, including a structured envelope's
`message` field.

## Before / after

| today                                                                                 | under this guide                                               |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `the record was not found`                                                            | `MMR-9 doesn't exist`                                          |
| `no project MMR`                                                                      | `MMR doesn't exist`                                            |
| `UNTRIAGED (3)`                                                                       | `untriaged (3)`                                                |
| `[error] MMR-4: duplicate stem (…)`                                                   | `[err] MMR-4: duplicate stem (…)`                              |
| `Unknown option '--unknwon'. To specify a positional argument starting with a '-', …` | `unknown flag '--unknwon'` + `note: did you mean '--unknown'?` |
| triage's `task ← upstream` relation                                                   | operands reordered to read left to right                       |
| `begin a task (todo → in_progress).` (help summary)                                   | `begin a task (todo → in_progress)`                            |

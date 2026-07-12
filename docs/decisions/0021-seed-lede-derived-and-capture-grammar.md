---
title: 'ADR 0021: Seed lede is derived at read; capture is one blob'
status: accepted
date: 2026-07-12
---

# ADR 0021: Seed lede is derived at read; capture is one blob

A seed's body is made first-class through two independent moves, neither of
which changes storage:

- **(read) The lede is derived at read time**, never stored. The seeds list path
  batch-reads the `## Seed Description` section for the **live** seeds in one
  native section read (`vault.get { section }`, [ADR
  0016](0016-norn-vault-system-of-record.md)) and derives a bounded `lede`
  server-side in one core function shared by every transport. The lede rides the
  CLI queue rendering, the triage report, and the HTTP list wire (the console's
  2-line preview). `lede` rides **only live list rows**: settled rows and the
  detail read omit it — the detail read carries the full `description`, which is
  how a settled seed's body (and any preview of it) is fetched on demand.
  Nothing is stored — no schema field, no frontmatter projection, no doctor
  check.

- **(write) Capture is one text blob with commit-message semantics.** The first
  line is the title, the rest is the body, split at the first newline —
  uniformly across the console capture popover, the CLI `seed` verb, and MCP. An
  explicit `--desc` wins over the split. A hard title-length cap **errors** with
  copy that teaches the split; `update --title` inherits the cap.

## Why

Every seed filed before this change carried its whole body in the title; none
used a description. The cause is structural, not behavioral: the description
lives as a body section while frontmatter is the indexed record, so no routine
read ever surfaced the body — the title was the only field guaranteed to be
seen, so all prose migrated there.

- **Derive, don't store** (the spine). The lede is a read-time projection of the
  body, single-sourced in one function so every surface shows the same preview
  and none re-derive. `vault.get` is batched (many targets, one round-trip) and
  norn slices named sections natively, so one extra section read covers the
  entire live queue. Poll cost scales with the live queue (kept small), not with
  history — the batch excludes settled seeds by construction.
- **The grammar decides where prose goes, not the author.** Capture is one blob;
  the first-newline split removes the title-vs-description choice that caused the
  bloat. A single line longer than the cap **errors** rather than warns —
  agents respond to errors, not guidance; a warning would preserve the status
  quo.

## Spec-at-phase settlements

- **Lede budget: 240 characters, ellipsis included.** The derivation normalizes
  whitespace runs (including newlines) to single spaces, trims, and cuts at the
  last word boundary that keeps the result — trailing ellipsis included — within
  the budget, so the returned lede never exceeds 240 characters. A character
  budget (not a line count) keeps the derivation transport-neutral; the console
  applies its own 2-line CSS clamp on top.
- **The plain `mimir seeds` table shows the lede** (as a dimmed second line under
  each live row), not only `--grouped`. The queue's purpose is to surface the
  prose that used to hide in the detail read, so gating it behind a flag would
  leave the default view blind.
- **Title cap: 120 characters**, a hard error across CLI, MCP, HTTP, and the
  popover; `update --title` inherits it.

## Considered and rejected

- **A stored frontmatter lede (derived at write).** Violates derive-don't-store,
  adds a schema field and a write-path coupling, and introduces hand-edit drift
  that would need a `mimir doctor` check — all to cache something the read path
  fetches in one batched round-trip.
- **Body in frontmatter.** Degrades norn's document caching, bloats every
  `vault.find` payload unboundedly, and destroys the vault's legibility (prose in
  YAML block scalars instead of rendered markdown). The body stays a markdown
  section; the lede is a bounded read-time slice of it.
- **A title cap as a warning, not an error.** A warning is ignorable, so the
  bloat persists. The forcing function is the hard error plus copy that teaches
  the first-newline split.

## Consequences

- A new read-only `SeedStore.loadDescriptions` seam batch-reads the
  `## Seed Description` for many seeds in one native section read (the norn arm;
  the retiring SQLite arm throws, as every seed method does). `listSeeds`
  attaches the derived lede to its live rows from that one batch; the triage
  report inherits it (it reads through `listSeeds`). The lede is decorative, so
  a rejected batch read never aborts the queue: the live rows degrade to
  `lede: null` with a stderr note ([ADR 0017](0017-runtime-data-tolerance.md)'s
  diagnosability rule — degraded, never silent).
- `SeedView` gains an optional `lede` (present on live list rows, absent on the
  detail read and on settled rows); `seedToWire` emits it when present. The
  full `description` continues to ride only the content/detail read.
- Capture and `update --title` share one core validation for the first-newline
  split and the title cap, so CLI, MCP, HTTP, and the console popover cannot
  drift. This settles the visibility and capture halves of the seeds body work.

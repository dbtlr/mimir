---
title: 'ADR 0027: Scratchpads are temporary episode state'
status: accepted
date: 2026-08-01
---

# ADR 0027: Scratchpads are temporary episode state

A **Scratchpad** is a project-anchored, temporary working document for an
unsettled episode such as shaping, grilling, planning, investigation, or task
execution. It is not a task, seed, or mutable artifact. An active scratchpad
holds an append-only numbered Journal and a constrained numbered Agenda; a
single canonical `ScratchpadService` owns every mutation and all transports are
thin mappings into it.

Scratchpads live at `scratch/<uuid>.md`, use a runtime-generated UUID rather
than Mimir's sequenced durable identity grammar, and appear in the default
Overview so a fresh agent can recover them after compaction. Each belongs to
exactly one project. Multi-project scratchpads, concurrent-writer coordination,
session ownership fields, and console UI are excluded until concrete use earns
them.

An episode ends in one of two ways. **Freeze** stages the scratchpad against
further writes, creates a complete normally allocated Artifact with a required
summary, `scratchpad` tag, inherited project/anchors, and `source_scratch`
provenance, then deletes the temporary document. **Discard** deletes it after
checking for unresolved Agenda items; `--force` with a reason overrides that
refusal. Norn is atomic per document rather than across documents, so freeze is
an idempotent recovery protocol (`freezing_at` → artifact creation → scratch
deletion), not a falsely transactional multi-file operation.

## Why

Long design and execution conversations can compact before they settle. Tasks
and Seeds require durable work/intake commitments that may not exist yet;
Annotations require an existing work item or Seed; Artifacts are intentionally
frozen and must remain self-contained. Scratchpads fill that resumability gap
without weakening any existing primitive or retaining every abandoned
exploration forever.

## Considered and rejected

- **Mutable or in-progress Artifacts** — rejected because every Artifact reader
  would need to distinguish authoritative content from changing content.
- **Task/Seed annotations** — rejected as the only home because an episode may
  start before either entity exists and may span several pieces of linked work.
- **Keeping a terminal scratch record after freeze** — rejected because scratch
  is staging state; the resulting Artifact is the durable record.
- **A shell Artifact pointing at frozen scratch content** — rejected because it
  would introduce a second, indirect Artifact body contract. The Artifact
  receives a complete snapshot instead.
- **Cross-document atomic freeze** — unavailable by Norn's deliberate safety
  posture. The staged, retryable protocol provides the needed application-level
  guarantee without reopening that platform trade-off.

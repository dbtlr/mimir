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

## Refinement (2026-11-16, MMR-691): a delivery's journal

A delivery ([ADR 0042](0042-the-delivery-record.md)) is an episode, so its
**run journal** is a Scratchpad anchored to it. The run journal is the whole
pad; the pad's numbered Journal above is one of its sections.

- **The anchor.** `scratch create --link KEY-dN` and `scratch update --link
  KEY-dN` accept one delivery id beside node links. The pad stores it in its
  own `delivery` field, so `anchors` keeps holding node ids only. A second
  delivery id in one call is `validation`, and so is a delivery in another
  project.
- **Update.** An update that passes no `--link` and no `--clear-links` leaves
  both the node anchors and the delivery as they are, so a title-only update
  keeps the journal's delivery. An update that passes `--link` replaces both
  together with what it names, so a `--link` set with no delivery id clears
  the delivery. `--clear-links` clears both.
- **One live journal per delivery.** A create or update that would give a
  delivery a second live pad refuses as `conflict`, naming the pad that holds
  it. After that pad is frozen or discarded, a new pad may anchor the delivery.
  The delivery may be in any lifecycle.
- **Freeze.** Freeze copies the pad's delivery onto the new artifact's
  `delivery` field, and links the artifact to the pad's node anchors plus every
  task that was ever a member of the delivery: each task named by a `member`
  row in its history, whatever happened to it since. Membership is read in the
  transaction that creates the artifact. A retried freeze recovers that
  artifact, as the protocol above does, so its links are the membership at
  first creation; a task that joins later is not added. The links are a set,
  read in the artifact's canonical link order like every artifact's.
- **Who freezes.** By convention the delivery's orchestrator freezes the
  journal at close-out. Mimir does not enforce who, as no pad has an owner.
  `land` and `abandon` do not touch the pad, so each keeps its own
  transaction. A terminal delivery whose journal is still live shows it as
  `journal` on `get`, and the pad stays in the overview's active Scratchpads,
  which is the reminder.
- **Reads.** A pad's views (`scratch get`, `scratch list`, the overview row)
  gain `delivery`, null when none. An artifact's views gain `delivery`, null
  when none. `update` cannot change an artifact's delivery: the artifact is
  frozen ([ADR 0004](0004-artifact-model-project-anchored-flexibly-linked.md)).
- **Transfer.** The export carries the pad's and the artifact's `delivery`, and
  its schema version increments with the MMR-691 delivery lists. Import refuses,
  and doctor reports, a `delivery` that is missing or in another project, and
  two live pads on one delivery.
- **Console.** The journal is shown read-only on the delivery page (MMR-680),
  which is the concrete use this ADR waited for before giving Scratchpads any
  console UI. This refinement adds no console surface itself.

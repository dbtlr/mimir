import type { NodeType } from './enums';

/**
 * The data-plane field facts (ADR 0025) — the pure-fact half of the field spec,
 * lifted here so every consumer (the binary transports today, the UI tomorrow)
 * reads one declaration. This module is data only: field keys, the **kind**
 * *name* each field declares, node applicability, `update` participation, and
 * the read-required flag. The kind's parser/emitter pair, its wire schema
 * fragment, and its query projection are code bindings and live in the core
 * (`core/field-spec.ts`); the core composes these facts with those bindings.
 *
 * The identity/topology plane — id, type, parent, rank, tags, the timestamps,
 * transition history, body sections, and the always-present `title` — is NOT a
 * fact here: those are what make a node a node in the graph, they have their own
 * verbs, and their decode is inherent structural work (ADR 0025 Decision 1).
 */

/** The data-plane field keys — the external snake_case names, which double as the
 * frontmatter keys and the query field names (no second vocabulary). */
export type DataFieldKey =
  | 'summary'
  | 'lifecycle'
  | 'hold'
  | 'hold_reason'
  | 'priority'
  | 'size'
  | 'external_ref'
  | 'upstream'
  | 'target'
  | 'open_ended';

/** A field **kind** *name* — the pure-fact half of a kind (ADR 0025 Decision 2).
 * The name selects the parser/emitter pair, wire schema fragment, and query
 * semantics, all of which live as code bindings in the core kind registry. */
export type FieldKindName =
  | 'string'
  | 'seed-ref'
  | 'bool'
  | 'enum:priority'
  | 'enum:size'
  | 'enum:lifecycle'
  | 'enum:hold';

/**
 * One data-plane field's pure facts. `update` names the camelCase generic-`update`
 * arg the field contributes (absent for the status axes, which have their own
 * verbs); it is a bare string here because the core owns the precise
 * `UpdateFieldKey` union — the core re-narrows it and compile-checks completeness.
 */
export type FieldFact = {
  key: DataFieldKey;
  kind: FieldKindName;
  /** Node types that carry the field — the codec type-gate AND the update gate. */
  appliesTo: readonly NodeType[];
  /** The camelCase `UpdateFields` arg name, present when the generic `update` verb
   * owns the field; absent for the status axes. */
  update?: string;
  /** A field an applicable node MUST carry post-validation (only `lifecycle`). */
  required?: boolean;
};

const TASK = ['task'] as const;
const CONTAINERS = ['phase', 'initiative'] as const;
const ALL_TYPES = ['task', 'phase', 'initiative'] as const;

/**
 * The data-plane field facts — one entry per field, alphabetical by key. The
 * codec (both directions), the update gates, the query registry, and the three
 * transport surfaces all derive from this one table. `as const` keeps each
 * entry's `update` literal so the core can extract the precise `UpdateFieldKey`
 * union it compile-checks its `UpdateFields` vocabulary against (ADR 0025).
 */
export const FIELD_FACTS = {
  external_ref: { appliesTo: TASK, key: 'external_ref', kind: 'string', update: 'externalRef' },
  hold: { appliesTo: TASK, key: 'hold', kind: 'enum:hold' },
  hold_reason: { appliesTo: TASK, key: 'hold_reason', kind: 'string' },
  lifecycle: { appliesTo: TASK, key: 'lifecycle', kind: 'enum:lifecycle', required: true },
  open_ended: { appliesTo: CONTAINERS, key: 'open_ended', kind: 'bool', update: 'openEnded' },
  priority: { appliesTo: TASK, key: 'priority', kind: 'enum:priority', update: 'priority' },
  size: { appliesTo: TASK, key: 'size', kind: 'enum:size', update: 'size' },
  summary: { appliesTo: ALL_TYPES, key: 'summary', kind: 'string', update: 'summary' },
  target: { appliesTo: ['phase'], key: 'target', kind: 'string', update: 'target' },
  upstream: { appliesTo: TASK, key: 'upstream', kind: 'seed-ref', update: 'upstream' },
} as const satisfies Record<DataFieldKey, FieldFact>;

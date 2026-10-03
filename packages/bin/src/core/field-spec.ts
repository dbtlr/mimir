import {
  FIELD_FACTS,
  HOLD_VALUES,
  LIFECYCLE_VALUES,
  PRIORITY_VALUES,
  SIZE_VALUES,
} from '@mimir/contract';
import type { DataFieldKey, FieldKindName, NodeType, Priority, Size } from '@mimir/contract';
import { isMember } from '@mimir/helpers';

import { invariant, validation } from './errors';
import { parseUpstreamField, UPSTREAM_CLEAR } from './ids';
import type { UpdateFieldKey, UpdateFields } from './mutations/data';

/**
 * The data-plane kind registry (ADR 0025) — the code bindings that compose with
 * the pure field facts in `@mimir/contract` ({@link FIELD_FACTS}, re-exported
 * here as {@link FIELD_SPEC}) to form the field spec every data-plane surface
 * derives from: the `update` applicability gates (`mutations/data.ts`), the
 * query registry (`query.ts`), and the three transport surfaces (CLI flags, MCP
 * zod fragments, HTTP body allow-lists). Each field names a **kind**; the kind
 * ({@link FIELD_KINDS}) owns the wire parser and the query semantics — kinds
 * are where code lives, fields are pure data (ADR 0025 Decision 2). Facts live in the contract so any consumer (including the UI) can
 * read them; this module holds only the bindings and the derivations.
 *
 * The identity/topology plane — id, type, parent, rank, tags, the timestamps
 * (`created_at`/`updated_at`/`completed_at`), transition history, and body
 * sections — is NOT here: those are what make a node a node in the graph, they
 * have their own verbs, and their handling is inherent structural work. They
 * stay bespoke (ADR 0025 Decision 1). `title` likewise stays structural:
 * it is always-present node identity (never omit-empty) and its `update`
 * applicability spans the non-node kinds (project/artifact/seed), which this
 * node-typed spec does not model.
 */

export type { DataFieldKey, FieldKindName } from '@mimir/contract';

// ─── Wire parsers ───────────────────────────────────────────────────────────

/**
 * Validate a raw priority token against the enum — the one `invalid
 * priority: <x>` assert every transport shares (create, update, and promote
 * paths alike, MMR-306). `undefined` passes through untouched (no change).
 */
export function parsePriorityValue(value: string | undefined): Priority | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isMember(value, PRIORITY_VALUES)) {
    throw validation(`invalid priority: ${value}`, `priorities: ${PRIORITY_VALUES.join(', ')}`);
  }
  return value;
}

/**
 * Validate a raw size token against the enum — the shared `invalid size:
 * <x>` assert (MMR-306), sibling to {@link parsePriorityValue}.
 */
export function parseSizeValue(value: string | undefined): Size | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isMember(value, SIZE_VALUES)) {
    throw validation(`invalid size: ${value}`, `sizes: ${SIZE_VALUES.join(', ')}`);
  }
  return value;
}

/**
 * Parse the raw `upstream` wire token: `KEY-sN` passes through, the `none`
 * sentinel clears (MMR-301), anything else is rejected in shared wording.
 * Exported as the single wire parser — the MCP update path shares it, so the
 * wording can't drift between create and update.
 */
export function parseUpstreamValue(value: string | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = parseUpstreamField(value);
  if (parsed === undefined) {
    throw validation(
      `upstream must be a seed id (KEY-sN) or '${UPSTREAM_CLEAR}' to clear, got ${value}`,
    );
  }
  return parsed;
}

// ─── The kind registry ──────────────────────────────────────────────────────

/** The query-registry projection of a kind — `null` when the field isn't queryable. */
type QueryProjection = { kind: 'enum'; values: readonly string[] } | { kind: 'string' };

/** The value a kind's wire parser yields — the scalar a transport assigns into
 * {@link UpdateFields} (`null` is the seed-ref clear). */
export type WireValue = string | boolean | null;

/**
 * A field **kind** — the query semantics and wire parser a field declares by
 * name (ADR 0025 Decision 2). `query` is the registry projection; `wire` parses
 * a raw transport token into the {@link UpdateFields} value (the `update` write
 * plane), reusing the kind's parse binding so every transport shares one
 * grammar and error wording. `wire` is `null` for a kind read
 * natively by every transport (the status axes, which have no generic `update`,
 * and `bool`, whose value arrives already typed) — those never route through it.
 */
type FieldKind = {
  query: QueryProjection | null;
  /** Raw transport token → {@link UpdateFields} value, or `null` for a natively-read
   * kind (see {@link parseWireField}). */
  wire: ((value: string) => WireValue) | null;
};

const FIELD_KINDS: Record<FieldKindName, FieldKind> = {
  bool: {
    query: null,
    // A bool arrives already typed on every transport (the CLI flag pair, the MCP
    // boolean arg, the HTTP boolean body field), so it is read natively, not here.
    wire: null,
  },
  'enum:hold': {
    query: { kind: 'enum', values: HOLD_VALUES },
    // A status axis with its own verbs — no generic `update` plane.
    wire: null,
  },
  'enum:lifecycle': {
    query: { kind: 'enum', values: LIFECYCLE_VALUES },
    wire: null,
  },
  'enum:priority': {
    query: { kind: 'enum', values: PRIORITY_VALUES },
    // The shared priority assert — one wording across create/update/promote.
    wire: (value) => parsePriorityValue(value) ?? null,
  },
  'enum:size': {
    query: { kind: 'enum', values: SIZE_VALUES },
    wire: (value) => parseSizeValue(value) ?? null,
  },
  'seed-ref': {
    query: { kind: 'string' },
    // `KEY-sN` passes through, `none` clears (→ null), anything else is rejected.
    wire: (value) => parseUpstreamValue(value) ?? null,
  },
  string: {
    query: { kind: 'string' },
    wire: (value) => value,
  },
};

// ─── The field spec (facts from contract, bindings above) ───────────────────

/**
 * The data-plane field spec — the pure facts ({@link FIELD_FACTS} in
 * `@mimir/contract`) under the core's name. Re-exported so core consumers and
 * the transports keep one import site; the `as const` type is preserved through
 * the alias, so {@link SpecUpdateKey} still extracts the precise `update` union.
 */
export const FIELD_SPEC = FIELD_FACTS;

/**
 * One data-plane field's declaration, core-narrowed: the contract fact with its
 * `update` marker tied to the precise {@link UpdateFieldKey} union (the fact
 * carries it as a bare string, since the contract can't reach the core's update
 * vocabulary). Assigning {@link FIELD_SPEC}'s entries to this type re-checks that
 * every `update` literal is a real `UpdateFieldKey`.
 */
type DataFieldSpec = {
  key: DataFieldKey;
  kind: FieldKindName;
  /** Node types that carry the field — the import type-gate AND the update gate. */
  appliesTo: readonly NodeType[];
  /** The camelCase `UpdateFields` key, present when the generic `update` verb owns
   * the field; absent for the status axes, which have their own verbs. */
  update?: UpdateFieldKey;
  /** A field an applicable node MUST carry (only `lifecycle`); a transfer import
   * refuses a node without it. */
  required?: boolean;
};

/** The precise union of camelCase `UpdateFields` keys the spec's data fields own —
 * extracted from the `as const` facts so a caller can compile-check completeness. */
export type SpecUpdateKey = {
  [K in DataFieldKey]: (typeof FIELD_SPEC)[K] extends {
    readonly update: infer U extends UpdateFieldKey;
  }
    ? U
    : never;
}[DataFieldKey];

/** The spec entries in canonical (alphabetical-key) order, core-narrowed. */
const FIELD_SPEC_ENTRIES: readonly DataFieldSpec[] = Object.values(FIELD_SPEC);

// ─── Derived: the update applicability gates ────────────────────────────────

/** The camelCase `update` keys of the spec's data fields — the generic `update`
 * vocabulary the node contributes (title/description are structural, added by
 * `mutations/data.ts`). */
export const SPEC_UPDATE_KEYS: readonly UpdateFieldKey[] = FIELD_SPEC_ENTRIES.flatMap((spec) =>
  spec.update === undefined ? [] : [spec.update],
);

/** One data-plane field the generic `update` verb owns — the fact triple the
 * transport surfaces derive from: `key` is the snake_case body/column name
 * (HTTP), `update` the camelCase arg name (CLI flags, MCP args), `kind` selects
 * the wire type. */
export type SpecUpdateField = { key: DataFieldKey; kind: FieldKindName; update: UpdateFieldKey };

/**
 * The generic-`update` spec fields in canonical order (ADR 0025) — the single
 * source the three transport surfaces derive their field portion from: the CLI
 * flag template, the MCP `update`/`create` zod fragments, and the HTTP body
 * allow-lists. A new spec entry with an `update` key joins all three with no
 * transport edit.
 */
export const SPEC_UPDATE_FIELDS: readonly SpecUpdateField[] = FIELD_SPEC_ENTRIES.flatMap((spec) =>
  spec.update === undefined ? [] : [{ key: spec.key, kind: spec.kind, update: spec.update }],
);

/**
 * The {@link SpecUpdateField} triples for a NAMED subset of data-plane keys, in
 * canonical order (ADR 0026) — the derivation an operation's extra-args fact
 * ({@link OpFact.fields}, only `start`'s resume handles today) feeds the same
 * three transport surfaces `update` derives from, so a verb that records fields
 * at its transition shares one grammar, one wire parser, and one flag spelling
 * with the generic patch. A named key with no `update` marker is a registry
 * wiring bug — it has no transport arg to derive — and is refused here.
 */
export function specUpdateFields(keys: readonly DataFieldKey[]): readonly SpecUpdateField[] {
  const wanted = new Set<DataFieldKey>(keys);
  const fields = SPEC_UPDATE_FIELDS.filter((field) => wanted.delete(field.key));
  if (wanted.size > 0) {
    throw invariant(
      `${[...wanted].join(', ')} has no generic-update arg to derive`,
      'an operation may only name data-plane fields the generic `update` verb owns',
    );
  }
  return fields;
}

/**
 * Parse a raw wire token into a field kind's {@link UpdateFields} value (ADR
 * 0025) — the one parser the CLI/MCP/HTTP update paths share, so a kind's accepted
 * grammar and its stored value can't drift between transports. Delegates to the
 * kind's existing parse binding ({@link parsePriorityValue} et al.), so error
 * wording stays byte-identical. Throws for a kind with no wire parser (the status
 * axes and `bool`, read natively by every transport) — reaching it is a transport
 * wiring bug, not a value fault.
 */
export function parseWireField(kind: FieldKindName, value: string): WireValue {
  const parse = FIELD_KINDS[kind].wire;
  if (parse === null) {
    throw invariant(
      `field kind ${kind} has no wire parser`,
      'a natively-read kind (bool or a status axis) is handled by the transport reader, not routed here',
    );
  }
  return parse(value);
}

/**
 * Apply the generic-`update` spec fields to an {@link UpdateFields} patch (ADR
 * 0025) — the shared loop each transport's update path runs so a new spec field
 * lands with no per-field edit, closing the accept-without-apply gap that deriving
 * only the accepted set would leave. For each spec field, `read` returns the parsed
 * value (the transport read its native key and parsed via {@link parseWireField},
 * or via its own bespoke reader for a natively-typed / idiosyncratic field) or
 * `undefined` to leave the field untouched. Returns the applied fields in canonical
 * order — the CLI's `changed` echo derives from it.
 *
 * `over` narrows the loop to a SUBSET of the spec fields — how the uniform verbs
 * that record extra fields at their transition (`start`'s resume handles, ADR
 * 0026) reuse the identical read/parse/apply machinery the generic patch uses.
 * It defaults to the whole {@link SPEC_UPDATE_FIELDS}, the `update` plane.
 */
export function applyUpdateFields(
  fields: UpdateFields,
  read: (field: SpecUpdateField) => WireValue | undefined,
  over: readonly SpecUpdateField[] = SPEC_UPDATE_FIELDS,
): SpecUpdateField[] {
  const applied: SpecUpdateField[] = [];
  for (const field of over) {
    const value = read(field);
    if (value === undefined) {
      continue;
    }
    // The kind's wire parser yields exactly `field.update`'s value type (the spec
    // pairs kind ↔ update key); the precise-key assignment the checker can't prove
    // across the union is sound.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    (fields as Record<string, WireValue>)[field.update] = value;
    applied.push(field);
  }
  return applied;
}

/** The `update` keys of fields that apply to exactly the given node types — the
 * data source for `updateNode`'s type gates (the imperative `wantsTaskField`
 * sweep and its siblings). */
export function updateKeysForTypes(types: readonly NodeType[]): readonly UpdateFieldKey[] {
  const wanted = new Set<NodeType>(types);
  return FIELD_SPEC_ENTRIES.flatMap((spec) =>
    spec.update !== undefined &&
    spec.appliesTo.length === wanted.size &&
    spec.appliesTo.every((t) => wanted.has(t))
      ? [spec.update]
      : [],
  );
}

// ─── Derived: the query registry ────────────────────────────────────────────

/** The query-registry entry shape (mirrors `query.ts`'s local `FieldSpec`). */
type QueryFieldEntry = { kind: 'enum' | 'string'; values?: readonly string[] };

/**
 * The queryable data-plane fields projected to query-registry entries (ADR 0025)
 * — the half of `QUERY_FIELDS` that derives from the spec. The structural query
 * fields (id, parent, type, tag, status, timestamps) are added bespoke in
 * `query.ts`; `open_ended` is absent here because its kind is not queryable.
 */
export function dataQueryFields(): Record<string, QueryFieldEntry> {
  const fields: Record<string, QueryFieldEntry> = {};
  for (const spec of FIELD_SPEC_ENTRIES) {
    const projection = FIELD_KINDS[spec.kind].query;
    if (projection === null) {
      continue;
    }
    fields[spec.key] =
      projection.kind === 'enum' ? { kind: 'enum', values: projection.values } : { kind: 'string' };
  }
  return fields;
}

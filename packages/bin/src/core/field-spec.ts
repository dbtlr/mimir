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
import { parseSeedRef, parseUpstreamField, UPSTREAM_CLEAR } from './ids';
import type { Node } from './model';
import type { UpdateFieldKey } from './mutations/data';
import { collapse } from './store-norn/decode';

/**
 * The data-plane kind registry (ADR 0025) — the code bindings that compose with
 * the pure field facts in `@mimir/contract` ({@link FIELD_FACTS}, re-exported
 * here as {@link FIELD_SPEC}) to form the field spec every data-plane surface
 * derives from: the frontmatter codec (decode in `store-norn/store.ts`, emit in
 * `vault-frontmatter.ts` — the inverse pair ceases to exist as a hand-synced
 * pair), the `update` applicability gates (`mutations/data.ts`), the query
 * registry (`query.ts`), and the three transport surfaces (CLI flags, MCP zod
 * fragments, HTTP body allow-lists). Each field names a **kind**; the kind
 * ({@link FIELD_KINDS}) owns the parser/emitter pair, the wire parser, and the
 * query semantics — kinds are where code lives, fields are pure data (ADR 0025
 * Decision 2). Facts live in the contract so any consumer (including the UI) can
 * read them; this module holds only the bindings and the derivations.
 *
 * The identity/topology plane — id, type, parent, rank, tags, the timestamps
 * (`created_at`/`updated_at`/`completed_at`), transition history, and body
 * sections — is NOT here: those are what make a node a node in the graph, they
 * have their own verbs, and their decode is inherent structural work. They stay
 * bespoke in the codec (ADR 0025 Decision 1). `title` likewise stays structural:
 * it is always-present node identity (never omit-empty) and its `update`
 * applicability spans the non-node kinds (project/artifact/seed), which this
 * node-typed spec does not model.
 */

export type { DataFieldKey, FieldKindName } from '@mimir/contract';

// ─── Kind implementations (the parser/emitter pairs) ────────────────────────

/** A frontmatter value narrowed to a string, or null when it isn't one. */
function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Narrow a frontmatter value to an enum member. Norn has no enum field_type, so
 * value legality can't be enforced at the vault layer — the reader is the guard.
 * An ABSENT field returns null (the caller applies its own default /
 * nullability); a PRESENT but out-of-vocabulary value throws, enforcing in
 * code the same enum invariant a column CHECK constraint would enforce in a
 * schema.
 */
function enumFieldStrict<T extends string>(
  value: unknown,
  values: readonly T[],
  stem: string,
  field: string,
): T | null {
  if (value === undefined) {
    return null;
  }
  const s = str(value);
  if (s !== null && isMember(s, values)) {
    return s;
  }
  throw invariant(
    `node ${stem} has an invalid ${field} value`,
    `${field} must be one of: ${values.join(', ')}`,
  );
}

/**
 * The non-throwing enum narrow for the OPTIONAL task fields (`priority`/`size`,
 * MMR-177): absent → null, a valid member → the value, and a PRESENT foreign
 * value → null (no throw). Field validity keeps a node with a foreign
 * priority/size (null is a truthful "unset"), so a surviving node can still carry
 * one — this reads it as null rather than crashing the never-throw read path. The
 * tiering decision (null-the-field vs drop-the-node) lives only in `validate`;
 * this is the mechanical "don't crash" over the SAME vocabulary. NOT used for
 * `lifecycle`/`hold`, whose bad nodes the validator already drops — those stay on
 * {@link enumFieldStrict} as a seam backstop.
 */
function enumFieldOrNull<T extends string>(value: unknown, values: readonly T[]): T | null {
  const s = str(value);
  return s !== null && isMember(s, values) ? s : null;
}

/**
 * The non-throwing boolean narrow for the container-only OPTIONAL field
 * `open_ended` (MMR-204). Norn has no boolean field_type, so the field rides
 * undeclared and round-trips as the strings `'true'`/`'false'` (see the `bool`
 * kind's emitter); a hand-authored YAML boolean is accepted too. Absent or any
 * foreign value → null — the foreign-nulls-the-field tiering that mirrors
 * {@link enumFieldOrNull} (the validator owns the null-vs-drop decision).
 */
function boolFieldOrNull(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }
  const s = str(value);
  if (s === 'true') {
    return true;
  }
  return s === 'false' ? false : null;
}

/**
 * The non-throwing decode for a task's `upstream` seed pointer (MMR-244),
 * mirroring `validate`'s view WHERE THE READER CAN ACT LOCALLY: collapse the
 * wikilink form ({@link collapse}), then null unless the grammar is a `KEY-sN`
 * seed id — the grammar tier nulled here exactly as {@link enumFieldOrNull} nulls
 * a foreign priority/size. A DANGLING but well-formed ref (valid grammar, no such
 * seed) is NOT decided here: the hot read path loads no seeds, so it stays the
 * collapsed stem and the resolving read seam (MMR-245) resolves it. The tiering
 * decision lives in `validate`; this is the mechanical "collapse + grammar guard".
 */
function seedRefOrNull(value: unknown): string | null {
  const stem = collapse(value);
  return stem !== null && parseSeedRef(stem) !== null ? stem : null;
}

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

/** The scalar shapes a data-plane field takes in the model. */
type ModelScalar = string | number | boolean | null;

/** Context a decoder needs for a legality-throwing narrow (the enum guards). */
export type DecodeCtx = { stem: string; field: string };

/** The query-registry projection of a kind — `null` when the field isn't queryable. */
type QueryProjection = { kind: 'enum'; values: readonly string[] } | { kind: 'string' };

/**
 * A field **kind** — the parser/emitter pair and query semantics a field
 * declares by name (ADR 0025 Decision 2). `decode` reads a frontmatter value
 * into the model (tolerant, or a legality throw for the strict enums); `emit`
 * projects the model value back to a frontmatter value (`null` omits the key,
 * the omit-empty shape); `query` is the registry projection.
 */
type FieldKind = {
  decode: (value: unknown, ctx: DecodeCtx) => ModelScalar;
  /** Model value → frontmatter value; `null` omits the key. A `bool` stringifies;
   * the string/enum kinds pass their (string) value through, so the return widens
   * to {@link ModelScalar} even though a passthrough never yields a boolean. */
  emit: (value: ModelScalar) => ModelScalar;
  query: QueryProjection | null;
};

const FIELD_KINDS: Record<FieldKindName, FieldKind> = {
  bool: {
    decode: (value) => boolFieldOrNull(value),
    // Norn has no boolean field_type, so a bool serializes as the strings
    // 'true'/'false'; a deliberate `false` must round-trip, not collapse to
    // absent, so both states emit explicitly (only null omits).
    emit: (value) => (value === null ? null : String(value)),
    query: null,
  },
  'enum:hold': {
    // A task always carries a hold; an absent one defaults to the neutral 'none'.
    decode: (value, ctx) => enumFieldStrict(value, HOLD_VALUES, ctx.stem, ctx.field) ?? 'none',
    // 'none' is the neutral default — omit it (like null) so a task carries a
    // hold only when actually held; the reader defaults absent → 'none'.
    emit: (value) => (value === null || value === 'none' ? null : value),
    query: { kind: 'enum', values: HOLD_VALUES },
  },
  'enum:lifecycle': {
    decode: (value, ctx) => enumFieldStrict(value, LIFECYCLE_VALUES, ctx.stem, ctx.field),
    emit: (value) => value,
    query: { kind: 'enum', values: LIFECYCLE_VALUES },
  },
  'enum:priority': {
    decode: (value) => enumFieldOrNull(value, PRIORITY_VALUES),
    emit: (value) => value,
    query: { kind: 'enum', values: PRIORITY_VALUES },
  },
  'enum:size': {
    decode: (value) => enumFieldOrNull(value, SIZE_VALUES),
    emit: (value) => value,
    query: { kind: 'enum', values: SIZE_VALUES },
  },
  'seed-ref': {
    decode: (value) => seedRefOrNull(value),
    emit: (value) => value,
    query: { kind: 'string' },
  },
  string: {
    decode: (value) => str(value),
    emit: (value) => value,
    query: { kind: 'string' },
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

/** The model-side subset one node carries for the data-plane fields — the codec's
 * output half, the complement of the structural fields `decodeNode` fills in. */
export type DataFields = Pick<Node, DataFieldKey>;

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
  /** Node types that carry the field — the codec type-gate AND the update gate. */
  appliesTo: readonly NodeType[];
  /** The camelCase `UpdateFields` key, present when the generic `update` verb owns
   * the field; absent for the status axes, which have their own verbs. */
  update?: UpdateFieldKey;
  /** A field an applicable node MUST carry post-validation; its absence on read is
   * a seam invariant, not vault data (only `lifecycle`). */
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

/** Does the field apply to (is it carried by) the given node type? */
function appliesToType(spec: DataFieldSpec, type: NodeType): boolean {
  return spec.appliesTo.includes(type);
}

// ─── Derived: the codec (both directions from one spec) ─────────────────────

/**
 * Decode a node's data-plane fields from its frontmatter (ADR 0025) — the
 * generic loop over the spec that replaces `decodeNode`'s hand-written
 * data-field block. A field applies to the node's type or reads null; an
 * applicable strict-enum with a foreign value throws (the seam backstop), and a
 * `required` field absent on an applicable node is a validation-seam invariant.
 */
export function decodeDataFields(
  fm: Record<string, unknown>,
  type: NodeType,
  stem: string,
): DataFields {
  const out: Record<string, ModelScalar> = {};
  for (const spec of FIELD_SPEC_ENTRIES) {
    if (!appliesToType(spec, type)) {
      out[spec.key] = null;
      continue;
    }
    const value = FIELD_KINDS[spec.kind].decode(fm[spec.key], { field: spec.key, stem });
    if (spec.required === true && value === null) {
      throw invariant(
        `${type} ${stem} survived validation without a ${spec.key}`,
        `field validity (MMR-177) must drop a task with a missing or foreign ${spec.key} before the reader`,
      );
    }
    out[spec.key] = value;
  }
  // The loop populated exactly the DataFieldKey set (one entry per spec field).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return out as DataFields;
}

/**
 * Emit a node's data-plane fields into its frontmatter record (ADR 0025) — the
 * inverse of {@link decodeDataFields}, the generic loop over the same spec that
 * replaces `nodeFrontmatter`'s hand-written data-field block. Type-gated by the
 * same `appliesTo`, so a value never reaches frontmatter for a type that doesn't
 * carry the field; each emitted value is omit-when-empty (a `null` from the
 * kind's emitter drops the key).
 */
export function emitDataFields(fm: Record<string, unknown>, node: Node): void {
  for (const spec of FIELD_SPEC_ENTRIES) {
    if (!appliesToType(spec, node.type)) {
      continue;
    }
    const emitted = FIELD_KINDS[spec.kind].emit(node[spec.key]);
    if (emitted !== null) {
      fm[spec.key] = emitted;
    }
  }
}

// ─── Derived: the update applicability gates ────────────────────────────────

/** The camelCase `update` keys of the spec's data fields — the generic `update`
 * vocabulary the node contributes (title/description are structural, added by
 * `mutations/data.ts`). */
export const SPEC_UPDATE_KEYS: readonly UpdateFieldKey[] = FIELD_SPEC_ENTRIES.flatMap((spec) =>
  spec.update === undefined ? [] : [spec.update],
);

/** One data-plane field the generic `update` verb owns — the fact triple the
 * transport surfaces derive from: `key` is the snake_case body/frontmatter name
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

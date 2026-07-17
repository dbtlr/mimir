/**
 * `MigrationPlan` — the atomic write artifact the node path hands to norn's
 * `vault.apply` (MMR-153, ADR 0016; renamed from `vault.apply_plan` in norn 0.45,
 * MMR-207). One plan per `transact`: every
 * frontmatter set, section append, and document create the verbs compose lands
 * as one all-or-nothing batch, applied as one atomic transaction.
 *
 * The types mirror norn's authoritative Rust schema (`src/migration_plan.rs`,
 * schema v2). Every operation nests its params under `fields`; the exact keys
 * per kind are fixed by norn's applier (`src/planner/intent/mod.rs` deserializes
 * `fields` straight into its internal `PlannedChange`, and `src/repair_apply.rs`
 * reads `create_document`'s `new_value.{frontmatter,body}`), so the constructor
 * helpers here are the single place those key names live on the mimir side.
 *
 * norn 0.48 (NRN-264, ADR 0015) moved `MigrationPlan` to schema v2: plans gain
 * first-class `preconditions` (atomic logical-owner assertions). The field is
 * `#[serde(default, skip_serializing_if = "Vec::is_empty")]` on norn's side, so
 * an absent `preconditions` is a conformant v2 plan. Mimir emits that minimal
 * shape — bumping only the stamp — and does NOT adopt owner-set precondition
 * semantics (deliberately out of scope; a follow-up decision owns whether
 * mimir's node write path should assert owner sets).
 */

/** The `schema_version` norn's `MigrationPlan` accepts — v2 since norn 0.48 (NRN-264). */
export const MIGRATION_PLAN_SCHEMA_VERSION = 2;

/**
 * Norn's sequence-allocation template token (MMR-196). A `create_document`
 * path may carry one occurrence of this token in its file name; norn resolves
 * it to the next-free sibling sequence — against the literal template prefix
 * within the target directory — at apply time. The single authority for the
 * token's literal spelling; every emit site imports it rather than hardcoding
 * `'{{seq}}'`.
 */
export const SEQ_TOKEN = '{{seq}}';

/**
 * One operation in a {@link MigrationPlan}. All op params nest under `fields`
 * (an untyped JSON object on norn's side); `id`/`requires` are the optional
 * ordering hooks, unused by this slice. The op shape is unchanged across the
 * v1→v2 plan break — norn's `MigrationOp` still reads `{kind, fields, id?,
 * requires?}` (verified against `src/migration_plan.rs`), and `path` lives
 * inside `fields`, never at the op top level.
 */
export type MigrationOp = {
  kind: string;
  fields: Record<string, unknown>;
  id?: string;
  requires?: string[];
};

/** A norn migration plan (schema v2) — the whole batch for one `transact`.
 * `preconditions` is omitted: an absent/empty array is a conformant v2 plan and
 * mimir does not assert owner-set preconditions (out of scope, see module doc). */
export type MigrationPlan = {
  schema_version: 2;
  vault_root: string;
  generator?: string;
  generated_at?: string;
  operations: MigrationOp[];
};

/**
 * `set_frontmatter` — replace a scalar field's value. `expectedOldValue`, when
 * supplied, is norn's compare-and-set precondition (a JSON `null` asserts the
 * field was absent); omit it to overwrite unconditionally. Fields:
 * `{path, field, new_value, expected_old_value?}`.
 */
export function setFrontmatter(
  path: string,
  field: string,
  newValue: unknown,
  expectedOldValue?: unknown,
): MigrationOp {
  const fields: Record<string, unknown> = { field, new_value: newValue, path };
  if (expectedOldValue !== undefined) {
    fields.expected_old_value = expectedOldValue;
  }
  return { fields, kind: 'set_frontmatter' };
}

/**
 * `add_frontmatter` — insert a field norn refuses to already exist (use
 * {@link setFrontmatter} to overwrite). Fields: `{path, field, new_value}`.
 */
export function addFrontmatter(path: string, field: string, value: unknown): MigrationOp {
  return { fields: { field, new_value: value, path }, kind: 'add_frontmatter' };
}

/**
 * `remove_frontmatter` — delete a field. `expectedOldValue`, when supplied, is
 * norn's compare-and-set precondition: removing a *present* field asserts its
 * current value (norn refuses the removal otherwise), so the node write path
 * carries the snapshot value for the same drift protection `set_frontmatter`
 * gets. Fields: `{path, field, expected_old_value?}`.
 */
export function removeFrontmatter(
  path: string,
  field: string,
  expectedOldValue?: unknown,
): MigrationOp {
  const fields: Record<string, unknown> = { field, path };
  if (expectedOldValue !== undefined) {
    fields.expected_old_value = expectedOldValue;
  }
  return { fields, kind: 'remove_frontmatter' };
}

/**
 * `append_to_section` — append `content` to the end of the section under
 * `heading` (a `norn edit` op applied under whole-doc CAS). Fields:
 * `{path, heading, content}`.
 */
export function appendToSection(path: string, heading: string, content: string): MigrationOp {
  return { fields: { content, heading, path }, kind: 'append_to_section' };
}

/**
 * `replace_section` — replace the body under `heading` (the heading itself is
 * kept), the `norn edit` op applied under whole-doc CAS. The node write path
 * uses it to keep the `## Task Description` prose in lockstep with the
 * `description` frontmatter when a description is edited. Fields:
 * `{path, heading, content}`.
 */
export function replaceSection(path: string, heading: string, content: string): MigrationOp {
  return { fields: { content, heading, path }, kind: 'replace_section' };
}

/**
 * `replace_body` — replace the complete markdown body while preserving
 * frontmatter. `documentHash` is the full-document CAS precondition captured in
 * the diagnostic snapshot. Fields: `{path, document_hash, new_value}`.
 */
export function replaceBody(path: string, documentHash: string, body: string): MigrationOp {
  return {
    fields: { document_hash: documentHash, new_value: body, path },
    kind: 'replace_body',
  };
}

/**
 * `create_document` — write a new document with the given frontmatter and body.
 * norn reads the payload from `new_value.{frontmatter, body}`. Fields:
 * `{path, new_value: {frontmatter, body}}`. `path` may carry a single `{{seq}}`
 * token in its file name, which norn resolves to the next free sibling sequence
 * at apply time (`src/repair_apply.rs`), so incremental id allocation rides this
 * op alone — no separate allocation call needed.
 */
export function createDocument(
  path: string,
  frontmatter: Record<string, unknown>,
  body: string,
): MigrationOp {
  return { fields: { new_value: { body, frontmatter }, path }, kind: 'create_document' };
}

/**
 * A whole {@link MigrationPlan} for a single `create_document` — the one-op
 * envelope the artifact and seed stores write a new document through (a `{{seq}}`
 * create or a fixed-path restore). Bakes in the `mimir` generator so those
 * create sites do not each hand-assemble the same one-op plan. Kept thin on
 * purpose: multi-op plans (the node write path's coalesced `transact`) still
 * call {@link migrationPlan} directly.
 */
export function createDocumentPlan(
  vaultRoot: string,
  path: string,
  frontmatter: Record<string, unknown>,
  body: string,
): MigrationPlan {
  return migrationPlan({
    generator: 'mimir',
    operations: [createDocument(path, frontmatter, body)],
    vaultRoot,
  });
}

/** Assemble a schema-v2 plan for one `transact` from its operations. */
export function migrationPlan(args: {
  vaultRoot: string;
  operations: MigrationOp[];
  generator?: string;
  generatedAt?: string;
}): MigrationPlan {
  const plan: MigrationPlan = {
    operations: args.operations,
    schema_version: 2,
    vault_root: args.vaultRoot,
  };
  if (args.generator !== undefined) {
    plan.generator = args.generator;
  }
  if (args.generatedAt !== undefined) {
    plan.generated_at = args.generatedAt;
  }
  return plan;
}

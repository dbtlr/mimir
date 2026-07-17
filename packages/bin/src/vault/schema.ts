/**
 * The vault's identity and generated schema (MMR-142, ADR 0016 Refinement).
 *
 * `.mimir-vault.toml` is the identity marker: it is what converge recognizes
 * a directory by (a non-empty directory without it is never adopted), and its
 * `schema` is the migration ratchet — a future binary that reshapes
 * frontmatter or moves files bumps `VAULT_SCHEMA` and converges older vaults
 * forward; a marker *newer* than the binary refuses (the downgrade guard).
 *
 * `.norn/config.yaml` is generated wholesale from this module and owned by
 * Mimir: converge regenerates it whenever it drifts from the rendered form,
 * so rule upgrades ship as ordinary binary upgrades. Hand edits are
 * overwritten — the header says so.
 */

import { SEQ_TOKEN } from '../core/store-norn/plan';

/**
 * The vault schema this binary produces and can converge older vaults to.
 *
 * INVARIANT: any change to {@link renderNornConfig}'s output — a new rule, a new
 * field type, a changed `allowed_paths` — MUST bump this constant. The marker
 * `schema` is the downgrade guard: an older binary (lower `VAULT_SCHEMA`) refuses a
 * vault marked newer rather than silently regenerating its `.norn/config.yaml`
 * without the newer rule. Schema 4 added the `seed` rule (MMR-244); a schema-3
 * binary must refuse a schema-4 vault, not regenerate a seed-less config.
 */
export const VAULT_SCHEMA = 4;

export const MARKER_FILE = '.mimir-vault.toml';
export const NORN_CONFIG_FILE = '.norn/config.yaml';

export function renderMarker(): string {
  return `# Mimir vault identity — created by mimir, read by vault converge.\nschema = ${String(VAULT_SCHEMA)}\n`;
}

/** Parse a marker file's content; null when it isn't a valid marker. */
export function parseMarker(content: string): { schema: number } | null {
  let parsed: { schema?: unknown };
  try {
    parsed = Bun.TOML.parse(content);
  } catch {
    return null;
  }
  const schema = parsed.schema;
  if (typeof schema === 'number' && Number.isInteger(schema) && schema >= 0) {
    return { schema };
  }
  return null;
}

/**
 * The generated `.norn/config.yaml` for vault schema 2: the artifact rule
 * (Phase 2a) plus the node/project rules that let the read path (MMR-149,
 * ADR 0016 Phase 2b) write and query work-state documents. The per-project
 * layout — `KEY/KEY.md` (project), `KEY/KEY-seq.md` (node),
 * `KEY/artifacts/KEY-aN.md` (artifact) — is asserted structurally via
 * `allowed_paths`.
 *
 * Field types are drawn from Norn's vocabulary (`datetime`, `wikilink`,
 * `wikilink_or_list`, `list_of_strings`, `string`, `text`) — there is no
 * numeric type, so `rank` (a number in frontmatter) is intentionally left
 * undeclared and rides through as a JSON number. `task`/`phase`/`initiative`
 * share one rule via a multi-value `type` match.
 */
export function renderNornConfig(): string {
  return `# Managed by mimir (vault schema ${String(VAULT_SCHEMA)}) — regenerated on vault
# converge. Hand edits are overwritten.

files:
  ignore:
    - ".git/**"

validate:
  rules:
    - name: document-type
      match:
        path: "**/*.md"
      required_frontmatter:
        - type
      allowed_values:
        type:
          - artifact
          - project
          - task
          - phase
          - initiative
          - seed

    - name: artifact
      match:
        path: "**/*.md"
        frontmatter:
          type: artifact
      required_frontmatter:
        - title
        - project
        - created
      field_types:
        title: text
        project: wikilink
        anchor: wikilink_or_list
        tags: list_of_strings
        created: datetime
      allowed_paths:
        - "*/artifacts/*.md"

    - name: seed
      match:
        path: "**/*.md"
        frontmatter:
          type: seed
      required_frontmatter:
        - title
        - project
        - kind
        - lifecycle
        - created
        - updated_at
      field_types:
        title: text
        project: wikilink
        kind: string
        lifecycle: string
        requester: wikilink
        spawned: wikilink_or_list
        created: datetime
        updated_at: datetime
      allowed_paths:
        - "*/seeds/*.md"

    - name: node
      match:
        path: "**/*.md"
        frontmatter:
          type:
            - task
            - phase
            - initiative
      required_frontmatter:
        - title
        - parent
        - project
        - created
        - updated_at
      field_types:
        title: text
        description: text
        parent: wikilink
        project: wikilink
        depends_on: wikilink_or_list
        tags: list_of_strings
        lifecycle: string
        hold: string
        hold_reason: text
        priority: string
        size: string
        external_ref: string
        upstream: string
        target: string
        created: datetime
        updated_at: datetime
        completed_at: datetime
      allowed_paths:
        - "*/*.md"

    # Creatable node rule (MMR-153): the incremental target template the node
    # write path stamps into a create_document op. Norn resolves the trailing
    # \`{{seq}}\` token to the next free per-project sequence at APPLY time via
    # filesystem max+1 (src/seq_alloc.rs \`resolve_seq\`, driven from the op path
    # in src/repair_apply.rs), so \`KEY/KEY-{{seq}}.md\` mints \`KEY-N\` without a
    # Mimir-computed counter. A creatable rule carries \`target\` (the creation
    # handle) and no \`match.path\` — the two are mutually exclusive, and the
    # matcher is derived from the target (src/standards/config.rs post_validate).
    - name: node-create
      match:
        frontmatter:
          type:
            - task
            - phase
            - initiative
      target: "{{var.key}}/{{var.key}}-${SEQ_TOKEN}.md"

    - name: project
      match:
        path: "**/*.md"
        frontmatter:
          type: project
      required_frontmatter:
        - name
        - key
        - project
        - created
        - updated_at
      field_types:
        name: text
        key: string
        project: wikilink
        description: text
        created: datetime
        updated_at: datetime
        archived_at: datetime
      allowed_paths:
        - "*/*.md"
`;
}

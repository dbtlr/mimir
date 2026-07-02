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

/** The vault schema this binary produces and can converge older vaults to. */
export const VAULT_SCHEMA = 1;

export const MARKER_FILE = '.mimir-vault.toml';
export const NORN_CONFIG_FILE = '.norn/config.yaml';

export function renderMarker(): string {
  return `# Mimir vault identity — created by mimir, read by vault converge.\nschema = ${String(VAULT_SCHEMA)}\n`;
}

/** Parse a marker file's content; null when it isn't a valid marker. */
export function parseMarker(content: string): { schema: number } | null {
  let parsed: { schema?: unknown };
  try {
    parsed = Bun.TOML.parse(content) as { schema?: unknown };
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
 * The generated `.norn/config.yaml` for vault schema 1: the artifact rule
 * (Phase 2a is artifacts-first; node rules arrive with the read path). The
 * per-project layout — `KEY/KEY.md`, `KEY/KEY-seq.md`,
 * `KEY/artifacts/KEY-aN.md` — is asserted structurally via `allowed_paths`.
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
`;
}

/**
 * Human-readable IDs (ADR 0006) and the identity grammar (MMR-32). Every
 * entity has exactly one rendered id, spoken by every surface — echoes,
 * errors, facets, history, JSON/MCP. The surrogate integer PK never crosses
 * the surface.
 *
 *   project   bare `KEY`     (MMR)
 *   node      `KEY-seq`      (MMR-22)
 *   artifact  `KEY-aN`       (MMR-a1) — project-scoped, like tasks
 *   seed      `KEY-sN`       (MMR-s1) — project-anchored grooming record (MMR-244)
 *
 * Any id-position accepts the full grammar; the *verb* rejects types it
 * can't act on (a behavioral error, not a parse error).
 */

export type NodeRef = {
  key: string;
  seq: number;
};

/** A parsed rendered id — which entity kind a token names. */
export type Identity =
  | { kind: 'project'; key: string }
  | { kind: 'node'; key: string; seq: number }
  | { kind: 'artifact'; key: string; seq: number }
  | { kind: 'seed'; key: string; seq: number };

const PROJECT_PATTERN = /^[A-Z]{2,4}$/;
const NODE_PATTERN = /^([A-Z]{2,4})-(\d+)$/;
const ARTIFACT_PATTERN = /^([A-Z]{2,4})-a(\d+)$/;
const SEED_PATTERN = /^([A-Z]{2,4})-s(\d+)$/;

/** Render a project key + sequence as the external `KEY-seq` node id. */
export function renderId(ref: NodeRef): string {
  return `${ref.key}-${String(ref.seq)}`;
}

/** Wrap a rendered id (stem) as an Obsidian wikilink — the vault relation form. */
export function wikilink(stem: string): string {
  return `[[${stem}]]`;
}

/** Render a project key + artifact sequence as the external `KEY-aN` artifact id. */
export function renderArtifactRef(ref: NodeRef): string {
  return `${ref.key}-a${String(ref.seq)}`;
}

/** Render a project key + seed sequence as the external `KEY-sN` seed id (MMR-244). */
export function renderSeedRef(ref: NodeRef): string {
  return `${ref.key}-s${String(ref.seq)}`;
}

/** Parse a `KEY-sN` seed id back into its parts, or `null` if it isn't one (MMR-244). */
export function parseSeedRef(id: string): NodeRef | null {
  const match = SEED_PATTERN.exec(id);
  if (match === null) {
    return null;
  }
  const [, key, seqText] = match;
  if (key === undefined || seqText === undefined) {
    return null;
  }
  return { key, seq: Number(seqText) };
}

/** Parse a `KEY-seq` node id back into its parts, or `null` if it isn't one. */
export function parseId(id: string): NodeRef | null {
  const match = NODE_PATTERN.exec(id);
  if (match === null) {
    return null;
  }
  const [, key, seqText] = match;
  if (key === undefined || seqText === undefined) {
    return null;
  }
  return { key, seq: Number(seqText) };
}

/** Parse any rendered identity — `KEY` | `KEY-seq` | `KEY-aN` — or `null` if malformed. */
export function parseIdentity(token: string): Identity | null {
  if (PROJECT_PATTERN.test(token)) {
    return { key: token, kind: 'project' };
  }
  const artifact = ARTIFACT_PATTERN.exec(token);
  if (artifact !== null) {
    const [, key, seqText] = artifact;
    if (key !== undefined && seqText !== undefined) {
      return { key, kind: 'artifact', seq: Number(seqText) };
    }
  }
  const seed = SEED_PATTERN.exec(token);
  if (seed !== null) {
    const [, key, seqText] = seed;
    if (key !== undefined && seqText !== undefined) {
      return { key, kind: 'seed', seq: Number(seqText) };
    }
  }
  const node = parseId(token);
  if (node !== null) {
    return { key: node.key, kind: 'node', seq: node.seq };
  }
  return null;
}

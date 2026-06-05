/**
 * Human-readable node IDs (ADR 0006): the rendered identity is `KEY-seq`
 * (e.g. `MMR-16`) — `project.key` joined to the node's per-project `seq`. It is
 * **derived**, never stored; the surrogate integer PK is never exposed.
 */

export interface NodeRef {
  key: string;
  seq: number;
}

/** Render a project key + sequence as the external `KEY-seq` id. */
export function renderId(ref: NodeRef): string {
  return `${ref.key}-${ref.seq}`;
}

const ID_PATTERN = /^([A-Z]{2,4})-(\d+)$/;

/** Parse a `KEY-seq` id back into its parts, or `null` if malformed. */
export function parseId(id: string): NodeRef | null {
  const match = ID_PATTERN.exec(id);
  if (match === null) {
    return null;
  }
  const [, key, seqText] = match;
  if (key === undefined || seqText === undefined) {
    return null;
  }
  return { key, seq: Number(seqText) };
}

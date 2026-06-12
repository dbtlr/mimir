import type { Tx } from "./context";
import { notFound } from "./errors";

/**
 * Allocation (ADR 0006). `project.key` is the consumer-supplied scope prefix;
 * `node.seq` is a per-project counter the core hands out — monotonic, immutable,
 * never reused. The deliberate stored value the spine allows, because it is
 * *allocation*, not derivation.
 */

const KEY_PATTERN = /^[A-Z]{2,4}$/;

/**
 * Validate a project key. Stricter than the DB CHECK (which only constrains the
 * first character via GLOB) — every character must be A–Z, length 2–4. A
 * behavioral invariant the core owns.
 */
export function isValidKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/**
 * Atomically bump a project's `last_seq` and return the new value — the seq for
 * the node being created. Runs inside the creating verb's transaction, so the
 * read-modify-write can't interleave.
 */
export async function allocateSeq(tx: Tx, projectId: number): Promise<number> {
  const row = await tx
    .updateTable("project")
    .set((eb) => ({ last_seq: eb("last_seq", "+", 1) }))
    .where("id", "=", projectId)
    .returning("last_seq")
    .executeTakeFirst();
  if (row === undefined) {
    throw notFound("project not found");
  }
  return row.last_seq;
}

/** Atomically bump a project's `last_artifact_seq` — the `KEY-aN` counter (MMR-32). */
export async function allocateArtifactSeq(tx: Tx, projectId: number): Promise<number> {
  const row = await tx
    .updateTable("project")
    .set((eb) => ({ last_artifact_seq: eb("last_artifact_seq", "+", 1) }))
    .where("id", "=", projectId)
    .returning("last_artifact_seq")
    .executeTakeFirst();
  if (row === undefined) {
    throw notFound("project not found");
  }
  return row.last_artifact_seq;
}

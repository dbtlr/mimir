/**
 * Byte-bounded batching for `norn mcp` calls (NRN-s30).
 *
 * **The response direction has a payload cap.** Over the stdio MCP transport a
 * response above roughly 3–5 MB closes the connection silently: the call fails
 * as `MCP error -32000: Connection closed`, with no server-side error to
 * classify and nothing to retry on. Measured against a 3185-document vault (998
 * artifacts, 8.6 MB of artifact body, largest single artifact 125 KB): a
 * whole-vault `type:artifact` find with `.body` closes the connection, while the
 * same query at limit 400 (2.4 MB) succeeds — as does the norn CLI, which does
 * not cross the transport. So the fault is the transport, not the query.
 *
 * **The request direction does not.** Measured by applying one
 * `create_document` plan with a 1, 3, 6, and 12 MB body against a throwaway
 * vault: every one applied, the 12 MB one in 76 ms. Write batching is therefore
 * bounded for payload hygiene and for how much a partial failure leaves
 * half-done (ADR 0023), not for correctness.
 *
 * **So every body-carrying read is bounded by BYTES, not by document count.** A
 * metadata-only `find` is cheap and bounded (frontmatter is a handful of
 * scalars), so the pattern throughout the export is: enumerate with metadata,
 * then fetch bodies with `client.get(paths, '.body')` in chunks whose EXPECTED
 * payload stays well under the cap.
 *
 * Expected, because a body's size is not knowable before it is read — norn
 * exposes no size facet — so the budget is spent against a deliberately
 * pessimistic per-document assumption rather than a measurement. A count-only
 * batch cannot work: 100 documents is 200 KB of one vault's artifacts and 12 MB
 * of another's.
 */

import type { NornClient } from './client';
import { pathAndBody } from './decode';

/** One read call's limits: an expected-payload budget and a hard target count. */
export type ChunkLimits = {
  /** Expected response bytes one call may ask for. */
  budget: number;
  /** Targets per call, whatever the budget says — the backstop for a vault of
   * tiny documents, where the byte budget alone would name thousands of targets
   * and blow up the REQUEST instead. */
  ceiling: number;
};

/**
 * The assumed body size of a document whose real size is unknown — 64 KB, which
 * is about 8x the observed 8.6 KB average and half the observed 125 KB maximum
 * of the vault this was measured on. Pessimism is the point: at the default
 * budget it yields ~15 documents per call, so even an all-at-maximum chunk stays
 * near 1.9 MB, under the observed 3 MB floor of the cap.
 */
export const ASSUMED_BODY_BYTES = 64 * 1024;

/**
 * The default read limits. 1 MB of expected payload is a third of the lowest
 * connection-close observed, which leaves room for the assumption above to be
 * wrong by 3x on a chunk before a read fails.
 */
export const READ_LIMITS: ChunkLimits = { budget: 1_000_000, ceiling: 64 };

/**
 * Split `items` into chunks bounded by BOTH accumulated weight and count. An
 * item heavier than the whole budget rides a chunk of its own rather than being
 * dropped or merged — the caller cannot make it smaller, and a lone oversized
 * document is the one case no batching strategy can rescue.
 */
export function chunkByWeight<T>(
  items: readonly T[],
  weightOf: (item: T) => number,
  limits: ChunkLimits,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let weight = 0;
  for (const item of items) {
    const itemWeight = weightOf(item);
    const full = weight + itemWeight > limits.budget || current.length >= limits.ceiling;
    if (current.length > 0 && full) {
      chunks.push(current);
      current = [];
      weight = 0;
    }
    current.push(item);
    weight += itemWeight;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/** A value's size on the wire — the JSON encoding's byte length. */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

/** One document whose body is wanted, with the expected cost of fetching it. */
export type BodyTarget = { path: string; weight: number };

/**
 * Fetch many documents' bodies in byte-bounded `vault.get` calls, keyed by vault
 * path. The one home the export's body-carrying reads (artifacts and seeds)
 * share, so both obey the same budget and a fix to the batching lands once.
 * A path that resolves to nothing is simply absent from the map.
 */
export async function readBodies(
  client: NornClient,
  targets: readonly BodyTarget[],
  limits: ChunkLimits = READ_LIMITS,
): Promise<Map<string, string>> {
  const bodies = new Map<string, string>();
  for (const chunk of chunkByWeight(targets, (target) => target.weight, limits)) {
    const records = await client.get(
      chunk.map((target) => target.path),
      '.body',
    );
    for (const record of records) {
      const doc = pathAndBody(record);
      if (doc !== null) {
        bodies.set(doc.path, doc.body);
      }
    }
  }
  return bodies;
}

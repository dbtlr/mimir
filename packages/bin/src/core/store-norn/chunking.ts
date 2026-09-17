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
 *
 * **The estimate is a first guess, not a guarantee.** A vault whose documents
 * run larger than the assumption packs a chunk that still exceeds the cap, and
 * the failure mode is the silent connection close rather than a clean refusal.
 * So {@link readChunked} treats that close as a signal: it halves the chunk and
 * retries each half (the client reconnects on its next call), converging on
 * whatever size this vault's transport actually tolerates. Only a chunk of ONE
 * document that still closes the connection is unrecoverable, and that refuses
 * by name — no batching strategy can split a single oversized document.
 */

import { invariant, MimirError, validation } from '../errors';
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

/**
 * Is this failure the NRN-s30 response cap — the MCP transport closing the
 * connection on an oversized response?
 *
 * Matched on the message text because there is nothing else to match on: the
 * close carries no server-side error, and `NornClient` surfaces it as a typed
 * connection failure (`invariant`) whose detail is the SDK's own
 * `MCP error -32000: Connection closed`. A retry inside the client has already
 * failed by the time this is asked, so a hit means the payload, not a flake.
 */
export function isResponseCapFailure(error: unknown): boolean {
  const message = error instanceof MimirError ? error.message : String(error);
  return /connection closed|-32000/i.test(message);
}

/**
 * Run `read` over `items` in byte-bounded chunks, halving and retrying any chunk
 * the transport drops, and concatenating every call's records.
 *
 * The single home of the read-side batching strategy: every whole-vault,
 * body-carrying read goes through here, so the estimate, the adaptive split, and
 * the single-document refusal are one behavior rather than five copies.
 *
 * `labelOf` names an item for the refusal — a vault path, so the operator is
 * told which document the transport cannot carry.
 */
export async function readChunked<T, R>(
  items: readonly T[],
  weightOf: (item: T) => number,
  limits: ChunkLimits,
  labelOf: (item: T) => string,
  read: (chunk: readonly T[]) => Promise<R[]>,
): Promise<R[]> {
  const records: R[] = [];
  for (const chunk of chunkByWeight(items, weightOf, limits)) {
    records.push(...(await readSplitting(chunk, labelOf, read)));
  }
  return records;
}

/** One chunk, split in half and retried for as long as the transport refuses it. */
async function readSplitting<T, R>(
  chunk: readonly T[],
  labelOf: (item: T) => string,
  read: (chunk: readonly T[]) => Promise<R[]>,
): Promise<R[]> {
  try {
    return await read(chunk);
  } catch (error) {
    const only = chunk.length === 1 ? chunk[0] : undefined;
    if (!isResponseCapFailure(error)) {
      throw error;
    }
    if (only !== undefined) {
      throw validation(
        `${labelOf(only)} is too large for the norn transport to return`,
        'the MCP response cap (NRN-s30) closes the connection on an oversized response, and a single document cannot be split further — shrink the document, or read it outside mimir',
      );
    }
    const half = Math.floor(chunk.length / 2);
    return [
      ...(await readSplitting(chunk.slice(0, half), labelOf, read)),
      ...(await readSplitting(chunk.slice(half), labelOf, read)),
    ];
  }
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
 * Fail-closed: every requested path must come back with a record. An absent
 * record is the only signal a body was not read (an empty body reads as ''),
 * so tolerating it would let an export carry a frozen artifact with empty
 * content while the document census still passes.
 */
export async function readBodies(
  client: NornClient,
  targets: readonly BodyTarget[],
  limits: ChunkLimits = READ_LIMITS,
): Promise<Map<string, string>> {
  const records = await readChunked(
    targets,
    (target) => target.weight,
    limits,
    (target) => target.path,
    (chunk) =>
      client.get(
        chunk.map((target) => target.path),
        '.body',
      ),
  );
  const bodies = new Map<string, string>();
  for (const record of records) {
    const doc = pathAndBody(record);
    if (doc !== null) {
      bodies.set(doc.path, doc.body);
    }
  }
  const missing = targets.map((target) => target.path).filter((path) => !bodies.has(path));
  if (missing.length > 0) {
    throw invariant(
      `${missing.length} document body(ies) could not be read: ${missing.slice(0, 20).join(', ')}`,
      'run `mimir doctor` and re-run the export',
    );
  }
  return bodies;
}

/**
 * The typed accessor over a {@link readBodies} result: presence is guaranteed by
 * the reader's fail-closed check, so a miss here is a programming error (a path
 * that was never requested), not a vault condition.
 */
export function bodyOf(bodies: ReadonlyMap<string, string>, path: string): string {
  const body = bodies.get(path);
  if (body === undefined) {
    throw invariant(`the body at ${path} was never requested from the vault`);
  }
  return body;
}

import { validation } from '../errors';
import { decodeApplyReport } from './apply-report';
import type { ChunkLimits } from './chunking';
import { chunkByWeight, jsonBytes } from './chunking';
import type { NornClient } from './client';
import { createDocument, migrationPlan } from './plan';

/**
 * The raw whole-document write primitive (MMR-378). One `create_document` at a
 * FIXED vault path — no `{{seq}}` allocation, no compare-and-set, no read-back:
 * the caller already knows the document's complete identity and content.
 *
 * Two callers, one mechanism. The store import (ADR 0030 Decision 4) writes
 * every imported record at its canonical path with its own ids and timestamps;
 * test fixtures seed physical siblings, colliders, and hand-corrupt documents the
 * typed store APIs cannot produce (`seedRawDoc`). Both want exactly "put this
 * document there, verbatim, and fail loud if it did not land", so it lives here
 * as production code rather than in the test tree.
 *
 * Nothing here is idempotent: norn refuses a `create_document` onto an occupied
 * path. Deciding what an occupied path MEANS — a resumable skip, a collision to
 * refuse — is the caller's, because only the caller knows what it expected to
 * find there.
 */

/** One complete document to write at a fixed, vault-relative path. */
export type RawDocument = {
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
};

/**
 * One `vault.apply` batch's bounds — documents AND accumulated bytes.
 *
 * The byte bound is hygiene, not correctness: the REQUEST direction of the
 * `norn mcp` transport has no payload cap, measured by applying one
 * `create_document` plan with a 1, 3, 6, and 12 MB body against a throwaway
 * vault — every one applied, the 12 MB one in 76 ms. Only RESPONSES are capped
 * (NRN-s30, see {@link ./chunking}), and an apply report is small whatever the
 * plan wrote. The bound is here anyway because a count-only batch means nothing
 * about size: 100 documents is 200 KB of one vault and 12 MB of another, and
 * norn applies each document atomically while a multi-document plan may
 * partially succeed (ADR 0023) — so the batch also decides how much a failure
 * leaves half-done. A resumable caller re-runs and skips what landed.
 */
export const WRITE_LIMITS: ChunkLimits = { budget: 8 * 1024 * 1024, ceiling: 100 };

/** Write one document; throws unless norn applied it. */
export async function createRawDocument(
  client: NornClient,
  vaultRoot: string,
  document: RawDocument,
): Promise<void> {
  await createRawDocuments(client, vaultRoot, [document]);
}

/**
 * Write many documents, batched under {@link WRITE_LIMITS}. Throws on the first
 * batch norn did not fully apply, naming the failed operations — earlier batches
 * (and earlier documents within the failed batch) may already be on disk, which
 * is the Norn partial-success contract.
 */
export async function createRawDocuments(
  client: NornClient,
  vaultRoot: string,
  documents: readonly RawDocument[],
  limits: ChunkLimits = WRITE_LIMITS,
): Promise<void> {
  for (const batch of chunkByWeight(documents, documentBytes, limits)) {
    const plan = migrationPlan({
      generator: 'mimir',
      operations: batch.map((doc) => createDocument(doc.path, doc.frontmatter, doc.body)),
      vaultRoot,
    });
    const { operations, outcome } = decodeApplyReport(await client.applyPlan(plan, true));
    if (outcome === 'applied') {
      continue;
    }
    const detail = operations
      .flatMap((op) => (op.error === null ? [] : [op.error.message ?? op.error.code ?? '']))
      .filter((message) => message !== '')
      .join('; ');
    throw validation(
      'the raw document write did not complete',
      detail === '' ? `apply outcome: ${outcome ?? 'unrecognized'}` : detail,
    );
  }
}

/** One document's weight in a write plan: its body plus its encoded frontmatter. */
function documentBytes(document: RawDocument): number {
  return Buffer.byteLength(document.body, 'utf8') + jsonBytes(document.frontmatter);
}

import { validation } from './errors';
import type { StoreExport } from './export';
import { renderArtifactRef, renderSeedRef } from './ids';

/**
 * Transfer-document validation shared by every backend's import (ADR 0030
 * Decision 4). The document is backend-neutral, so the faults it can carry are
 * backend-neutral too — one implementation, or two backends would disagree
 * about which documents are importable.
 */

/** How many offending identities a refusal names before it stops. */
export const REFUSAL_SAMPLE = 20;

/** The first {@link REFUSAL_SAMPLE} names, with a count of whatever is left —
 * a refusal must be actionable without printing a whole vault. */
export function namedSample(names: readonly string[]): string {
  const shown = names.slice(0, REFUSAL_SAMPLE).join(', ');
  const rest = names.length - REFUSAL_SAMPLE;
  return rest > 0 ? `${shown} (and ${String(rest)} more)` : shown;
}

/**
 * Refuse a transfer document whose collections claim one identity twice, BEFORE
 * anything is written (the fence a fresh import already sets for projects,
 * widened to every identity kind).
 *
 * An identity is a single record's whole claim on the target — a canonical path
 * on Norn, a primary key on Postgres — so two records claiming it are two
 * documents competing for one place. The import would write one and then refuse
 * on the other, leaving the target half-written for a fault that was visible in
 * the document all along. A fail-closed export cannot PRODUCE such a document —
 * it refuses on the source collision first — but an import reads whatever it is
 * handed, including a hand-edited or foreign-backend document.
 */
export function assertSingleValuedIdentities(document: StoreExport): void {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const claim = (identity: string): void => {
    if (seen.has(identity)) {
      duplicates.push(identity);
      return;
    }
    seen.add(identity);
  };
  for (const project of document.projects) {
    claim(`project ${project.key}`);
  }
  for (const node of document.nodes) {
    claim(`node ${node.id}`);
  }
  for (const artifact of document.artifacts) {
    claim(`artifact ${renderArtifactRef(artifact)}`);
  }
  for (const seed of document.seeds) {
    claim(`seed ${renderSeedRef(seed)}`);
  }
  for (const pad of document.scratchpads) {
    claim(`scratchpad ${pad.id}`);
  }
  if (duplicates.length > 0) {
    throw validation(
      `the transfer document claims one identity twice: ${namedSample(duplicates)}`,
      'every identity is a canonical path, so two records claiming one would half-write the target — repair the document before importing it',
    );
  }
}

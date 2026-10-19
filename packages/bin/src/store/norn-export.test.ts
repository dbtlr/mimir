import { expect, test } from 'bun:test';

import { canonicalJson } from '@mimir/core';
import type { StoreExport } from '@mimir/core';
import { createSqliteTestStore, withoutStamp } from '@mimir/core/testing';

import fixture from './fixtures/v0.20-norn-export.json';

/**
 * The migration path off Norn (ADR 0032 Decision 5): an operator exports a
 * vault with the last release that carries the Norn backend and imports the
 * document into the new store. The release that removes Norn carries no Norn
 * reader, so this frozen document is what keeps that path proven.
 *
 * `fixtures/v0.20-norn-export.json` is the export v0.20.0 wrote from its Norn
 * test store seeded with the conformance working set (`seedWorkingSet`), which
 * touches every collection the document carries. It is a historical fact:
 * never regenerate it from a later release.
 */

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the import below parses it; a malformed fixture fails the case there.
const document = fixture as unknown as StoreExport;

/** The owner a blocked node gets by the rule (upstream means `others`, else `you`); null when not blocked. */
function impliedOwner(node: {
  hold: string | null;
  upstream: string | null;
}): 'you' | 'others' | null {
  if (node.hold !== 'blocked') {
    return null;
  }
  return node.upstream === null ? 'you' : 'others';
}

test('a v0.20 Norn export imports into the SQLite store and re-exports unchanged', async () => {
  const target = await createSqliteTestStore();
  try {
    const report = await target.store.import(document, { dryRun: false, mode: 'fresh' });
    expect(report.applied).toBe(true);

    // The fixture predates the grooming state (ADR 0033), the block owner
    // (MMR-438), the project pin (MMR-493), and the project remote (MMR-543), so the re-export is the same document at transfer version 7, with
    // each node carrying the defaults a fresh node is born with: `not_groomed`
    // for a task, for a blocked task the owner its upstream implies, and every
    // project unpinned and without a remote.
    const withDefaults: StoreExport = {
      ...document,
      nodes: document.nodes.map((node) => ({
        ...node,
        block_owner: impliedOwner(node),
        grooming: node.type === 'task' ? 'not_groomed' : null,
        worker_harness: null,
        worker_session: null,
      })),
      projects: document.projects.map((project) => ({ ...project, pinned: false, remote: null })),
      schema_version: 7,
    };
    const reexported = await target.store.export();
    expect(canonicalJson(withoutStamp(reexported))).toBe(canonicalJson(withoutStamp(withDefaults)));

    // The store now holds exactly the document, so a resume finds nothing to do.
    const resumed = await target.store.import(document, { dryRun: false, mode: 'resume' });
    expect(resumed).toMatchObject({ applied: true, created: 0 });
  } finally {
    await target.close();
  }
});

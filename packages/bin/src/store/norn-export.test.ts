import { expect, test } from 'bun:test';

import type { StoreExport } from '../core/export';
import { canonicalJson } from '../core/export';
import { createSqliteTestStore } from '../core/store-sqlite/testing';
import { withoutStamp } from '../testing/conformance';
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

test('a v0.20 Norn export imports into the SQLite store and re-exports unchanged', async () => {
  const target = await createSqliteTestStore();
  try {
    const report = await target.store.import(document, { dryRun: false, mode: 'fresh' });
    expect(report.applied).toBe(true);

    const reexported = await target.store.export();
    expect(canonicalJson(withoutStamp(reexported))).toBe(canonicalJson(withoutStamp(document)));

    // The store now holds exactly the document, so a resume finds nothing to do.
    const resumed = await target.store.import(document, { dryRun: false, mode: 'resume' });
    expect(resumed).toMatchObject({ applied: true, created: 0 });
  } finally {
    await target.close();
  }
});

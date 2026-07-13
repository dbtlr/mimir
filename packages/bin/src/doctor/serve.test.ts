import { expect, test } from 'bun:test';

import type { DoctorFacetDeps } from './serve';
import { computeDoctorFacet } from './serve';

test('a scoped facet reads per-document diagnostics whole-vault and filters by canonical stem (MMR-240)', async () => {
  const seenDocs: (string | undefined)[] = [];
  const seenSections: (string | undefined)[] = [];
  const deps: DoctorFacetDeps = {
    readNodeDocs: (scope) => {
      seenDocs.push(scope);
      return Promise.resolve([
        { body: 'line one\r\nline two\r\n', stem: 'MMR-9' },
        { body: 'line one\r\nline two\r\n', stem: 'OTH-5' },
      ]);
    },
    readRaw: () => Promise.resolve([]),
    readSectionFailures: (scope) => {
      seenSections.push(scope);
      return Promise.resolve([
        { section: 'History', stem: 'MMR-9' },
        { section: 'History', stem: 'OTH-5' },
      ]);
    },
    readVaultGraph: () => Promise.resolve({ nodes: [], projectKeys: [] }),
    validate: () => Promise.resolve({ findings: [] }),
  };

  const facet = await computeDoctorFacet(deps, 'MMR');

  expect(seenDocs).toEqual([undefined]);
  expect(seenSections).toEqual([undefined]);
  expect(facet.groups.map((group) => group.project)).toEqual(['MMR']);
  expect(facet.groups[0]?.records.every((record) => record.id === 'MMR-9')).toBe(true);
  expect(facet.groups[0]?.records.map((record) => record.cause).toSorted()).toEqual([
    'CRLF line endings',
    'unreadable section',
  ]);
});

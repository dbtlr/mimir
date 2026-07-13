import { expect, test } from 'bun:test';

import type { DoctorFacetDeps } from './serve';
import { computeDoctorFacet } from './serve';

test('a scoped facet reads one whole-vault snapshot and filters by canonical stem (MMR-240, MMR-241)', async () => {
  let reads = 0;
  const deps: DoctorFacetDeps = {
    readRaw: () => Promise.resolve([]),
    readSnapshot: () => {
      reads += 1;
      return Promise.resolve({
        documents: [
          {
            body: 'line one\r\nline two\r\n',
            documentHash: 'hash-1',
            path: 'MMR/MMR-9.md',
            stem: 'MMR-9',
          },
          {
            body: 'line one\r\nline two\r\n',
            documentHash: 'hash-2',
            path: 'OTH/OTH-5.md',
            stem: 'OTH-5',
          },
        ],
        graph: { nodes: [], projectKeys: [] },
        sectionFailures: [
          { section: 'History', stem: 'MMR-9' },
          { section: 'History', stem: 'OTH-5' },
        ],
        validateFindings: [],
      });
    },
  };

  const facet = await computeDoctorFacet(deps, 'MMR');

  expect(reads).toBe(1);
  expect(facet.groups.map((group) => group.project)).toEqual(['MMR']);
  expect(facet.groups[0]?.records.every((record) => record.id === 'MMR-9')).toBe(true);
  expect(facet.groups[0]?.records.map((record) => record.cause).toSorted()).toEqual([
    'CRLF line endings',
    'unreadable section',
  ]);
});

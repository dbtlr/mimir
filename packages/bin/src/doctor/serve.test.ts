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

test('facet diagnosis uses the shared unique physical locator for relocated raw enrichment', async () => {
  const rawPaths: string[][] = [];
  const deps: DoctorFacetDeps = {
    readRaw: (paths) => {
      rawPaths.push(paths);
      return Promise.resolve([{ path: 'relocated/custom.md', raw: 'line one\r\nline two\r\n' }]);
    },
    readSnapshot: () =>
      Promise.resolve({
        documents: [
          {
            body: 'line one\r\nline two\r\n',
            documentHash: 'hash',
            path: 'relocated/custom.md',
            stem: 'MMR-9',
          },
        ],
        graph: { nodes: [], projectKeys: [] },
        sectionFailures: [],
        validateFindings: [],
      }),
  };
  const facet = await computeDoctorFacet(deps, 'MMR');
  expect(rawPaths).toEqual([['relocated/custom.md']]);
  expect(facet.groups[0]?.records[0]).toMatchObject({
    id: 'MMR-9',
    path: 'relocated/custom.md',
  });
  expect(facet.groups[0]?.records[0]?.snippet).not.toBeNull();
});

test('duplicate logical stems never receive arbitrary physical raw enrichment', async () => {
  const rawPaths: string[][] = [];
  const deps: DoctorFacetDeps = {
    readRaw: (paths) => {
      rawPaths.push(paths);
      return Promise.resolve([{ path: 'MMR/MMR-9.md', raw: 'title: arbitrary\n' }]);
    },
    readSnapshot: () =>
      Promise.resolve({
        documents: [
          { body: 'one', documentHash: 'a', path: 'MMR/MMR-9.md', stem: 'MMR-9' },
          { body: 'two', documentHash: 'b', path: 'archive/MMR-9.md', stem: 'MMR-9' },
        ],
        graph: {
          nodes: [],
          projectKeys: ['MMR'],
          sources: [
            { kind: 'node', path: 'MMR/MMR-9.md', stem: 'MMR-9' },
            { kind: 'node', path: 'archive/MMR-9.md', stem: 'MMR-9' },
          ],
        },
        sectionFailures: [],
        validateFindings: [],
      }),
  };
  const facet = await computeDoctorFacet(deps, 'MMR');
  expect(rawPaths).toEqual([]);
  expect(facet.groups[0]?.records).toHaveLength(2);
  expect(facet.groups[0]?.records.every((record) => record.title === null)).toBe(true);
  expect(facet.groups[0]?.records.every((record) => record.snippet === null)).toBe(true);
});

test('a malformed canonical duplicate prevents enrichment of a visible relocated stem', async () => {
  const rawPaths: string[][] = [];
  const deps: DoctorFacetDeps = {
    readRaw: (paths) => {
      rawPaths.push(paths);
      return Promise.resolve([]);
    },
    readSnapshot: () =>
      Promise.resolve({
        documents: [
          {
            body: 'visible\r\n',
            documentHash: 'hash',
            path: 'relocated/MMR-9.md',
            stem: 'MMR-9',
          },
        ],
        graph: { nodes: [], projectKeys: ['MMR'] },
        sectionFailures: [],
        validateFindings: [
          {
            code: 'frontmatter-parse-failed',
            message: 'invalid yaml',
            path: 'MMR/MMR-9.md',
          },
        ],
      }),
  };
  const facet = await computeDoctorFacet(deps, 'MMR');
  expect(rawPaths).toEqual([]);
  const malformed = facet.groups[0]?.records.find(
    (record) => record.cause === 'malformed frontmatter',
  );
  expect(malformed).toMatchObject({ path: 'MMR/MMR-9.md', snippet: null, title: null });
});

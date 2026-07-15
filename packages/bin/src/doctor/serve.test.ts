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
            path: 'MMR/MMR-1.md',
            stem: 'MMR-1',
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
          { path: 'MMR/MMR-1.md', section: 'History', stem: 'MMR-1' },
          { path: 'OTH/OTH-5.md', section: 'History', stem: 'OTH-5' },
        ],
        validateFindings: [],
      });
    },
  };

  const facet = await computeDoctorFacet(deps, 'MMR');

  expect(reads).toBe(1);
  expect(facet.groups.map((group) => group.project)).toEqual(['MMR']);
  expect(facet.groups[0]?.records.every((record) => record.id === 'MMR-1')).toBe(true);
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
            stem: 'MMR-1',
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
    id: 'MMR-1',
    path: 'relocated/custom.md',
  });
  expect(facet.groups[0]?.records[0]?.snippet).not.toBeNull();
});

test('duplicate logical stems never receive arbitrary physical raw enrichment', async () => {
  const rawPaths: string[][] = [];
  const deps: DoctorFacetDeps = {
    readRaw: (paths) => {
      rawPaths.push(paths);
      return Promise.resolve([{ path: 'MMR/MMR-1.md', raw: 'title: arbitrary\n' }]);
    },
    readSnapshot: () =>
      Promise.resolve({
        documents: [
          { body: 'one\r\n', documentHash: 'a', path: 'MMR/MMR-1.md', stem: 'MMR-1' },
          { body: 'two\r\n', documentHash: 'b', path: 'archive/MMR-1.md', stem: 'MMR-1' },
        ],
        graph: {
          nodes: [],
          projectKeys: ['MMR'],
          sources: [
            { kind: 'node', path: 'MMR/MMR-1.md', stem: 'MMR-1' },
            { kind: 'node', path: 'archive/MMR-1.md', stem: 'MMR-1' },
          ],
        },
        sectionFailures: [],
        validateFindings: [],
      }),
  };
  const facet = await computeDoctorFacet(deps, 'MMR');
  expect(rawPaths).toEqual([]);
  expect(facet.groups[0]?.records).toHaveLength(4);
  expect(facet.groups[0]?.records.every((record) => record.title === null)).toBe(true);
  expect(facet.groups[0]?.records.every((record) => record.snippet === null)).toBe(true);
  expect(
    facet.groups[0]?.records
      .filter((record) => record.cause === 'CRLF line endings')
      .map((record) => record.path)
      .toSorted(),
  ).toEqual(['MMR/MMR-1.md', 'archive/MMR-1.md']);
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
            path: 'relocated/MMR-1.md',
            stem: 'MMR-1',
          },
        ],
        graph: { nodes: [], projectKeys: ['MMR'] },
        sectionFailures: [],
        validateFindings: [
          {
            code: 'frontmatter-parse-failed',
            message: 'invalid yaml',
            path: 'MMR/MMR-1.md',
          },
        ],
      }),
  };
  const facet = await computeDoctorFacet(deps, 'MMR');
  expect(rawPaths).toEqual([]);
  const malformed = facet.groups[0]?.records.find(
    (record) => record.cause === 'malformed frontmatter',
  );
  expect(malformed).toMatchObject({ path: 'MMR/MMR-1.md', snippet: null, title: null });
  expect(
    facet.groups[0]?.records.filter((record) => record.cause === 'identity-uniqueness'),
  ).toHaveLength(2);
});

test('an unrelated validate path does not suppress exact relocated enrichment', async () => {
  const rawPaths: string[][] = [];
  const deps: DoctorFacetDeps = {
    readRaw: (paths) => {
      rawPaths.push(paths);
      return Promise.resolve([{ path: 'relocated/MMR-1.md', raw: 'visible\r\n' }]);
    },
    readSnapshot: () =>
      Promise.resolve({
        documents: [
          {
            body: 'visible\r\n',
            documentHash: 'hash',
            path: 'relocated/MMR-1.md',
            stem: 'MMR-1',
          },
        ],
        graph: { nodes: [], projectKeys: ['MMR'] },
        sectionFailures: [],
        validateFindings: [{ code: 'frontmatter-parse-failed', path: 'refs/MMR-1.md' }],
      }),
  };
  const facet = await computeDoctorFacet(deps, 'MMR');
  expect(rawPaths).toEqual([['relocated/MMR-1.md']]);
  expect(facet.groups[0]?.records).toContainEqual(
    expect.objectContaining({ cause: 'CRLF line endings', path: 'relocated/MMR-1.md' }),
  );
  expect(facet.groups[0]?.records.some((record) => record.cause === 'malformed frontmatter')).toBe(
    false,
  );
});

test('a relocated section failure preserves its exact path under identity ambiguity', async () => {
  const deps: DoctorFacetDeps = {
    readRaw: () => Promise.resolve([]),
    readSnapshot: () =>
      Promise.resolve({
        documents: [
          {
            body: '## Task Description\ntext\n',
            documentHash: 'hash',
            path: 'relocated/MMR-1.md',
            stem: 'MMR-1',
          },
        ],
        graph: { nodes: [], projectKeys: ['MMR'] },
        sectionFailures: [{ path: 'relocated/MMR-1.md', section: 'History', stem: 'MMR-1' }],
        validateFindings: [{ code: 'frontmatter-parse-failed', path: 'MMR/MMR-1.md' }],
      }),
  };
  const facet = await computeDoctorFacet(deps, 'MMR');
  const section = facet.groups[0]?.records.find((record) => record.cause === 'unreadable section');
  expect(section?.path).toBe('relocated/MMR-1.md');
});

test('relocated project raw enrichment gates on its logical owner identity', async () => {
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
            body: 'relocated\r\n',
            documentHash: 'a',
            frontmatter: { key: 'MMR', type: 'project' },
            path: 'relocated/custom.md',
            stem: 'custom',
          },
          {
            body: 'canonical\r\n',
            documentHash: 'b',
            frontmatter: { key: 'MMR', type: 'project' },
            path: 'MMR/MMR.md',
            stem: 'MMR',
          },
        ],
        graph: {
          nodes: [],
          projectKeys: ['MMR'],
          sources: [
            { kind: 'project', path: 'relocated/custom.md', stem: 'MMR' },
            { kind: 'project', path: 'MMR/MMR.md', stem: 'MMR' },
          ],
        },
        sectionFailures: [],
        validateFindings: [],
      }),
  };
  await computeDoctorFacet(deps, undefined);
  expect(rawPaths).toEqual([]);
});

test('a zero-owner finding never synthesizes a canonical raw path', async () => {
  const rawPaths: string[][] = [];
  const deps: DoctorFacetDeps = {
    readRaw: (paths) => {
      rawPaths.push(paths);
      return Promise.resolve([]);
    },
    readSnapshot: () =>
      Promise.resolve({
        documents: [],
        graph: {
          nodes: [{ dependsOn: [], key: 'MMR', parent: null, stem: 'MMR-1' }],
          projectKeys: [],
        },
        sectionFailures: [],
        validateFindings: [],
      }),
  };
  await computeDoctorFacet(deps, undefined);
  expect(rawPaths).toEqual([]);
});

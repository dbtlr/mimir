import { expect, test } from 'bun:test';

import { encodeScratchpadBody } from '../scratchpads/codec';
import { decodeScratchpadDocument } from './scratchpads';

const AT = '2026-08-03T12:00:00.000Z';
const V4 = '123e4567-e89b-42d3-a456-426614174000';

function document(id = V4) {
  return {
    body: encodeScratchpadBody({ agenda: [], journal: [] }),
    documentHash: 'hash',
    fm: {
      created: AT,
      project: '[[MMR]]',
      title: 'Working notes',
      type: 'scratch',
      updated_at: AT,
    } as Record<string, unknown>,
    path: `scratch/${id}.md`,
  };
}

test('only a UUIDv4 path is accepted as scratchpad identity', () => {
  const decoded = decodeScratchpadDocument(
    document('123e4567-e89b-12d3-a456-426614174000'),
    new Set(['MMR']),
    new Map(),
  );
  expect(decoded.scratchpad).toBeNull();
  expect(decoded.problems).toContainEqual({ problem: 'invalid-path' });

  const uppercase = decodeScratchpadDocument(
    document(V4.toUpperCase()),
    new Set(['MMR']),
    new Map(),
  );
  expect(uppercase.scratchpad).toBeNull();
  expect(uppercase.problems).toContainEqual({ problem: 'invalid-path' });
});

test('dangling and cross-project anchors drop while the scratchpad remains readable', () => {
  const doc = document();
  doc.fm.anchor = ['[[MMR-1]]', '[[ATSK-1]]', '[[MMR-999]]', 42];
  const decoded = decodeScratchpadDocument(
    doc,
    new Set(['MMR', 'ATSK']),
    new Map([
      ['MMR-1', 'MMR'],
      ['ATSK-1', 'ATSK'],
    ]),
  );
  expect(decoded.scratchpad?.anchors).toEqual(['MMR-1']);
  expect(decoded.invalidAnchors).toEqual(['ATSK-1', 'MMR-999']);
  expect(decoded.problems).toEqual([
    { problem: 'malformed-anchor', value: '42' },
    { problem: 'cross-project-anchor', value: 'ATSK-1' },
    { problem: 'dangling-anchor', value: 'MMR-999' },
  ]);
});

test('a valid freezing document stays readable', () => {
  const doc = document();
  doc.fm.freezing_at = AT;
  const decoded = decodeScratchpadDocument(doc, new Set(['MMR']), new Map());
  expect(decoded.scratchpad?.freezingAt).toBe(AT);
  expect(decoded.problems).toEqual([]);
});

test('a missing owning project quarantines the whole scratchpad', () => {
  const decoded = decodeScratchpadDocument(document(), new Set(), new Map());
  expect(decoded.scratchpad).toBeNull();
  expect(decoded.problems).toContainEqual({ problem: 'invalid-project', value: 'MMR' });
});

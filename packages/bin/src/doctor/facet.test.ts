import { describe, expect, test } from 'bun:test';

import type { DoctorFinding } from './checks';
import { buildDoctorFacet, editDistance, locateField, nearest, pathOfStem } from './facet';

describe('editDistance / nearest', () => {
  test('edit distance counts single-edit typos', () => {
    expect(editDistance('praked', 'parked')).toBe(2);
    expect(editDistance('parked', 'parked')).toBe(0);
    expect(editDistance('', 'abc')).toBe(3);
  });

  test('nearest picks the closest vocabulary word', () => {
    expect(nearest('praked', ['parked', 'blocked', 'none'])).toBe('parked');
    expect(nearest('in_progres', ['todo', 'in_progress', 'done'])).toBe('in_progress');
    expect(nearest('', ['a', 'b'])).toBeNull();
  });

  test('nearest suppresses a suggestion for gibberish (no near miss)', () => {
    // Nothing in the vocabulary is anywhere near — suggesting "todo" for line
    // noise would be worse than silence.
    expect(nearest('qqqqzzzzxxxx', ['todo', 'in_progress', 'done'])).toBeNull();
    // A near miss (a transposition) still suggests.
    expect(nearest('dnoe', ['todo', 'in_progress', 'done'])).toBe('done');
  });
});

describe('pathOfStem', () => {
  test('maps each identity kind to its vault layout', () => {
    expect(pathOfStem('MMR')).toBe('MMR/MMR.md');
    expect(pathOfStem('MMR-7')).toBe('MMR/MMR-7.md');
    expect(pathOfStem('MMR-a3')).toBe('MMR/artifacts/MMR-a3.md');
    expect(pathOfStem('MMR-s2')).toBe('MMR/seeds/MMR-s2.md');
    expect(pathOfStem('not a stem')).toBeNull();
  });
});

describe('locateField', () => {
  const raw = [
    '---',
    'type: task',
    'title: Hover states',
    'lifecycle: praked',
    '---',
    '',
    'body',
  ].join('\n');

  test('locates a frontmatter field, its value, and the value column span', () => {
    const found = locateField(raw, 'lifecycle');
    expect(found).not.toBeNull();
    expect(found?.line).toBe(4);
    expect(found?.value).toBe('praked');
    // `lifecycle: ` is 11 chars, so the value starts at column 11.
    expect(found?.start).toBe(11);
    expect(found?.length).toBe(6);
  });

  test('returns null for an absent field', () => {
    expect(locateField(raw, 'priority')).toBeNull();
  });
});

/** An illegal-lifecycle finding + the offending document's raw text. */
const rawTask = [
  '---',
  'type: task',
  'title: Board polish: hover states',
  'project: MMR',
  'priority: p2',
  'size: small',
  'lifecycle: dnoe',
  '---',
  '',
  '## Task Description',
].join('\n');

const lifecycleFinding: DoctorFinding = {
  check: 'field-validity',
  code: 'invalid-lifecycle',
  evidence: { value: 'dnoe' },
  locator: 'frontmatter · lifecycle',
  message: 'task dropped — invalid lifecycle "dnoe"',
  node: 'MMR-97',
  scopeKey: 'MMR',
  severity: 'error',
  stem: 'MMR-97',
  where: 'frontmatter · lifecycle',
};

describe('buildDoctorFacet', () => {
  test('enriches an illegal-lifecycle finding into a full panel record', () => {
    const facet = buildDoctorFacet({
      findings: [lifecycleFinding],
      rawByStem: new Map([['MMR-97', rawTask]]),
      readableDocStems: ['MMR', 'MMR-97', 'MMR-98', 'MMR-99'],
      scannedAt: '2026-07-12T00:00:00.000Z',
    });

    expect(facet.dropped_total).toBe(1);
    expect(facet.groups).toHaveLength(1);
    const group = facet.groups[0];
    expect(group?.project).toBe('MMR');
    expect(group?.dropped).toBe(1);
    // 4 readable docs, one of them (MMR-97) is the dropped one → 3 readable.
    expect(group?.readable).toBe(3);

    const record = group?.records[0];
    expect(record).toMatchObject({
      cause: 'illegal status word',
      field: 'lifecycle',
      id: 'MMR-97',
      path: 'MMR/MMR-97.md',
      severity: 'error',
      suggestion: 'done',
      title: 'Board polish: hover states',
      value: 'dnoe',
    });
    expect(record?.location?.line).toBe(7);
    // The offending line is the last snippet line, with the token span marked.
    const last = record?.snippet?.lines.at(-1);
    expect(last?.n).toBe(7);
    expect(last?.text).toBe('lifecycle: dnoe');
    expect(last?.offending).toEqual({ length: 4, start: 11 });
    // Two context lines precede it (the mock's 3-line well).
    expect(record?.snippet?.lines.map((l) => l.n)).toEqual([5, 6, 7]);
  });

  test('nearest-legal suggestion resolves a hold typo to the hold vocabulary', () => {
    const rawHold = ['---', 'type: task', 'title: t', 'hold: praked', '---'].join('\n');
    const facet = buildDoctorFacet({
      findings: [
        {
          check: 'field-validity',
          code: 'invalid-hold',
          evidence: { value: 'praked' },
          locator: 'frontmatter · hold',
          message: 'invalid hold',
          node: 'MMR-5',
          scopeKey: 'MMR',
          severity: 'error',
          stem: 'MMR-5',
          where: 'frontmatter · hold',
        },
      ],
      rawByStem: new Map([['MMR-5', rawHold]]),
      readableDocStems: ['MMR-5'],
      scannedAt: '2026-07-12T00:00:00.000Z',
    });
    expect(facet.groups[0]?.records[0]?.suggestion).toBe('parked');
  });

  test('a foreign-type finding with no readable body still renders cause + path', () => {
    const facet = buildDoctorFacet({
      findings: [
        {
          check: 'frontmatter',
          code: 'value-not-allowed',
          evidence: { value: 'foreign' },
          locator: 'frontmatter · type',
          message: 'foreign type',
          node: 'MMR-2',
          scopeKey: 'MMR',
          severity: 'error',
          stem: 'MMR-2',
          where: 'frontmatter · type',
        },
      ],
      rawByStem: new Map(),
      readableDocStems: ['MMR-1'],
      scannedAt: '2026-07-12T00:00:00.000Z',
    });
    const record = facet.groups[0]?.records[0];
    expect(record).toMatchObject({
      cause: 'foreign type',
      id: 'MMR-2',
      path: 'MMR/MMR-2.md',
      snippet: null,
      title: null,
    });
    // MMR-2 was never in the readable set, so the readable tally is untouched.
    expect(facet.groups[0]?.readable).toBe(1);
  });

  test('a dangling spawned edge gets its own cause, not the missing-project fallback', () => {
    const rawSeed = ['---', 'type: seed', 'title: s', 'spawned: "[[MMR-9]]"', '---'].join('\n');
    const facet = buildDoctorFacet({
      findings: [
        {
          check: 'seed-validity',
          code: 'dangling-spawned',
          evidence: { ref: 'MMR-9' },
          locator: 'frontmatter · spawned',
          message: 'spawned MMR-9 resolves to no node in the vault — pruned on read',
          node: 'MMR-s1',
          scopeKey: 'MMR',
          severity: 'error',
          stem: 'MMR-s1',
          where: 'frontmatter · spawned',
        },
      ],
      rawByStem: new Map([['MMR-s1', rawSeed]]),
      readableDocStems: ['MMR-s1'],
      scannedAt: '2026-07-12T00:00:00.000Z',
    });
    const record = facet.groups[0]?.records[0];
    expect(record?.cause).toBe('dangling spawned');
    expect(record?.note).toContain('pruned on read');
    // No closed vocabulary for a reference — never a nearest-legal suggestion.
    expect(record?.suggestion).toBeNull();
  });

  test('a clean vault yields an empty facet', () => {
    const facet = buildDoctorFacet({
      findings: [],
      rawByStem: new Map(),
      readableDocStems: ['MMR', 'MMR-1'],
      scannedAt: '2026-07-12T00:00:00.000Z',
    });
    expect(facet.dropped_total).toBe(0);
    expect(facet.groups).toEqual([]);
  });

  test('a seq-gaps finding is not rendered as a phantom dropped record (MMR-197)', () => {
    // A seq gap is an informational warning about non-contiguous numbering — nothing
    // is dropped at MMR/MMR.md — so it must not appear in the record-health facet.
    const seqGapFinding: DoctorFinding = {
      check: 'seq-gaps',
      code: 'interior-seq-gap',
      evidence: { kind: 'node', max: 3, missing: [2], missingCount: 1 },
      locator: 'node sequence',
      message: 'project MMR is missing interior node sequence number 2 below its max 3',
      node: 'MMR',
      scopeKey: 'MMR',
      severity: 'warn',
      stem: 'MMR',
      where: 'node sequence',
    };
    const facet = buildDoctorFacet({
      findings: [seqGapFinding],
      rawByStem: new Map(),
      readableDocStems: ['MMR', 'MMR-1', 'MMR-3'],
      scannedAt: '2026-07-12T00:00:00.000Z',
    });
    expect(facet.dropped_total).toBe(0);
    expect(facet.groups).toEqual([]);
  });

  test('a duplicate-artifact-stem finding surfaces as a dropped record (MMR-282)', () => {
    // Unlike a seq gap, a duplicate artifact hides one document on the canonical
    // point-read — a dropped/hidden record, the same class as identity-uniqueness —
    // so it DOES surface in the record-health facet, with its own cause chip.
    const dupFinding: DoctorFinding = {
      check: 'artifact-duplicate-stems',
      code: 'duplicate-artifact-stem',
      evidence: { paths: ['MMR/MMR-a2.md', 'MMR/artifacts/MMR-a2.md'] },
      locator: 'MMR/MMR-a2.md',
      message: 'duplicate artifact stem MMR-a2 at MMR/MMR-a2.md, MMR/artifacts/MMR-a2.md',
      node: 'MMR-a2',
      scopeKey: 'MMR',
      severity: 'error',
      stem: 'MMR-a2',
      where: 'MMR/MMR-a2.md',
    };
    const facet = buildDoctorFacet({
      findings: [dupFinding],
      rawByStem: new Map(),
      readableDocStems: ['MMR', 'MMR-1'],
      scannedAt: '2026-07-12T00:00:00.000Z',
    });
    expect(facet.dropped_total).toBe(1);
    expect(facet.groups).toHaveLength(1);
    const record = facet.groups[0]?.records[0];
    expect(record).toMatchObject({ cause: 'duplicate artifact', id: 'MMR-a2', severity: 'error' });
  });

  test('an artifact seq-gap rides the seq-gaps exclusion and does not surface (MMR-282)', () => {
    const artifactSeqGap: DoctorFinding = {
      check: 'seq-gaps',
      code: 'interior-seq-gap',
      evidence: { kind: 'artifact', max: 3, missing: [2], missingCount: 1 },
      locator: 'artifact sequence',
      message: 'project MMR is missing interior artifact sequence number 2 below its max 3',
      node: 'MMR',
      scopeKey: 'MMR',
      severity: 'warn',
      stem: 'MMR',
      where: 'artifact sequence',
    };
    const facet = buildDoctorFacet({
      findings: [artifactSeqGap],
      rawByStem: new Map(),
      readableDocStems: ['MMR', 'MMR-a1', 'MMR-a3'],
      scannedAt: '2026-07-12T00:00:00.000Z',
    });
    expect(facet.dropped_total).toBe(0);
    expect(facet.groups).toEqual([]);
  });

  test('groups records by project and sorts groups by key', () => {
    const facet = buildDoctorFacet({
      findings: [
        { ...lifecycleFinding, node: 'ZED-3' },
        { ...lifecycleFinding, node: 'ABC-1' },
        { ...lifecycleFinding, node: 'ABC-2' },
      ],
      rawByStem: new Map(),
      readableDocStems: [],
      scannedAt: '2026-07-12T00:00:00.000Z',
    });
    expect(facet.groups.map((g) => g.project)).toEqual(['ABC', 'ZED']);
    expect(facet.groups[0]?.dropped).toBe(2);
  });
});

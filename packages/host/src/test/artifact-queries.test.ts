import { describe, expect } from 'vitest';

import { ARTIFACT_PAGE_SIZE, artifactInput, artifactsQuery } from '../api/browse-queries';
import type { ArtifactSummary } from '../api/browse-queries';
import { engineArtifact } from './browse-fixtures';

describe('artifactInput', () => {
  it('names only the project when no filter is set', () => {
    expect(artifactInput({ project: 'MMR' })).toStrictEqual({ project: 'MMR' });
  });

  it('carries only the set filters, and no zone without a date', () => {
    expect(artifactInput({ project: 'MMR', q: 'auth gate', tag: 'kind:spec' })).toStrictEqual({
      project: 'MMR',
      q: 'auth gate',
      tag: 'kind:spec',
    });
    expect(artifactInput({ atOrAfter: '', project: 'MMR', q: '' })).toStrictEqual({
      project: 'MMR',
    });
  });

  it('sends date filters on the creation instant, with this browser zone', () => {
    expect(
      artifactInput({ atOrAfter: '2026-06-01', atOrBefore: '2026-06-30', project: 'MMR' }),
    ).toStrictEqual({
      dates: [
        { field: 'created_at', op: 'at-or-after', value: '2026-06-01' },
        { field: 'created_at', op: 'at-or-before', value: '2026-06-30' },
      ],
      project: 'MMR',
      timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });
});

const summary = (n: number): ArtifactSummary => engineArtifact({ id: `MMR-a${String(n)}` });

const page = (count: number, total: number) => {
  const items = Array.from({ length: count }, (_, i) => summary(i + 1));
  return { items, returned: items.length, startsAt: 0, total };
};

describe('artifactsQuery windowing', () => {
  it('advances the offset by rows already fetched', () => {
    const { getNextPageParam } = artifactsQuery({ project: 'MMR' });
    const first = page(ARTIFACT_PAGE_SIZE, ARTIFACT_PAGE_SIZE + 50);
    expect(getNextPageParam(first, [first], 0, [0])).toBe(ARTIFACT_PAGE_SIZE);
  });

  it('stops once every row up to total is on screen', () => {
    const { getNextPageParam } = artifactsQuery({ project: 'MMR' });
    const first = page(ARTIFACT_PAGE_SIZE, ARTIFACT_PAGE_SIZE + 50);
    const last = page(50, ARTIFACT_PAGE_SIZE + 50);
    expect(
      getNextPageParam(last, [first, last], ARTIFACT_PAGE_SIZE, [0, ARTIFACT_PAGE_SIZE]),
    ).toBeUndefined();
  });

  it('stops on an empty page even when total says more (never loops)', () => {
    const { getNextPageParam } = artifactsQuery({ project: 'MMR' });
    const empty = page(0, 10);
    expect(getNextPageParam(empty, [empty], 0, [0])).toBeUndefined();
  });
});

import { describe, expect } from 'vitest';

import { ARTIFACT_PAGE_SIZE, artifactParams, artifactsQuery } from '../api/queries';
import type { WireArtifactSummary } from '../api/types';

describe('artifactParams', () => {
  it('omits empty filters', () => {
    expect(artifactParams({})).toBe('');
  });

  it('encodes only the set filters', () => {
    const qs = artifactParams({ project: 'MMR', q: 'auth gate', tag: 'kind:spec' });
    const p = new URLSearchParams(qs);
    expect(p.get('project')).toBe('MMR');
    expect(p.get('q')).toBe('auth gate');
    expect(p.get('tag')).toBe('kind:spec');
    expect(p.has('since')).toBe(false);
  });
});

const summary = (n: number): WireArtifactSummary => ({
  created_at: '2026-06-16T00:00:00.000Z',
  id: `MMR-a${String(n)}`,
  project: 'MMR',
  tags: [],
  title: `Artifact ${String(n)}`,
});

const page = (count: number, total: number) => ({
  items: Array.from({ length: count }, (_, i) => summary(i + 1)),
  total,
});

describe('artifactsQuery windowing', () => {
  it('advances the offset by rows already fetched', () => {
    const { getNextPageParam } = artifactsQuery({});
    const first = page(ARTIFACT_PAGE_SIZE, ARTIFACT_PAGE_SIZE + 50);
    expect(getNextPageParam(first, [first], 0, [0])).toBe(ARTIFACT_PAGE_SIZE);
  });

  it('stops once every row up to total is on screen', () => {
    const { getNextPageParam } = artifactsQuery({});
    const first = page(ARTIFACT_PAGE_SIZE, ARTIFACT_PAGE_SIZE + 50);
    const last = page(50, ARTIFACT_PAGE_SIZE + 50);
    expect(
      getNextPageParam(last, [first, last], ARTIFACT_PAGE_SIZE, [0, ARTIFACT_PAGE_SIZE]),
    ).toBeUndefined();
  });

  it('stops on an empty page even when total says more (never loops)', () => {
    const { getNextPageParam } = artifactsQuery({});
    const empty = page(0, 10);
    expect(getNextPageParam(empty, [empty], 0, [0])).toBeUndefined();
  });
});

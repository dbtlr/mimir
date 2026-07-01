import { describe, expect } from 'vitest';

import type { WireAttention } from '../api/types';
import { groupIntoLanes } from '../lib/lanes';
import { project } from './fixtures';

/**
 * MMR-102 — the overview's Lane grouping. A pure transform from the projects
 * list (each carrying MMR-101's `attention` facet) to ordered, non-empty lanes,
 * recency-sorted within each; degrades to a flat list when the facet is absent
 * (offline / pre-feature cache).
 */

function attn(lane: WireAttention['lane'], lastActivity: string, stale = false): WireAttention {
  return { lane, last_activity: lastActivity, stale };
}

describe('groupIntoLanes', () => {
  it('groups projects into the four lanes in fixed highest-wins order', () => {
    const result = groupIntoLanes([
      project({ attention: attn('at_rest', '2026-06-01T00:00:00.000Z'), id: 'REST' }),
      project({ attention: attn('needs_unsticking', '2026-06-01T00:00:00.000Z'), id: 'STUCK' }),
      project({ attention: attn('awaiting_you', '2026-06-01T00:00:00.000Z'), id: 'REVIEW' }),
      project({ attention: attn('live', '2026-06-01T00:00:00.000Z'), id: 'LIVE' }),
    ]);
    expect(result.mode).toBe('grouped');
    if (result.mode !== 'grouped') {
      return;
    }
    expect(result.lanes.map((l) => l.lane)).toStrictEqual([
      'awaiting_you',
      'live',
      'needs_unsticking',
      'at_rest',
    ]);
    expect(result.lanes.map((l) => l.label)).toStrictEqual([
      'Awaiting you',
      'Live',
      'Needs unsticking',
      'At rest',
    ]);
  });

  it('omits empty lanes — no orphan headers', () => {
    const result = groupIntoLanes([
      project({ attention: attn('live', '2026-06-01T00:00:00.000Z'), id: 'A' }),
      project({ attention: attn('live', '2026-06-02T00:00:00.000Z'), id: 'B' }),
    ]);
    expect(result.mode).toBe('grouped');
    if (result.mode !== 'grouped') {
      return;
    }
    expect(result.lanes).toHaveLength(1);
    expect(result.lanes[0]?.lane).toBe('live');
  });

  it('sorts within a lane by last_activity descending (most recent first)', () => {
    const result = groupIntoLanes([
      project({ attention: attn('live', '2026-06-01T00:00:00.000Z'), id: 'OLD' }),
      project({ attention: attn('live', '2026-06-20T00:00:00.000Z'), id: 'NEW' }),
      project({ attention: attn('live', '2026-06-10T00:00:00.000Z'), id: 'MID' }),
    ]);
    if (result.mode !== 'grouped') {
      throw new Error('expected grouped');
    }
    expect(result.lanes[0]?.projects.map((p) => p.id)).toStrictEqual(['NEW', 'MID', 'OLD']);
  });

  it("carries the going-cold (stale) flag through on the project's attention", () => {
    const result = groupIntoLanes([
      project({ attention: attn('live', '2026-06-01T00:00:00.000Z', true), id: 'COLD' }),
    ]);
    if (result.mode !== 'grouped') {
      throw new Error('expected grouped');
    }
    expect(result.lanes[0]?.projects[0]?.attention?.stale).toBe(true);
  });

  it('falls back to a flat list (input order) when any project lacks the facet', () => {
    const result = groupIntoLanes([
      project({ attention: attn('live', '2026-06-01T00:00:00.000Z'), id: 'AAA' }),
      project({ id: 'BBB' }), // no attention — degraded payload
    ]);
    expect(result.mode).toBe('flat');
    if (result.mode !== 'flat') {
      return;
    }
    expect(result.projects.map((p) => p.id)).toStrictEqual(['AAA', 'BBB']);
  });

  it('an empty overview yields grouped mode with no lanes', () => {
    const result = groupIntoLanes([]);
    expect(result.mode).toBe('grouped');
    if (result.mode !== 'grouped') {
      return;
    }
    expect(result.lanes).toHaveLength(0);
  });
});

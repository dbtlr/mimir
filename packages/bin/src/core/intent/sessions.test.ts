import { expect, test } from 'bun:test';

import type { SessionRow, SessionSummaryArtifact } from './sessions';
import { groupSessionRows, joinSessionSummaries } from './sessions';

/**
 * The recent-sessions composition (MMR-322) — pure over rows and artifacts the
 * caller already read, so the grouping and the disclosed join heuristic are
 * pinned here without a store.
 */

const row = (session: string, at: string, id: string, title = id): SessionRow => ({
  at,
  session,
  task: { id, title },
});

const artifact = (
  id: string,
  createdAt: string,
  links: string[],
  summary: string | null = null,
): SessionSummaryArtifact => ({ createdAt, id, links, summary, title: `write-up ${id}` });

test('rows group by session id, carrying the window, task set, and row count', () => {
  const groups = groupSessionRows([
    row('s-1', '2026-07-02T10:00:00.000Z', 'MMR-1'),
    row('s-1', '2026-07-02T12:00:00.000Z', 'MMR-2'),
    row('s-1', '2026-07-02T11:00:00.000Z', 'MMR-1'),
    row('s-2', '2026-07-01T09:00:00.000Z', 'MMR-3'),
  ]);
  expect(groups).toHaveLength(2);
  // Newest last-activity first.
  expect(groups.map((g) => g.id)).toEqual(['s-1', 's-2']);
  const [first] = groups;
  expect(first?.from).toBe('2026-07-02T10:00:00.000Z');
  expect(first?.to).toBe('2026-07-02T12:00:00.000Z');
  expect(first?.transitions).toBe(3);
  // Deduped, in first-touch order.
  expect(first?.tasks.map((t) => t.id)).toEqual(['MMR-1', 'MMR-2']);
});

test('legacy rows without a session handle join no group (the caller filters them out)', () => {
  // The caller only ever forwards rows that carried a handle, so an empty input
  // — a project whose whole history predates MMR-320 — yields no groups at all,
  // never an "unknown session" bucket.
  expect(groupSessionRows([])).toEqual([]);
});

test('an artifact joins the group its links overlap, and carries its lede', () => {
  const groups = groupSessionRows([row('s-1', '2026-07-02T10:00:00.000Z', 'MMR-1')]);
  const entries = joinSessionSummaries(groups, [
    artifact('MMR-a1', '2026-07-02T13:00:00.000Z', ['MMR-1'], 'shipped the codec'),
  ]);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.id).toBe('s-1');
  expect(entries[0]?.artifact).toEqual({
    id: 'MMR-a1',
    summary: 'shipped the codec',
    title: 'write-up MMR-a1',
  });
});

test('an artifact with no lede carries no summary key', () => {
  const groups = groupSessionRows([row('s-1', '2026-07-02T10:00:00.000Z', 'MMR-1')]);
  const entries = joinSessionSummaries(groups, [
    artifact('MMR-a1', '2026-07-02T13:00:00.000Z', ['MMR-1']),
  ]);
  expect(entries[0]?.artifact).toEqual({ id: 'MMR-a1', title: 'write-up MMR-a1' });
});

test('the newest artifact wins a contested group; the older one falls through', () => {
  const groups = groupSessionRows([
    row('s-old', '2026-07-01T10:00:00.000Z', 'MMR-1'),
    row('s-new', '2026-07-02T10:00:00.000Z', 'MMR-1'),
    row('s-new', '2026-07-02T11:00:00.000Z', 'MMR-2'),
  ]);
  const entries = joinSessionSummaries(groups, [
    artifact('MMR-a2', '2026-07-02T12:00:00.000Z', ['MMR-1']),
    artifact('MMR-a1', '2026-07-01T12:00:00.000Z', ['MMR-1']),
  ]);
  const bySession = new Map(entries.map((e) => [e.id, e.artifact?.id]));
  // a2 (newest) takes s-new (the newest overlapping group); a1 takes what's left.
  expect(bySession.get('s-new')).toBe('MMR-a2');
  expect(bySession.get('s-old')).toBe('MMR-a1');
});

test('an artifact attaches to at most one group, even when it links several', () => {
  const groups = groupSessionRows([
    row('s-1', '2026-07-02T10:00:00.000Z', 'MMR-1'),
    row('s-2', '2026-07-01T10:00:00.000Z', 'MMR-2'),
  ]);
  const entries = joinSessionSummaries(groups, [
    artifact('MMR-a1', '2026-07-02T12:00:00.000Z', ['MMR-1', 'MMR-2']),
  ]);
  expect(entries.filter((e) => e.artifact !== undefined)).toHaveLength(1);
  expect(entries.find((e) => e.artifact !== undefined)?.id).toBe('s-1');
});

test('an artifact overlapping no group becomes a knowledge-only entry', () => {
  const groups = groupSessionRows([row('s-1', '2026-07-02T10:00:00.000Z', 'MMR-1')]);
  const entries = joinSessionSummaries(groups, [
    artifact('MMR-a9', '2026-07-03T10:00:00.000Z', ['MMR-7'], 'explored the vault layout'),
  ]);
  expect(entries).toHaveLength(2);
  // Newest-first ordering puts the orphan (created later) at the head.
  const [orphan] = entries;
  expect(orphan?.id).toBeNull();
  expect(orphan?.transitions).toBe(0);
  expect(orphan?.tasks).toEqual([]);
  expect(orphan?.artifact?.id).toBe('MMR-a9');
});

test('entries come back newest-first across groups and orphans alike', () => {
  const groups = groupSessionRows([
    row('s-1', '2026-07-01T10:00:00.000Z', 'MMR-1'),
    row('s-2', '2026-07-03T10:00:00.000Z', 'MMR-2'),
  ]);
  const entries = joinSessionSummaries(groups, [
    artifact('MMR-a1', '2026-07-02T10:00:00.000Z', ['MMR-9']),
  ]);
  expect(entries.map((e) => e.to)).toEqual([
    '2026-07-03T10:00:00.000Z',
    '2026-07-02T10:00:00.000Z',
    '2026-07-01T10:00:00.000Z',
  ]);
});

test('no groups and no artifacts is an empty section', () => {
  expect(joinSessionSummaries([], [])).toEqual([]);
});

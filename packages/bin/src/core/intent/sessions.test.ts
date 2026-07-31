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

test('groups are newest-first, with the session id as a total tiebreak', () => {
  // Two groups closing in the SAME millisecond: order must come from the id, not
  // from the order the rows happened to arrive in.
  const at = '2026-07-02T10:00:00.000Z';
  const forward = groupSessionRows([row('s-b', at, 'MMR-1'), row('s-a', at, 'MMR-2')]);
  const reversed = groupSessionRows([row('s-a', at, 'MMR-2'), row('s-b', at, 'MMR-1')]);
  expect(forward.map((g) => g.id)).toEqual(['s-a', 's-b']);
  expect(reversed.map((g) => g.id)).toEqual(forward.map((g) => g.id));
});

test('the join does not depend on the caller having pre-sorted the groups', () => {
  // `joinSessionSummaries` is exported, so which group a contested artifact
  // claims must be decided by the groups' own order, not the array's.
  const groups = [
    { from: 'a', id: 's-old', tasks: [{ id: 'MMR-1', title: 'one' }], to: 'b', transitions: 1 },
    { from: 'c', id: 's-new', tasks: [{ id: 'MMR-1', title: 'one' }], to: 'd', transitions: 1 },
  ];
  const summary = artifact('MMR-a1', '2026-07-03T00:00:00.000Z', ['MMR-1']);
  const asGiven = joinSessionSummaries(groups, [summary]);
  const reversed = joinSessionSummaries(groups.toReversed(), [summary]);
  // `to: 'd'` is the newest window, so s-new claims it either way.
  expect(asGiven.find((e) => e.artifact !== undefined)?.id).toBe('s-new');
  expect(reversed.find((e) => e.artifact !== undefined)?.id).toBe('s-new');
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

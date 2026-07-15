import { expect, test } from 'bun:test';

import type { Hold, Lifecycle } from '@mimir/contract';

import { attentionOf } from './attention';
import { deriveSet } from './derive';
import type { DerivationSet } from './derive';
import type { Dependency, Node, Project } from './model';

/**
 * MMR-101 — the derived project attention-state. Lanes resolve highest-wins over
 * a project's leaf tasks; `stale` is a modifier; `lastActivity` is the recency
 * floor the consumer (MMR-102) sorts within a lane.
 *
 * `attentionOf` is pure over one {@link DerivationSet} snapshot (ADR 0016 Phase
 * 0) — it never reads a store. The fixtures below build the WorkingSet inputs
 * directly (MMR-271); a project's attention only scans its own leaf tasks, so
 * the container hierarchy a real create-path would insert is unnecessary here.
 */

const AT = '2026-01-01T00:00:00.000Z';
let seq = 0;
const nextSeq = (): number => {
  seq += 1;
  return seq;
};

function project(overrides: Partial<Project> = {}): Project {
  return {
    archived_at: null,
    created_at: AT,
    description: null,
    key: 'MMR',
    name: 'm',
    updated_at: AT,
    ...overrides,
  };
}

/** A leaf task, defaulting to a fresh todo/none/undeps leaf (reads `ready`). */
function task(projectId: string, overrides: Partial<Node> = {}): Node {
  const nodeSeq = nextSeq();
  return {
    completed_at: null,
    created_at: AT,
    description: null,
    external_ref: null,
    hold: 'none' satisfies Hold,
    hold_reason: null,
    id: `${projectId}-${String(nodeSeq)}`,
    lifecycle: 'todo' satisfies Lifecycle,
    open_ended: null,
    parent_id: null,
    priority: null,
    project_id: projectId,
    rank: null,
    seq: nodeSeq,
    size: null,
    summary: null,
    target: null,
    title: 't',
    type: 'task',
    updated_at: AT,
    upstream: null,
    ...overrides,
  };
}

function setOf(p: Project, nodes: Node[], edges: Dependency[] = []): DerivationSet {
  return deriveSet({
    edges,
    nodeTags: new Map(),
    nodes,
    projectTags: new Map(),
    projects: [p],
  });
}

test('an empty project (no leaf tasks) is at_rest, recency falling back to the project itself', () => {
  const p = project();
  const a = attentionOf(setOf(p, []), p);
  expect(a.lane).toBe('at_rest');
  expect(a.stale).toBe(false);
  expect(a.lastActivity).toBe(p.updated_at);
});

test('a project whose only live signal is under_review lands in awaiting_you', () => {
  const p = project();
  const t = task(p.key, { lifecycle: 'under_review' });
  expect(attentionOf(setOf(p, [t]), p).lane).toBe('awaiting_you');
});

test('in_progress and ready leaves both read as live', () => {
  const p1 = project();
  const running = task(p1.key, { lifecycle: 'in_progress' });
  expect(attentionOf(setOf(p1, [running]), p1).lane).toBe('live');

  const p2 = project({ key: 'RDY' });
  const fresh = task(p2.key); // todo + none, no deps → ready
  expect(attentionOf(setOf(p2, [fresh]), p2).lane).toBe('live');
});

test('blocked and awaiting leaves both read as needs_unsticking', () => {
  const p1 = project();
  const stuck = task(p1.key, { hold: 'blocked' });
  expect(attentionOf(setOf(p1, [stuck]), p1).lane).toBe('needs_unsticking');

  const p2 = project({ key: 'AWT' });
  // park the prereq so the project's top lane is the awaiting leaf
  const prereq = task(p2.key, { hold: 'parked' });
  const dependent = task(p2.key);
  const edge: Dependency = { depends_on_node_id: prereq.id, node_id: dependent.id };
  expect(attentionOf(setOf(p2, [prereq, dependent], [edge]), p2).lane).toBe('needs_unsticking');
});

test('a project of only parked/terminal leaves is at_rest', () => {
  const p = project();
  const parked = task(p.key, { hold: 'parked' });
  const done = task(p.key, { lifecycle: 'done' });
  const gone = task(p.key, { lifecycle: 'abandoned' });
  const a = attentionOf(setOf(p, [parked, done, gone]), p);
  expect(a.lane).toBe('at_rest');
  expect(a.stale).toBe(false);
});

test('the highest lane wins when leaves span several lanes', () => {
  const p = project();
  const review = task(p.key, { lifecycle: 'under_review' });
  const ready = task(p.key); // live
  const blocked = task(p.key, { hold: 'blocked' }); // needs_unsticking

  // awaiting_you (under_review) outranks live and needs_unsticking
  expect(attentionOf(setOf(p, [review, ready, blocked]), p).lane).toBe('awaiting_you');

  // drop the review to done → highest remaining is live (the ready leaf)
  const reviewDone: Node = { ...review, lifecycle: 'done' };
  expect(attentionOf(setOf(p, [reviewDone, ready, blocked]), p).lane).toBe('live');
});

test('highest-wins is independent of scan order — the winning leaf created last still wins', () => {
  const p = project();
  // lower lanes first, the awaiting_you leaf created last (so it scans last)
  const blocked = task(p.key, { hold: 'blocked' }); // needs_unsticking
  const ready = task(p.key); // live
  const review = task(p.key, { lifecycle: 'under_review' }); // awaiting_you, created last
  expect(attentionOf(setOf(p, [blocked, ready, review]), p).lane).toBe('awaiting_you');
});

test('stale is a modifier that decorates the live lane, not a lane of its own', () => {
  const p = project();
  const asOf = '2026-06-05T00:00:00.000Z';
  const ancient = task(p.key, {
    lifecycle: 'in_progress',
    updated_at: '2000-01-01T00:00:00.000Z', // ancient
  });

  const a = attentionOf(setOf(p, [ancient]), p, { asOf });
  expect(a.lane).toBe('live'); // still its real lane
  expect(a.stale).toBe(true); // going cold rides on top

  // a fresh in_progress leaf is not stale
  const fresh: Node = { ...ancient, updated_at: asOf };
  expect(attentionOf(setOf(p, [fresh]), p, { asOf }).stale).toBe(false);
});

test("lastActivity is the max updated_at across the project's leaf tasks", () => {
  const p = project();
  const older = task(p.key, { updated_at: '2026-01-01T00:00:00.000Z' });
  const newer = task(p.key, { updated_at: '2026-06-20T12:00:00.000Z' });
  expect(attentionOf(setOf(p, [older, newer]), p).lastActivity).toBe('2026-06-20T12:00:00.000Z');
});

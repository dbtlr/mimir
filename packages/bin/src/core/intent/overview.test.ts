import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createTestStore, nodeIdOf, projectIdOf } from '../../testing/store';
import { createInitiative, createPhase, createProject, createTask } from '../create';
import {
  archiveProject,
  attachArtifact,
  blockTask,
  depend,
  startTask,
  submitTask,
  updateNode,
  updateProject,
} from '../mutations';
import { fileSeed } from '../seeds';
import type { Store } from '../store';
import { expectMimirError } from '../testing';
import { overviewOf } from './index';

/**
 * `overviewOf` (MMR-278, expanded MMR-322) — the composite orientation query.
 * One working-set load plus the composed sections' bounded reads; counts before
 * contents holds under every section cap.
 */

const NORN = Bun.which('norn') !== null;

let store: Store;
let closeStore: () => Promise<void>;
let projectId: string;
let initId: string;
let phaseId: string;
let phaseStem: string;
beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
  await createProject(store, { key: 'MMR', name: 'm' });
  projectId = await projectIdOf(store, 'MMR');
  const init = await createInitiative(store, { projectId, title: 'i' });
  initId = await nodeIdOf(store, `MMR-${String(init.seq)}`);
  const phase = await createPhase(store, { parentId: initId, title: 'ph' });
  phaseId = await nodeIdOf(store, `MMR-${String(phase.seq)}`);
  phaseStem = `MMR-${String(phase.seq)}`;
});
afterEach(async () => {
  await closeStore();
});

const idOf = (n: { seq: number }): string => `MMR-${String(n.seq)}`;

test.skipIf(!NORN)('overviewOf composes the five sections with true counts', async () => {
  // 6 plain ready tasks + a ready prereq = 7 ready; a dependent awaits the prereq.
  for (let i = 0; i < 6; i += 1) {
    await createTask(store, { parentId: phaseId, title: `ready-${String(i)}` });
  }
  const prereq = await createTask(store, { parentId: phaseId, title: 'prereq' });
  const dependent = await createTask(store, { parentId: phaseId, title: 'dependent' });
  await depend(store, idOf(dependent), [idOf(prereq)]);

  // in flight: one in_progress, one under_review.
  const started = await createTask(store, { parentId: phaseId, title: 'started' });
  await startTask(store, idOf(started));
  const reviewed = await createTask(store, { parentId: phaseId, title: 'reviewed' });
  await startTask(store, idOf(reviewed));
  await submitTask(store, idOf(reviewed));

  // hygiene: one blocked task, two untriaged seeds.
  const blocked = await createTask(store, { parentId: phaseId, title: 'blocked' });
  await blockTask(store, idOf(blocked), 'external');
  await fileSeed(store, { kind: 'idea', project: 'MMR', title: 'seed one' });
  await fileSeed(store, { kind: 'bug', project: 'MMR', title: 'seed two' });

  const report = await overviewOf(store, 'MMR');

  expect(report.project.id).toBe('MMR');
  // One project root (the initiative) contributes the whole rollup.
  const rootTotal = Object.values(report.project.distribution).reduce((s, c) => s + c, 0);
  expect(rootTotal).toBe(1);

  // in flight — uncapped, both the started and the reviewed task.
  expect(report.inFlight.count).toBe(2);
  expect(report.inFlight.tasks).toHaveLength(2);
  expect(report.inFlight.tasks.map((t) => t.status).toSorted()).toEqual([
    'in_progress',
    'under_review',
  ]);

  // next — true count 7, capped at 5.
  expect(report.next.count).toBe(7);
  expect(report.next.tasks).toHaveLength(5);
  expect(report.next.tasks.every((t) => t.status === 'ready')).toBe(true);

  // awaiting — the dependent, carrying the upstream id it awaits.
  expect(report.awaiting.count).toBe(1);
  expect(report.awaiting.tasks).toHaveLength(1);
  expect(report.awaiting.tasks[0]?.task.id).toBe(idOf(dependent));
  expect(report.awaiting.tasks[0]?.task.status).toBe('awaiting');
  expect(report.awaiting.tasks[0]?.awaitingOn).toEqual([idOf(prereq)]);

  // hygiene — counts only.
  expect(report.hygiene.untriaged).toBe(2);
  expect(report.hygiene.blocked).toBe(1);
  expect(report.hygiene.stale).toBe(0);
  expect(report.hygiene.dropped).toBe(0);
});

test.skipIf(!NORN)('empty sections carry a zero count', async () => {
  const report = await overviewOf(store, 'MMR');
  expect(report.inFlight).toEqual({ count: 0, tasks: [] });
  expect(report.next).toEqual({ count: 0, tasks: [] });
  expect(report.awaiting).toEqual({ count: 0, tasks: [] });
  expect(report.hygiene).toEqual({
    blocked: 0,
    dropped: 0,
    listings: { blocked: [], stale: [], untriaged: [] },
    stale: 0,
    untriaged: 0,
  });
  expect(report.sessions).toEqual({ count: 0, entries: [] });
  expect(report.direction).toEqual({ containers: [], project: null });
});

test.skipIf(!NORN)('stale hygiene counts tasks quiet past the threshold (asOf)', async () => {
  const started = await createTask(store, { parentId: phaseId, title: 'started' });
  await startTask(store, idOf(started));
  // 100 days after the task's touch — well past the 14-day stale threshold.
  const future = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000).toISOString();
  const report = await overviewOf(store, 'MMR', { asOf: future });
  expect(report.hygiene.stale).toBeGreaterThanOrEqual(1);
});

test.skipIf(!NORN)('an unknown scope key throws not_found', async () => {
  await expectMimirError('not_found', () => overviewOf(store, 'ZZZ'));
});

test.skipIf(!NORN)('an archived project 404s like status/get (ADR 0015 hiding)', async () => {
  await archiveProject(store, 'MMR');
  await expectMimirError('not_found', () => overviewOf(store, 'MMR'));
});

// ─── Recent sessions (MMR-322, ADR 0026 Decision 4) ─────────────────────────

test.skipIf(!NORN)('sessions group the transition rows a session handle stamped', async () => {
  const one = await createTask(store, { parentId: phaseId, title: 'one' });
  const two = await createTask(store, { parentId: phaseId, title: 'two' });
  await startTask(store, idOf(one), { session: 's-alpha' });
  await submitTask(store, idOf(one));
  await startTask(store, idOf(two), { session: 's-alpha' });

  const report = await overviewOf(store, 'MMR');
  expect(report.sessions.count).toBe(1);
  const [entry] = report.sessions.entries;
  expect(entry?.id).toBe('s-alpha');
  // `start` stamps the handles and echoes them; `submit` KEEPS them and echoes
  // nothing (MMR-320), so the two claims are the two grouped rows.
  expect(entry?.transitions).toBe(2);
  expect(entry?.tasks.map((t) => t.id).toSorted()).toEqual([idOf(one), idOf(two)]);
  expect((entry?.from ?? '') <= (entry?.to ?? '')).toBe(true);
});

test.skipIf(!NORN)('rows with no session handle are part of no group (legacy)', async () => {
  // A start with no handles writes a row byte-identical to a pre-MMR-320 one.
  const task = await createTask(store, { parentId: phaseId, title: 'unclaimed' });
  await startTask(store, idOf(task));
  const report = await overviewOf(store, 'MMR');
  expect(report.sessions).toEqual({ count: 0, entries: [] });
});

test.skipIf(!NORN)('a session_summary artifact joins its overlapping group', async () => {
  const task = await createTask(store, { parentId: phaseId, title: 'claimed' });
  await startTask(store, idOf(task), { session: 's-beta' });
  const { renderedId } = await attachArtifact(store, {
    content: '# retro',
    linkNodeIds: [await nodeIdOf(store, idOf(task))],
    projectId,
    summary: 'landed the codec',
    tags: ['session_summary'],
    title: 'session retro',
  });

  const report = await overviewOf(store, 'MMR');
  expect(report.sessions.count).toBe(1);
  expect(report.sessions.entries[0]?.id).toBe('s-beta');
  expect(report.sessions.entries[0]?.artifact).toEqual({
    id: renderedId,
    summary: 'landed the codec',
    title: 'session retro',
  });
});

test.skipIf(!NORN)('an untagged artifact never joins a session entry', async () => {
  const task = await createTask(store, { parentId: phaseId, title: 'claimed' });
  await startTask(store, idOf(task), { session: 's-gamma' });
  await attachArtifact(store, {
    content: '# design',
    linkNodeIds: [await nodeIdOf(store, idOf(task))],
    projectId,
    tags: ['design'],
    title: 'a design note',
  });
  const report = await overviewOf(store, 'MMR');
  expect(report.sessions.entries[0]?.artifact).toBeUndefined();
});

test.skipIf(!NORN)('a summary linking no touched task keeps its own entry', async () => {
  const claimed = await createTask(store, { parentId: phaseId, title: 'claimed' });
  await startTask(store, idOf(claimed), { session: 's-delta' });
  const untouched = await createTask(store, { parentId: phaseId, title: 'untouched' });
  await attachArtifact(store, {
    content: '# exploration',
    linkNodeIds: [await nodeIdOf(store, idOf(untouched))],
    projectId,
    summary: 'read the vault layout',
    tags: ['session_summary'],
    title: 'knowledge only',
  });

  const report = await overviewOf(store, 'MMR');
  expect(report.sessions.count).toBe(2);
  const orphan = report.sessions.entries.find((e) => e.id === null);
  expect(orphan?.transitions).toBe(0);
  expect(orphan?.tasks).toEqual([]);
  expect(orphan?.artifact?.title).toBe('knowledge only');
});

test.skipIf(!NORN)('the sessions section caps at 5 against a true count', async () => {
  for (let i = 0; i < 7; i += 1) {
    const task = await createTask(store, { parentId: phaseId, title: `t-${String(i)}` });
    await startTask(store, idOf(task), { session: `s-${String(i)}` });
  }
  const report = await overviewOf(store, 'MMR');
  expect(report.sessions.count).toBe(7);
  expect(report.sessions.entries).toHaveLength(5);
});

// ─── Needs-attention listings (MMR-322) ─────────────────────────────────────

test.skipIf(!NORN)('the blocked listing carries the lane word and the hold reason', async () => {
  const stuck = await createTask(store, { parentId: phaseId, title: 'stuck' });
  await blockTask(store, idOf(stuck), 'upstream API down');

  const report = await overviewOf(store, 'MMR');
  expect(report.hygiene.blocked).toBe(1);
  const [row] = report.hygiene.listings.blocked;
  expect(row?.task.id).toBe(idOf(stuck));
  expect(row?.task.holdReason).toBe('upstream API down');
  // `blocked` is the needs-unsticking lane (MMR-101 vocabulary, shared mapping).
  expect(row?.lane).toBe('needs_unsticking');
  expect(row?.stale).toBe(false);
});

test.skipIf(!NORN)('the stale listing rides the same asOf the count does', async () => {
  const started = await createTask(store, { parentId: phaseId, title: 'quiet' });
  await startTask(store, idOf(started));
  const future = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000).toISOString();
  const report = await overviewOf(store, 'MMR', { asOf: future });
  expect(report.hygiene.stale).toBeGreaterThanOrEqual(1);
  const row = report.hygiene.listings.stale.find((r) => r.task.id === idOf(started));
  expect(row?.stale).toBe(true);
  expect(row?.lane).toBe('live');
});

test.skipIf(!NORN)('listings cap at 5 while the counts stay true', async () => {
  for (let i = 0; i < 7; i += 1) {
    const task = await createTask(store, { parentId: phaseId, title: `stuck-${String(i)}` });
    await blockTask(store, idOf(task), 'external');
    await fileSeed(store, { kind: 'idea', project: 'MMR', title: `seed ${String(i)}` });
  }
  const report = await overviewOf(store, 'MMR');
  expect(report.hygiene.blocked).toBe(7);
  expect(report.hygiene.listings.blocked).toHaveLength(5);
  expect(report.hygiene.untriaged).toBe(7);
  expect(report.hygiene.listings.untriaged).toHaveLength(5);
});

test.skipIf(!NORN)('untriaged seed rows carry id, title, and the derived lede', async () => {
  const seed = await fileSeed(store, {
    description: 'the vault converge should report the schema it landed on',
    kind: 'idea',
    project: 'MMR',
    title: 'report the schema',
  });
  const report = await overviewOf(store, 'MMR');
  expect(report.hygiene.listings.untriaged).toEqual([
    {
      id: seed.id,
      lede: 'the vault converge should report the schema it landed on',
      title: 'report the schema',
    },
  ]);
});

// ─── Direction prose (MMR-322, ADR 0026 Decision 2) ──────────────────────────

test.skipIf(!NORN)('direction carries the project prose and live containers only', async () => {
  await updateProject(store, projectId, { next: 'finish the composition arc' });
  await updateNode(store, phaseId, { next: 'land phase 3' });
  const dormant = await createPhase(store, { parentId: initId, title: 'later' });
  await updateNode(store, await nodeIdOf(store, `MMR-${String(dormant.seq)}`), {
    next: 'not yet',
  });
  // Live work under the first phase only.
  await createTask(store, { parentId: phaseId, title: 'ready one' });

  const report = await overviewOf(store, 'MMR');
  expect(report.direction.project).toBe('finish the composition arc');
  expect(report.direction.containers).toEqual([
    { id: phaseStem, next: 'land phase 3', title: 'ph' },
  ]);
});

test.skipIf(!NORN)('a live container with no prose contributes no direction row', async () => {
  await createTask(store, { parentId: phaseId, title: 'ready one' });
  const report = await overviewOf(store, 'MMR');
  expect(report.direction).toEqual({ containers: [], project: null });
});

test.skipIf(!NORN)('a container parenting only in-flight work still shows its prose', async () => {
  await updateNode(store, phaseId, { next: 'drive the in-flight work home' });
  const task = await createTask(store, { parentId: phaseId, title: 'running' });
  await startTask(store, idOf(task));
  const report = await overviewOf(store, 'MMR');
  expect(report.direction.containers.map((c) => c.id)).toEqual([phaseStem]);
});

test.skipIf(!NORN)('a container is listed once however many live tasks it parents', async () => {
  await updateNode(store, phaseId, { next: 'one row, not three' });
  for (let i = 0; i < 3; i += 1) {
    await createTask(store, { parentId: phaseId, title: `t-${String(i)}` });
  }
  const report = await overviewOf(store, 'MMR');
  expect(report.direction.containers).toHaveLength(1);
});

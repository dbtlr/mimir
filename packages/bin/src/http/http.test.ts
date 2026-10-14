import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';

import { parseJson } from '@mimir/helpers';
import type { Server } from 'bun';

import {
  abandonTask,
  annotate,
  blockTask,
  completeTask,
  createInitiative,
  createPhase,
  createProject,
  createScratchpadService,
  createTask,
  depend,
  deriveSet,
  findNodeInSet,
  groomTasks,
  startTask,
  submitTask,
} from '../core';
import type { Store } from '../core';
import { SCHEMA_VERSION } from '../core/store-sql/migrator';
import { createTestStore, nodeIdOf, projectIdOf } from '../testing/store';
import { createServer } from './server';

/**
 * The resource envelope end-to-end: a real server on an ephemeral loopback
 * port over a real in-memory store — requests exercise routing, parsing, the
 * envelope, status mapping, and the origin rules exactly as a UI would.
 */

let store: Store;
let closeStore: () => Promise<void>;
let server: Server<undefined>;
let base: string;
let phaseRef: string;
let initiativeRef: string;
let task1: string;
let task2: string;
let otherTask: string;

type Rec = Record<string, unknown>;

beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
  await createProject(store, { key: 'MMR', name: 'Mimir' });
  const projectId = await projectIdOf(store, 'MMR');
  const init = await createInitiative(store, { projectId, title: 'build' });
  initiativeRef = `MMR-${String(init.seq)}`;
  const initId = await nodeIdOf(store, initiativeRef);
  const phase = await createPhase(store, { parentId: initId, title: 'phase 4' });
  phaseRef = `MMR-${String(phase.seq)}`;
  const phaseId = await nodeIdOf(store, phaseRef);
  const t1 = await createTask(store, { parentId: phaseId, title: 'first' });
  task1 = `MMR-${String(t1.seq)}`;
  const t2 = await createTask(store, { parentId: phaseId, priority: 'p1', title: 'second' });
  task2 = `MMR-${String(t2.seq)}`;

  await createProject(store, { key: 'NRN', name: 'Norn' });
  const otherProjectId = await projectIdOf(store, 'NRN');
  const otherInit = await createInitiative(store, { projectId: otherProjectId, title: 'other' });
  const otherInitId = await nodeIdOf(store, `NRN-${String(otherInit.seq)}`);
  const otherPhase = await createPhase(store, { parentId: otherInitId, title: 'op' });
  const otherPhaseId = await nodeIdOf(store, `NRN-${String(otherPhase.seq)}`);
  const ot = await createTask(store, { parentId: otherPhaseId, title: 'elsewhere' });
  otherTask = `NRN-${String(ot.seq)}`;

  server = createServer(store, { port: 0, version: '0.0.0-test' });
  base = `http://127.0.0.1:${String(server.port)}`;
});

afterEach(async () => {
  await server.stop(true);
  await closeStore();
});

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { headers });

const send = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method,
  });

const parse = async (res: Response): Promise<Rec> => parseJson<Rec>(await res.text());

const errorCode = (body: Rec): string => (body.error as { code: string }).code;

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

test('GET /api/health reports ok, the serving version, and the store schema', async () => {
  const res = await get('/api/health');
  expect(res.status).toBe(200);
  expect(await parse(res)).toEqual({ schema: SCHEMA_VERSION, status: 'ok', version: '0.0.0-test' });
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

test('GET /api/projects lists every project with its rollup', async () => {
  const res = await get('/api/projects');
  expect(res.status).toBe(200);
  const body = await parse(res);
  expect(body.total).toBe(2);
  const items = body.items as Rec[];
  expect(items.map((p) => p.id)).toEqual(['MMR', 'NRN']);
  expect(items[0]?.distribution).toBeDefined();
});

test('GET /api/projects and /api/projects/:key carry last_activity_at (MMR-494)', async () => {
  const later = '2099-01-01T00:00:00.000Z';
  await store.transact((w) =>
    w.appendTransition({
      at: later,
      from_value: 'a',
      kind: 'lifecycle',
      node_id: otherTask,
      to_value: 'b',
    }),
  );
  const items = (await parse(await get('/api/projects'))).items as Rec[];
  const byId = Object.fromEntries(items.map((p) => [p.id, p]));
  expect(byId.NRN?.last_activity_at).toBe(later);
  // the untouched project reports an instant at or after its own updated_at, never the other's
  expect(byId.MMR?.last_activity_at).not.toBe(later);
  expect(String(byId.MMR?.last_activity_at) >= String(byId.MMR?.updated_at)).toBe(true);
  const detail = await parse(await get('/api/projects/NRN'));
  expect(detail.last_activity_at).toBe(later);
});

test('GET /api/projects rows carry no attention facet (Lanes retired, MMR-476)', async () => {
  const res = await get('/api/projects');
  const items = (await parse(res)).items as Rec[];
  expect(items.length).toBeGreaterThan(0);
  for (const item of items) {
    expect('attention' in item).toBe(false);
  }
});

test('GET /api/projects leaves leaf_counts to the archived door, the only list that reads it', async () => {
  const items = (await parse(await get('/api/projects'))).items as Rec[];
  expect(items[0]?.id).toBe('MMR');
  expect(items[0]?.leaf_counts).toBeUndefined();
});

test('POST /api/projects creates and echoes the project record; duplicate keys conflict', async () => {
  const created = await send('POST', '/api/projects', { key: 'ZZZ', name: 'zed' });
  expect(created.status).toBe(201);
  expect((await parse(created)).id).toBe('ZZZ');

  const dup = await send('POST', '/api/projects', { key: 'MMR', name: 'again' });
  expect(dup.status).toBe(409);
});

test('POST /api/projects with description stores and echoes it (MMR-88)', async () => {
  const res = await send('POST', '/api/projects', {
    description: 'stores desc',
    key: 'DSC',
    name: 'Described',
  });
  expect(res.status).toBe(201);
  const body = await parse(res);
  expect(body.description).toBe('stores desc');
});

test('GET /api/projects/:key returns the project record; a node ref is rejected', async () => {
  const res = await get('/api/projects/MMR');
  expect(res.status).toBe(200);
  const body = await parse(res);
  expect(body.type).toBe('project');
  expect(body.children).toBeDefined();

  const wrong = await get(`/api/projects/${task1}`);
  expect(wrong.status).toBe(400);
});

test('PATCH /api/projects/:key patches name and description, echoes updated record (MMR-88)', async () => {
  const res = await send('PATCH', '/api/projects/MMR', {
    description: 'work tracker',
    name: 'Mimir Renamed',
  });
  expect(res.status).toBe(200);
  const body = await parse(res);
  expect(body.type).toBe('project');
  expect(body.id).toBe('MMR');
  expect(body.title).toBe('Mimir Renamed');
  expect(body.description).toBe('work tracker');
});

test('PATCH /api/projects/:key accepts title as alias for name (MMR-88)', async () => {
  const res = await send('PATCH', '/api/projects/MMR', { title: 'Via title' });
  expect(res.status).toBe(200);
  expect((await parse(res)).title).toBe('Via title');
});

test('PATCH /api/projects/:key on a non-existent project returns 404 (MMR-88)', async () => {
  const res = await send('PATCH', '/api/projects/NOPE', { name: 'x' });
  expect(res.status).toBe(404);
  expect(errorCode(await parse(res))).toBe('not_found');
});

test('PATCH /api/projects/:key with a node ref key returns 400 (MMR-88)', async () => {
  const res = await send('PATCH', `/api/projects/${task1}`, { name: 'x' });
  expect(res.status).toBe(400);
});

test('GET /api/projects/:key/tree nests the full hierarchy in board order', async () => {
  // Move task2 to the top of the rank order; the tree must reflect it positionally.
  await send('POST', `/api/nodes/${task2}/reorder`, { position: 'top' });

  const res = await get('/api/projects/MMR/tree');
  expect(res.status).toBe(200);
  const root = await parse(res);
  expect(root.id).toBe('MMR');
  const initiatives = root.children as Rec[];
  expect(initiatives.map((n) => n.id)).toEqual([initiativeRef]);
  const phases = initiatives[0]?.children as Rec[];
  expect(phases.map((n) => n.id)).toEqual([phaseRef]);
  const tasks = phases[0]?.children as Rec[];
  expect(tasks.map((n) => n.id)).toEqual([task2, task1]);
  // Rank is array order, never a field; verdicts ride every record.
  expect(tasks[0]).not.toContainKey('rank');
  expect(tasks[0]?.verdicts).toEqual({ blocking: false, orphaned: false, stale: false });
});

test('GET /api/projects/:key/tree 404s on an unknown project', async () => {
  const res = await get('/api/projects/NOPE/tree');
  expect(res.status).toBe(404);
  expect(errorCode(await parse(res))).toBe('not_found');
});

// The composite orientation surface as a resource read (MMR-322) — the same
// wire envelope the CLI `-f json` and the MCP `overview` tool emit.
test('GET /api/projects/:key/overview serves the composite envelope', async () => {
  const res = await get('/api/projects/MMR/overview');
  expect(res.status).toBe(200);
  const body = await parse(res);
  expect((body.project as Rec).id).toBe('MMR');
  expect((body.next as Rec).count).toBe(2);
  expect(body.in_flight).toEqual({ count: 0, tasks: [] });
  expect(body.sessions).toEqual({ entries: [], shown: 0 });
  expect(body.direction).toEqual({ containers: [], count: 0, project: null });
  expect((body.hygiene as Rec).listings).toEqual({ blocked: [], stale: [], untriaged: [] });
});

test('GET /api/projects/:key/overview 404s on an unknown project', async () => {
  const res = await get('/api/projects/NOPE/overview');
  expect(res.status).toBe(404);
  expect(errorCode(await parse(res))).toBe('not_found');
});

test('GET /api/projects/:key/overview 404s on an archived project', async () => {
  expect((await send('POST', '/api/projects/MMR/archive')).status).toBe(200);
  const res = await get('/api/projects/MMR/overview');
  expect(res.status).toBe(404);
  expect(errorCode(await parse(res))).toBe('not_found');
});

test('GET /api/projects/:key/overview rejects a node ref key', async () => {
  const res = await get(`/api/projects/${task1}/overview`);
  expect(res.status).toBe(400);
  expect(errorCode(await parse(res))).toBe('validation');
});

// The console work page (MMR-469): one derivation for a project or any container.
test('GET /api/projects/:key/work serves the sections for the whole project', async () => {
  const res = await get('/api/projects/MMR/work?tz=UTC');
  expect(res.status).toBe(200);
  const body = await parse(res);
  expect(body.scope).toEqual({ id: 'MMR', kind: 'project', title: 'Mimir' });
  const frontier = body.frontier as Rec;
  expect((frontier.to_groom as Rec[]).map((t) => t.id)).toEqual([task1, task2]);
  expect(frontier.runnable).toEqual([]);
  expect(frontier.next_to_unlock).toEqual([]);
  expect(body.now).toEqual([]);
  expect(body.needs_you).toEqual([]);
  expect(body.shipped).toEqual([]);
  expect(body.going_cold).toEqual([]);
});

test('GET /api/nodes/:id/work scopes the page to a container subtree', async () => {
  const res = await get(`/api/nodes/${phaseRef}/work?tz=UTC`);
  expect(res.status).toBe(200);
  const body = await parse(res);
  expect(body.scope).toEqual({ id: phaseRef, kind: 'phase', title: 'phase 4' });
  const ids = ((body.frontier as Rec).to_groom as Rec[]).map((t) => t.id);
  expect(ids).toEqual([task1, task2]);
  const other = await parse(await get(`/api/nodes/${initiativeRef}/work?tz=UTC`));
  expect((other.scope as Rec).kind).toBe('initiative');
});

test('an empty phase is a break_down row in to_groom on the wire', async () => {
  const initId = await nodeIdOf(store, initiativeRef);
  const empty = await createPhase(store, { parentId: initId, title: 'to plan' });
  const emptyRef = `MMR-${String(empty.seq)}`;
  const body = await parse(await get(`/api/projects/MMR/work?tz=UTC`));
  const rows = (body.frontier as Rec).to_groom as Rec[];
  expect(rows.map((r) => r.id)).toEqual([task1, task2, emptyRef]);
  expect(rows.map((r) => [r.type, r.break_down])).toEqual([
    ['task', false],
    ['task', false],
    ['phase', true],
  ]);
  expect(rows[2]?.awaiting_on).toEqual([]);
});

test('GET /api/nodes/:id/work refuses a task id', async () => {
  const res = await get(`/api/nodes/${task1}/work?tz=UTC`);
  expect(res.status).toBe(400);
  expect(errorCode(await parse(res))).toBe('validation');
});

test('work routes 404 on an unknown id and send a project key to the other route', async () => {
  expect((await get('/api/nodes/MMR-999/work?tz=UTC')).status).toBe(404);
  expect((await get('/api/projects/NOPE/work?tz=UTC')).status).toBe(404);
  expect((await get('/api/nodes/MMR/work?tz=UTC')).status).toBe(400);
});

// The console review page (MMR-477): decisions, queue, triage, and the project list.
test('GET /api/review serves the snake_case review envelope', async () => {
  await startTask(store, task1);
  await submitTask(store, task1);
  await blockTask(store, otherTask, 'need a key', 'you');
  const res = await get('/api/review');
  expect(res.status).toBe(200);
  const body = await parse(res);
  expect(Object.keys(body).toSorted()).toEqual([
    'decisions',
    'going_cold',
    'last_finished',
    'now',
    'projects',
    'queue',
    'runnable',
    'shipped',
    'triage',
  ]);
  expect(body.last_finished).toBeNull();
  expect(body.queue).toEqual([task1, otherTask]);
  const decisions = body.decisions as Rec[];
  expect(decisions.map((g) => g.project)).toEqual([
    { key: 'MMR', name: 'Mimir' },
    { key: 'NRN', name: 'Norn' },
  ]);
  const row = ((decisions[0]?.rows ?? []) as Rec[])[0];
  expect(row).toMatchObject({ id: task1, question: null, reason: 'under_review', stale: false });
  expect(body.triage).toEqual([]);
  expect(
    (body.projects as Rec[]).toSorted((a, b) => String(a.key).localeCompare(String(b.key))),
  ).toEqual([
    { decisions: 1, going_cold: 0, in_flight: 0, key: 'MMR', live: 2, name: 'Mimir', triage: 0 },
    { decisions: 1, going_cold: 0, in_flight: 0, key: 'NRN', live: 1, name: 'Norn', triage: 0 },
  ]);
});

test('GET /api/review serves the cross-project work rows, each with its project key', async () => {
  await startTask(store, task1);
  await completeTask(store, otherTask);
  const body = await parse(await get('/api/review?tz=UTC'));
  expect((body.now as Rec[]).map((r) => [r.project, r.id])).toEqual([['MMR', task1]]);
  expect(body.now).toEqual([
    expect.objectContaining({ project: 'MMR', scratchpads: [], stale: false }),
  ]);
  expect(typeof ((body.now as Rec[])[0] as Rec).started_at).toBe('string');
  expect((body.shipped as Rec[]).map((r) => [r.project, r.id])).toEqual([['NRN', otherTask]]);
  expect(typeof ((body.shipped as Rec[])[0] as Rec).finished_at).toBe('string');
  expect(Array.isArray(body.runnable)).toBe(true);
  expect(body.going_cold).toEqual([]);
});

test('GET /api/review leaves shipped empty without a zone and refuses an unknown one', async () => {
  await completeTask(store, task1);
  expect((await parse(await get('/api/review'))).shipped).toEqual([]);
  expect((await get('/api/review?tz=Mars/Olympus')).status).toBe(400);
});

test('GET /api/review names the last finish with its finish time', async () => {
  await completeTask(store, task1);
  const body = await parse(await get('/api/review'));
  expect(body.last_finished).toMatchObject({ abandon_reason: null, id: task1, stale: false });
  expect(typeof (body.last_finished as Rec).finished_at).toBe('string');
});

test('GET /api/review still answers when the doctor scan fails, counting no findings', async () => {
  const logged = spyOn(console, 'error').mockImplementation(() => {});
  await send('POST', '/api/seeds', { kind: 'idea', project: 'NRN', title: 'an idea' });
  const failingServer = createServer(store, {
    doctor: () => Promise.reject(new Error('doctor scan failed')),
    port: 0,
    version: '0.0.0-test',
  });
  try {
    const res = await fetch(`http://127.0.0.1:${String(failingServer.port)}/api/review`);
    expect(res.status).toBe(200);
    const triage = (await parse(res)).triage as Rec[];
    expect(triage.map((g) => [(g.project as Rec).key, g.findings])).toEqual([['NRN', 0]]);
    // The operator still learns the scan failed: the serve log says so.
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('doctor scan failed'));
  } finally {
    logged.mockRestore();
    await failingServer.stop(true);
  }
});

test('GET /api/review counts the injected doctor findings per active project', async () => {
  await send('POST', '/api/seeds', { kind: 'idea', project: 'NRN', title: 'an idea' });
  const doctorServer = createServer(store, {
    doctor: async () => ({
      finding_total: 6,
      groups: [
        { finding_count: 2, project: 'MMR', records: [] },
        { finding_count: 4, project: 'store', records: [] },
      ],
      scanned_at: '2026-10-13T00:00:00.000Z',
      scope: null,
    }),
    port: 0,
    version: '0.0.0-test',
  });
  try {
    const res = await fetch(`http://127.0.0.1:${String(doctorServer.port)}/api/review`);
    expect(res.status).toBe(200);
    const body = await parse(res);
    const triage = body.triage as Rec[];
    expect(triage.map((g) => [(g.project as Rec).key, g.findings, g.going_cold])).toEqual([
      ['MMR', 2, 0],
      ['NRN', 0, 0],
    ]);
    expect(((triage[1]?.seeds as Rec[]) ?? []).map((s) => s.title)).toEqual(['an idea']);
  } finally {
    await doctorServer.stop(true);
  }
});

test('the projects work route names a task as a task and a container as a container', async () => {
  const taskRes = await get(`/api/projects/${task1}/work?tz=UTC`);
  expect(taskRes.status).toBe(400);
  const task = await parse(taskRes);
  expect(errorCode(task)).toBe('validation');
  expect((task.error as { message: string }).message).toContain('is a task');
  const container = await get(`/api/projects/${phaseRef}/work?tz=UTC`);
  expect(container.status).toBe(400);
  const hint = (await parse(container)).error as { hint?: string };
  expect(hint.hint).toContain(`/api/nodes/${phaseRef}/work`);
});

test('work routes require a known ?tz= (ADR 0029: no fallback zone)', async () => {
  for (const path of ['/api/projects/MMR/work', `/api/nodes/${phaseRef}/work`]) {
    const missing = await get(path);
    expect(missing.status).toBe(400);
    expect(errorCode(await parse(missing))).toBe('validation');
    const unknown = await get(`${path}?tz=Mars/Olympus`);
    expect(unknown.status).toBe(400);
    expect(errorCode(await parse(unknown))).toBe('validation');
  }
});

// Pins the wire vocabulary of every section on a populated board: snake_case keys,
// explicit nulls, and the row fields folded onto the task wire object.
test('the work page wire shape on a populated board', async () => {
  const phaseId = await nodeIdOf(store, phaseRef);
  const make = async (title: string): Promise<string> =>
    `MMR-${String((await createTask(store, { parentId: phaseId, title })).seq)}`;

  const working = await make('working');
  const quiet = await make('quiet');
  await startTask(store, working, { branch: 'feat/x', harness: 'claude' });
  await startTask(store, quiet);
  await annotate(store, working, 'halfway there');
  const pad = await createScratchpadService(store.scratchpads, store.artifacts, store).create({
    anchors: [working],
    project: 'MMR',
    title: 'notes',
  });

  const review = await make('review');
  await startTask(store, review);
  await submitTask(store, review);
  const question = await make('question');
  await groomTasks(store, [question], 'needs_answers', 'which database?');

  const prereq = await make('base');
  const waiting = await make('waiting');
  await depend(store, waiting, [prereq]);
  await groomTasks(store, [prereq, waiting], 'groomed');

  const blockedOthers = await make('blocked on others');
  await blockTask(store, blockedOthers, 'vendor fix', 'others');

  const done = await make('done');
  await completeTask(store, done);
  const dropped = await make('dropped');
  await abandonTask(store, dropped, 'superseded');

  const body = await parse(await get('/api/projects/MMR/work?tz=UTC'));
  const row = (rows: unknown, id: string): Rec =>
    (rows as Rec[]).find((r) => r.id === id) ?? { missing: id };

  const nowRows = body.now as Rec[];
  const workingRow = row(nowRows, working);
  expect(workingRow.harness).toBe('claude');
  expect(workingRow.branch).toBe('feat/x');
  expect(workingRow.latest_note).toEqual({
    content: 'halfway there',
    created_at: expect.any(String),
  });
  expect(workingRow.started_at).toEqual(expect.any(String));
  expect(workingRow.scratchpads).toEqual([{ id: pad.id, title: 'notes' }]);
  expect(workingRow.stale).toBe(false);
  expect(row(nowRows, quiet).latest_note).toBeNull();
  expect(row(nowRows, quiet).scratchpads).toEqual([]);

  const needsYou = body.needs_you as Rec[];
  expect(needsYou.map((r) => [r.id, r.reason, r.question])).toEqual([
    [review, 'under_review', null],
    [question, 'needs_answers', 'which database?'],
  ]);

  const frontier = body.frontier as Rec;
  const runnable = frontier.runnable as Rec[];
  expect(runnable.map((r) => [r.id, r.awaiting_on])).toEqual([[prereq, []]]);
  expect(frontier.next_to_unlock).toEqual([
    {
      prerequisite: { id: prereq, status: 'ready', title: 'base' },
      tasks: [expect.objectContaining({ awaiting_on: [prereq], id: waiting, stale: false })],
    },
  ]);
  expect((frontier.to_groom as Rec[]).map((r) => r.id)).toEqual([task1, task2]);

  expect(frontier.waiting_on_others).toEqual([
    expect.objectContaining({ block_reason: 'vendor fix', id: blockedOthers, stale: false }),
  ]);
  // No container reads to break down on this board; task rows always say so.
  expect((frontier.to_groom as Rec[]).every((r) => r.break_down === false)).toBe(true);
  expect(runnable.every((r) => r.break_down === false)).toBe(true);

  const shipped = body.shipped as Rec[];
  expect(row(shipped, done).abandon_reason).toBeNull();
  expect(row(shipped, done).finished_at).toEqual(expect.any(String));
  expect(row(shipped, dropped).abandon_reason).toBe('superseded');
  expect(body.going_cold).toEqual([]);
});

// ---------------------------------------------------------------------------
// Nodes — collection
// ---------------------------------------------------------------------------

test('GET /api/nodes is cross-project and includes containers by default', async () => {
  const body = await parse(await get('/api/nodes'));
  const ids = (body.items as Rec[]).map((n) => n.id);
  expect(ids).toContain(task1);
  expect(ids).toContain(otherTask);
  expect(ids).toContain(phaseRef);
  expect(ids).toContain(initiativeRef);
});

test('GET /api/nodes?type= and ?project= narrow the selection', async () => {
  const tasks = await parse(await get('/api/nodes?type=task'));
  const taskIds = (tasks.items as Rec[]).map((n) => n.id);
  expect(taskIds).toContain(task1);
  expect(taskIds).not.toContain(phaseRef);

  const scoped = await parse(await get('/api/nodes?project=NRN'));
  const scopedIds = (scoped.items as Rec[]).map((n) => n.id);
  expect(scopedIds).toContain(otherTask);
  expect(scopedIds).not.toContain(task1);
});

test('GET /api/nodes?q= filters by title substring, case-insensitive (MMR-78)', async () => {
  // "FIR" lowercases to a substring of "first" (task1) but not "elsewhere" (otherTask)
  const hit = await parse(await get('/api/nodes?q=FIR'));
  const ids = (hit.items as Rec[]).map((n) => n.id);
  expect(ids).toContain(task1);
  expect(ids).not.toContain(otherTask);

  const miss = await parse(await get('/api/nodes?q=zzz'));
  expect((miss.items as Rec[]).length).toBe(0);
});

test('GET /api/nodes?q= also matches the rendered id (MMR-454)', async () => {
  const hit = await parse(await get(`/api/nodes?q=${task1.toLowerCase()}`));
  const ids = (hit.items as Rec[]).map((n) => n.id);
  expect(ids).toContain(task1);
  expect(ids).not.toContain(otherTask);
});

test('GET /api/nodes?col=lede adds the list lede; without it no lede key rides (MMR-454)', async () => {
  const phaseId = await nodeIdOf(store, phaseRef);
  const described = await createTask(store, {
    description: 'Prose that **previews** the task.',
    parentId: phaseId,
    title: 'described',
  });
  const summarised = await createTask(store, {
    description: 'ignored',
    parentId: phaseId,
    summary: 'stored lede',
    title: 'summarised',
  });
  const describedRef = `MMR-${String(described.seq)}`;
  const summarisedRef = `MMR-${String(summarised.seq)}`;

  const plain = await parse(await get('/api/nodes?type=task'));
  for (const row of plain.items as Rec[]) {
    expect('lede' in row).toBe(false);
  }

  const withLede = await parse(await get('/api/nodes?type=task&col=lede'));
  const byId = new Map((withLede.items as Rec[]).map((n) => [n.id, n.lede] as const));
  expect(byId.get(describedRef)).toBe('Prose that previews the task.');
  expect(byId.get(summarisedRef)).toBe('stored lede');
  expect(byId.get(task1)).toBeNull();

  // Repeatable and comma-separated forms are both accepted.
  expect((await get('/api/nodes?col=lede&col=lede')).status).toBe(200);
  expect((await get('/api/nodes?col=lede,lede')).status).toBe(200);
});

test('GET /api/nodes?col= rejects a column outside the allowlist, naming the allowed ones (MMR-454)', async () => {
  const res = await get('/api/nodes?col=bogus');
  expect(res.status).toBe(400);
  const body = await parse(res);
  expect(errorCode(body)).toBe('validation');
  expect(JSON.stringify(body)).toContain('lede');
});

test('GET /api/nodes?status= selects the universe; terminal tasks appear under all', async () => {
  await send('POST', `/api/nodes/${task1}/done`);

  const live = await parse(await get('/api/nodes?type=task'));
  expect((live.items as Rec[]).map((n) => n.id)).not.toContain(task1);

  const all = await parse(await get('/api/nodes?type=task&status=all'));
  expect((all.items as Rec[]).map((n) => n.id)).toContain(task1);

  const done = await parse(await get('/api/nodes?type=task&status=done'));
  expect((done.items as Rec[]).map((n) => n.id)).toEqual([task1]);
});

test('GET /api/nodes?status= accepts a comma-separated union (MMR-228)', async () => {
  await send('POST', `/api/nodes/${task1}/done`);

  const union = await parse(await get('/api/nodes?type=task&status=ready,done'));
  const ids = (union.items as Rec[]).map((n) => n.id);
  expect(ids).toContain(task1); // done — the terminal side of the union
  expect(ids).toContain(task2); // ready — the live side
  expect(union.total).toBe(ids.length);

  // A union of words nothing carries is a clean empty set, not an error.
  const none = await parse(await get('/api/nodes?type=task&status=blocked,parked'));
  expect(none.items).toEqual([]);
});

test('a bad status value is a warning and an empty set, not an error', async () => {
  const res = await get('/api/nodes?status=bogus');
  expect(res.status).toBe(200);
  const body = await parse(res);
  expect(body.items).toEqual([]);
  const warnings = body.warnings as Rec[];
  expect(warnings[0]?.field).toBe('status');
  expect(warnings[0]?.expected).toContain('live');
});

test('list rows carry the home facet: project key + parent title/∞ (MMR-228)', async () => {
  // A standing (open-ended) home to exercise the ∞ marker field.
  const set = deriveSet(await store.loadWorkingSet());
  const init = findNodeInSet(set, initiativeRef);
  if (init === undefined) {
    throw new Error('fixture initiative missing');
  }
  const standing = await createPhase(store, {
    openEnded: true,
    parentId: init.id,
    title: 'Bugs',
  });
  await createTask(store, { parentId: standing.id, title: 'flaky test' });

  const body = await parse(await get('/api/nodes?type=task'));
  const rows = body.items as Rec[];
  const first = rows.find((n) => n.id === task1);
  expect(first?.home).toEqual({
    parent_id: phaseRef,
    parent_open_ended: null,
    parent_title: 'phase 4',
    project_key: 'MMR',
  });
  const filed = rows.find((n) => n.title === 'flaky test');
  const filedHome = filed?.home as Rec | undefined;
  expect(filedHome?.parent_open_ended).toBe(true);
  expect(filedHome?.parent_title).toBe('Bugs');
});

test('one bad token in a status union voids the selection with a warning (MMR-228)', async () => {
  const res = await get('/api/nodes?status=ready,bogus');
  expect(res.status).toBe(200);
  const body = await parse(res);
  expect(body.items).toEqual([]);
  const warnings = body.warnings as Rec[];
  expect(warnings[0]?.field).toBe('status');
  expect(warnings[0]?.value).toBe('bogus');
});

test('field operators filter; a bad field is a structural 400', async () => {
  const p1 = await parse(await get('/api/nodes?eq=priority:p1'));
  expect((p1.items as Rec[]).map((n) => n.id)).toEqual([task2]);

  const bad = await get('/api/nodes?eq=bogus:x');
  expect(bad.status).toBe(400);
  expect(errorCode(await parse(bad))).toBe('validation');
});

test('an unknown verdict and a bad limit are structural 400s; limit truncates', async () => {
  expect((await get('/api/nodes?is=bogus')).status).toBe(400);
  expect((await get('/api/nodes?limit=zero')).status).toBe(400);

  const limited = await parse(await get('/api/nodes?type=task&limit=1'));
  expect((limited.items as Rec[]).length).toBe(1);
  expect(limited.total as number).toBeGreaterThan(1);
});

test('GET /api/nodes pages a terminal list with limit and offset (MMR-460)', async () => {
  await send('POST', `/api/nodes/${task1}/done`);
  await send('POST', `/api/nodes/${task2}/done`);

  const read = async (query: string) => {
    const body = await parse(await get(`/api/nodes?type=task&status=terminal&col=lede&${query}`));
    return { ids: (body.items as Rec[]).map((n) => n.id), total: body.total };
  };
  const whole = await read('');
  expect(whole.ids).toHaveLength(2);

  expect(await read('limit=1')).toEqual({ ids: [whole.ids[0]], total: 2 });
  expect(await read('limit=1&offset=1')).toEqual({ ids: [whole.ids[1]], total: 2 });
  expect(await read('limit=1&offset=2')).toEqual({ ids: [], total: 2 });
  expect(await read('offset=1')).toEqual({ ids: [whole.ids[1]], total: 2 });

  expect((await get('/api/nodes?offset=-1')).status).toBe(400);
  expect((await get('/api/nodes?offset=one')).status).toBe(400);
});

// ---------------------------------------------------------------------------
// Nodes — detail
// ---------------------------------------------------------------------------

test('GET /api/nodes/:id returns the full record: verdicts on, artifacts listed, no rank field', async () => {
  const body = await parse(await get(`/api/nodes/${task1}`));
  expect(body.id).toBe(task1);
  expect(body.verdicts).toEqual({ blocking: false, orphaned: false, stale: false });
  expect(body.tags).toEqual([]);
  expect(body.artifacts).toEqual([]);
  expect(body.history).toEqual([]);
  expect(body).not.toContainKey('rank');
});

test('GET /api/nodes/:id carries the transition history facet (oldest-first, with reasons)', async () => {
  await send('POST', `/api/nodes/${task1}/start`);
  await send('POST', `/api/nodes/${task1}/park`, { reason: 'later' });
  const body = await parse(await get(`/api/nodes/${task1}`));
  const history = body.history as Rec[];
  expect(history.length).toBeGreaterThanOrEqual(2);
  // oldest-first: the lifecycle start precedes the hold
  expect(history[0]).toMatchObject({ kind: 'lifecycle', to: 'in_progress' });
  const park = history.find((h) => h.kind === 'hold' && h.to === 'parked');
  expect(park).toMatchObject({ reason: 'later' });
});

test('GET /api/nodes/:id rejects project and artifact identities, 404s the unknown', async () => {
  const project = await get('/api/nodes/MMR');
  expect(project.status).toBe(400);
  const artifact = await get('/api/nodes/MMR-a1');
  expect(artifact.status).toBe(400);
  const missing = await get('/api/nodes/MMR-999');
  expect(missing.status).toBe(404);
});

// ---------------------------------------------------------------------------
// Writes — lifecycle, holds, dependencies, structure
// ---------------------------------------------------------------------------

test('lifecycle actions echo the full updated record; an illegal transition is refused', async () => {
  const started = await send('POST', `/api/nodes/${task1}/start`);
  expect(started.status).toBe(200);
  const record = await parse(started);
  expect(record.lifecycle).toBe('in_progress');
  expect(record.status).toBe('in_progress');

  // The core codes illegal transitions `validation` (Phase-3 vocabulary) → 400.
  const again = await send('POST', `/api/nodes/${task1}/start`);
  expect(again.status).toBe(400);
  expect(errorCode(await parse(again))).toBe('validation');

  const done = await parse(await send('POST', `/api/nodes/${task1}/done`));
  expect(done.lifecycle).toBe('done');

  const abandoned = await parse(
    await send('POST', `/api/nodes/${task2}/abandon`, { reason: 'obsolete' }),
  );
  expect(abandoned.status).toBe('abandoned');
});

test('submit/return drive the under_review gate; approval is done (MMR-84)', async () => {
  await send('POST', `/api/nodes/${task1}/start`);
  const submitted = await parse(await send('POST', `/api/nodes/${task1}/submit`));
  expect(submitted.lifecycle).toBe('under_review');
  expect(submitted.status).toBe('under_review');

  // submit is legal only from in_progress.
  const reSubmit = await send('POST', `/api/nodes/${task1}/submit`);
  expect(reSubmit.status).toBe(400);

  const returned = await parse(
    await send('POST', `/api/nodes/${task1}/return`, { reason: 'tweak the copy' }),
  );
  expect(returned.lifecycle).toBe('in_progress');

  // resubmit then approve via done.
  await send('POST', `/api/nodes/${task1}/submit`);
  const approved = await parse(await send('POST', `/api/nodes/${task1}/done`));
  expect(approved.lifecycle).toBe('done');
});

test('hold actions set and clear the overlay', async () => {
  const parked = await parse(await send('POST', `/api/nodes/${task1}/park`, { reason: 'later' }));
  expect(parked.status).toBe('parked');
  expect(parked.hold_reason).toBe('later');
  const unparked = await parse(await send('POST', `/api/nodes/${task1}/unpark`));
  expect(unparked.status).toBe('ready');

  const blocked = await parse(await send('POST', `/api/nodes/${task1}/block`));
  expect(blocked.status).toBe('blocked');
  const unblocked = await parse(await send('POST', `/api/nodes/${task1}/unblock`));
  expect(unblocked.status).toBe('ready');
});

test('block records its owner: on states it, the default follows the upstream, and the echo carries it (MMR-465)', async () => {
  const stated = await parse(await send('POST', `/api/nodes/${task1}/block`, { on: 'others' }));
  expect(stated.block_owner).toBe('others');
  const released = await parse(await send('POST', `/api/nodes/${task1}/unblock`));
  expect(released.block_owner).toBeNull();

  const defaulted = await parse(await send('POST', `/api/nodes/${task1}/block`, { reason: 'x' }));
  expect(defaulted.block_owner).toBe('you');
  await send('POST', `/api/nodes/${task1}/unblock`);

  await send('PATCH', `/api/nodes/${task1}`, { upstream: 'NRN-s3' });
  const asked = await parse(await send('POST', `/api/nodes/${task1}/block`));
  expect(asked.block_owner).toBe('others');
});

test('block refuses an owner outside you|others before touching the task, and only block takes on', async () => {
  const bad = await send('POST', `/api/nodes/${task1}/block`, { on: 'maybe' });
  expect(bad.status).toBe(400);
  const error = (await parse(bad)).error as Rec;
  expect(error.message).toBe('invalid on: maybe');
  expect(error.hint).toBe('block on takes one of: you, others');
  expect((await parse(await get(`/api/nodes/${task1}`))).status).toBe('ready');

  expect((await send('POST', `/api/nodes/${task1}/block`, { on: 3 })).status).toBe(400);
  // `on` is not a body key of any other verb.
  expect((await send('POST', `/api/nodes/${task1}/park`, { on: 'you' })).status).toBe(400);
});

test('depend/undepend wire the graph and flip the derived word; a cycle is refused', async () => {
  const awaiting = await parse(await send('POST', `/api/nodes/${task2}/depend`, { on: task1 }));
  expect(awaiting.status).toBe('awaiting');
  const deps = awaiting.deps as { depends_on: { id: string }[] };
  expect(deps.depends_on.map((d) => d.id)).toEqual([task1]);

  const cycle = await send('POST', `/api/nodes/${task1}/depend`, { on: task2 });
  expect(cycle.status).toBe(400);

  const freed = await parse(await send('POST', `/api/nodes/${task2}/undepend`, { on: task1 }));
  expect(freed.status).toBe('ready');
});

test('move reparents; reorder accepts both spellings and requires a position', async () => {
  const moved = await parse(await send('POST', `/api/nodes/${task1}/move`, { to: initiativeRef }));
  expect(moved.parent).toBe(initiativeRef);

  expect((await send('POST', `/api/nodes/${task2}/reorder`, { position: 'top' })).status).toBe(200);
  expect((await send('POST', `/api/nodes/${task2}/reorder`, { after: task1 })).status).toBe(200);
  expect((await send('POST', `/api/nodes/${task2}/reorder`, {})).status).toBe(400);

  // A container id is refused in reorder's own terms, not the start verb's.
  const refused = await send('POST', `/api/nodes/${initiativeRef}/reorder`, { position: 'top' });
  expect(refused.status).toBe(400);
  const body = (await refused.json()) as { error: { message: string; hint: string } };
  expect(body.error.message).toBe(`${initiativeRef} is an initiative, not a task`);
  expect(body.error.hint).toContain('only tasks carry rank');
  expect(body.error.hint).not.toContain("aren't started");
});

// ---------------------------------------------------------------------------
// Writes — update, annotations, tags, create, attach
// ---------------------------------------------------------------------------

test('PATCH /api/nodes/:id is exactly the dumb update; lifecycle through it is structural', async () => {
  const res = await send('PATCH', `/api/nodes/${task1}`, { priority: 'p0', title: 'renamed' });
  expect(res.status).toBe(200);
  const body = await parse(res);
  expect(body.title).toBe('renamed');
  expect(body.priority).toBe('p0');

  const illegal = await send('PATCH', `/api/nodes/${task1}`, { lifecycle: 'done' });
  expect(illegal.status).toBe(400);
  expect(errorCode(await parse(illegal))).toBe('validation');
});

test('PATCH /api/nodes/:id upstream "none" clears a set seed pointer (set-then-clear roundtrip, MMR-301)', async () => {
  const set = await send('PATCH', `/api/nodes/${task1}`, { upstream: 'NRN-s3' });
  expect(set.status).toBe(200);
  expect((await parse(set)).upstream).toBe('NRN-s3');

  const cleared = await send('PATCH', `/api/nodes/${task1}`, { upstream: 'none' });
  expect(cleared.status).toBe(200);
  expect((await parse(cleared)).upstream).toBeNull();
});

test('PATCH /api/nodes/:id upstream "none" on an already-empty upstream is idempotent (MMR-301)', async () => {
  const cleared = await send('PATCH', `/api/nodes/${task1}`, { upstream: 'none' });
  expect(cleared.status).toBe(200);
  expect((await parse(cleared)).upstream).toBeNull();
});

test('PATCH /api/nodes/:id upstream "" (blank) is still rejected, not treated as clear (MMR-301)', async () => {
  const res = await send('PATCH', `/api/nodes/${task1}`, { upstream: '' });
  expect(res.status).toBe(400);
  expect(errorCode(await parse(res))).toBe('validation');
});

test('PATCH /api/nodes/:id upstream "none" leaves an unrelated field untouched (MMR-301)', async () => {
  const res = await send('PATCH', `/api/nodes/${task1}`, {
    title: 'renamed via clear',
    upstream: 'none',
  });
  expect(res.status).toBe(200);
  const body = await parse(res);
  expect(body.upstream).toBeNull();
  expect(body.title).toBe('renamed via clear');
});

test('annotations: POST appends (201), GET lists the sub-resource', async () => {
  const created = await send('POST', `/api/nodes/${task1}/annotations`, { content: 'a note' });
  expect(created.status).toBe(201);

  const listed = await parse(await get(`/api/nodes/${task1}/annotations`));
  expect(listed.total).toBe(1);
  expect((listed.items as Rec[])[0]?.content).toBe('a note');
});

test('tags: PUT applies (idempotently), DELETE removes', async () => {
  const tagged = await parse(await send('PUT', `/api/nodes/${task1}/tags/urgent`));
  const tags = tagged.tags as { tag: string }[];
  expect(tags.map((t) => t.tag)).toEqual(['urgent']);

  // Re-applying the same tag is idempotent — the row is kept as-is.
  const reapplied = await parse(await send('PUT', `/api/nodes/${task1}/tags/urgent`));
  expect((reapplied.tags as { tag: string }[]).map((t) => t.tag)).toEqual(['urgent']);

  // A tag application carries no note on any entity (ADR 0005 Refinement,
  // MMR-270): the route takes no body fields, so a `note` is rejected as unknown.
  const withNote = await send('PUT', `/api/nodes/${task1}/tags/urgent`, { note: 'why' });
  expect(withNote.status).toBe(400);

  const untagged = await parse(await send('DELETE', `/api/nodes/${task1}/tags/urgent`));
  expect(untagged.tags).toEqual([]);
});

test('groom: POST /api/nodes/:id/groom sets the state, writes the note, echoes the node (ADR 0033)', async () => {
  expect((await parse(await get(`/api/nodes/${task1}`))).grooming).toBe('not_groomed');

  const asked = await send('POST', `/api/nodes/${task1}/groom`, {
    note: 'which store owns the lock?',
    state: 'needs_answers',
  });
  expect(asked.status).toBe(200);
  expect((await parse(asked)).grooming).toBe('needs_answers');
  const notes = await parse(await get(`/api/nodes/${task1}/annotations`));
  expect((notes.items as Rec[]).map((n) => n.content)).toEqual(['which store owns the lock?']);

  // Re-grooming without a note is allowed and writes no annotation.
  const groomed = await send('POST', `/api/nodes/${task1}/groom`, { state: 'groomed' });
  expect((await parse(groomed)).grooming).toBe('groomed');
  expect((await parse(await get(`/api/nodes/${task1}/annotations`))).total).toBe(1);
});

test('groom: refuses needs_answers without a note, an unknown state, a container, and stray keys', async () => {
  const noNote = await send('POST', `/api/nodes/${task1}/groom`, { state: 'needs_answers' });
  expect(noNote.status).toBe(400);
  expect(errorCode(await parse(noNote))).toBe('validation');

  const noState = await send('POST', `/api/nodes/${task1}/groom`, {});
  expect(noState.status).toBe(400);
  const badState = await send('POST', `/api/nodes/${task1}/groom`, { state: 'ready' });
  expect(badState.status).toBe(400);
  const stray = await send('POST', `/api/nodes/${task1}/groom`, { nope: 1, state: 'groomed' });
  expect(stray.status).toBe(400);

  const container = await send('POST', `/api/nodes/${phaseRef}/groom`, { state: 'groomed' });
  expect(container.status).toBe(400);
  expect((await send('POST', '/api/nodes/MMR-999/groom', { state: 'groomed' })).status).toBe(404);
  expect((await parse(await get(`/api/nodes/${task1}`))).grooming).toBe('not_groomed');
});

test('GET /api/nodes?eq=grooming:groomed narrows the set; POST /api/nodes accepts groomed on a task', async () => {
  const born = await send('POST', '/api/nodes', {
    groomed: true,
    parent: phaseRef,
    title: 'carved',
    type: 'task',
  });
  expect(born.status).toBe(201);
  const record = await parse(born);
  expect(record.grooming).toBe('groomed');

  const narrowed = await parse(await get('/api/nodes?scope=MMR&eq=grooming:groomed'));
  expect((narrowed.items as Rec[]).map((n) => n.id)).toEqual([record.id as string]);

  const onPhase = await send('POST', '/api/nodes', {
    groomed: true,
    parent: initiativeRef,
    title: 'p',
    type: 'phase',
  });
  expect(onPhase.status).toBe(400);
  expect(errorCode(await parse(onPhase))).toBe('validation');
});

test('POST /api/nodes creates initiatives, phases, and tasks; bad types and parents are rejected', async () => {
  const init = await send('POST', '/api/nodes', {
    parent: 'NRN',
    title: 'grow',
    type: 'initiative',
  });
  expect(init.status).toBe(201);

  const task = await send('POST', '/api/nodes', {
    parent: phaseRef,
    priority: 'p2',
    tags: ['api'],
    title: 'new work',
    type: 'task',
  });
  expect(task.status).toBe(201);
  const record = await parse(task);
  expect(record.priority).toBe('p2');
  expect((record.tags as { tag: string }[]).map((t) => t.tag)).toEqual(['api']);

  expect(
    (await send('POST', '/api/nodes', { parent: 'x', title: 't', type: 'project' })).status,
  ).toBe(400);
  expect(
    (await send('POST', '/api/nodes', { parent: 'MMR', title: 't', type: 'task' })).status,
  ).toBe(400);
});

test('artifacts: POST freezes onto the node (201), GET returns content; cross-project links refused', async () => {
  const created = await send('POST', `/api/nodes/${task1}/artifacts`, {
    content: '# Spec\nbody',
    links: [task2],
    title: 'spec',
  });
  expect(created.status).toBe(201);
  const artifact = await parse(created);
  expect(artifact.id).toBe('MMR-a1');
  // The HTTP wire enriches links with the linked node's title + status (MMR-229).
  expect(artifact.links).toEqual([
    { id: task1, status: 'ready', title: 'first' },
    { id: task2, status: 'ready', title: 'second' },
  ]);

  const fetched = await parse(await get('/api/artifacts/MMR-a1'));
  expect(fetched.content).toBe('# Spec\nbody');
  expect((await get('/api/artifacts/MMR-a9')).status).toBe(404);

  const crossed = await send('POST', `/api/nodes/${task1}/artifacts`, {
    content: 'y',
    links: [otherTask],
    title: 'x',
  });
  expect(crossed.status).toBe(400);
});

test('artifacts: POST dedupes a link equal to the path anchor and a repeated link (MMR-305)', async () => {
  const created = await send('POST', `/api/nodes/${task1}/artifacts`, {
    content: 'body',
    links: [task1, task2, task2], // link==anchor, then a repeat
    title: 'deduped',
  });
  expect(created.status).toBe(201);
  const artifact = await parse(created);
  // The anchor leads; each node appears once, first-occurrence order preserved.
  expect((artifact.links as { id: string }[]).map((l) => l.id)).toEqual([task1, task2]);
});

test('artifacts: the 201 create body renders from the held record and equals a subsequent GET (MMR-283)', async () => {
  // task2 < task1 lexically is untrue here (MMR-2 < MMR-1 is false), so anchor
  // on task2 and link task1 to exercise the out-of-order-links → sorted-echo
  // path the same way a fresh read would sort them.
  const created = await send('POST', `/api/nodes/${task2}/artifacts`, {
    content: '# Spec\nbody\n',
    links: [task1],
    tags: ['kind:spec', 'v1'],
    title: 'held-record echo',
  });
  expect(created.status).toBe(201);
  const createdBody = await parse(created);

  const fetchedBody = await parse(await get(`/api/artifacts/${String(createdBody.id)}`));

  // Every field the 201 body renders must agree with an independent GET —
  // the wire contract is byte-identical whether it comes from the held
  // record or a re-read (created_at freshness and the content round-trip
  // included).
  expect(createdBody).toEqual(fetchedBody);
  expect(createdBody.content).toBe('# Spec\nbody');
  expect(createdBody.links).toEqual([
    { id: task1, status: 'ready', title: 'first' },
    { id: task2, status: 'ready', title: 'second' },
  ]);
});

test('artifact detail degrades a dangling link to its bare id (MMR-229)', async () => {
  // A link can outlive its target only through a hand edit at the database
  // (doctor's orphan-link finding). Serve the same data with the artifact
  // read carrying one resolvable and one dangling stem: the wire must degrade
  // the dangler to `{ id }` — no invented title/status, no crash.
  await send('POST', `/api/nodes/${task1}/artifacts`, { content: 'body', title: 'stale link' });
  const staleStore: Store = {
    ...store,
    artifacts: {
      ...store.artifacts,
      load: async (key, seq, opts) => {
        const record = await store.artifacts.load(key, seq, opts);
        return record === undefined ? undefined : { ...record, links: [task1, 'MMR-999'] };
      },
    },
  };
  const staleServer = createServer(staleStore, { port: 0, version: '0.0.0-test' });
  try {
    const res = await fetch(`http://127.0.0.1:${String(staleServer.port)}/api/artifacts/MMR-a1`);
    expect(res.status).toBe(200);
    const fetched = await parse(res);
    expect(fetched.links).toEqual([
      { id: task1, status: 'ready', title: 'first' },
      { id: 'MMR-999' },
    ]);
  } finally {
    await staleServer.stop(true);
  }
});

test('PATCH /api/artifacts/:id retitles; content frozen; unknown fields and blank titles 400 (MMR-40)', async () => {
  await send('POST', `/api/nodes/${task1}/artifacts`, { content: '# body', title: 'wrong' });

  const patched = await send('PATCH', '/api/artifacts/MMR-a1', { title: 'right' });
  expect(patched.status).toBe(200);
  const echo = await parse(patched);
  expect(echo.title).toBe('right');
  expect(echo.content).toBe('# body');

  // content is frozen — not a patchable field
  expect((await send('PATCH', '/api/artifacts/MMR-a1', { content: 'new' })).status).toBe(400);
  // blank title is validation
  expect((await send('PATCH', '/api/artifacts/MMR-a1', { title: ' ' })).status).toBe(400);
  // unknown artifact / node token on the artifact route
  const missing = await send('PATCH', '/api/artifacts/MMR-a9', { title: 'x' });
  expect(missing.status).toBe(404);
  // Voice guide: token-as-subject (MMR-290).
  const missingBody = (await parse(missing)) as { error: { message: string } };
  expect(missingBody.error.message).toBe("MMR-a9 doesn't exist");
  expect((await send('PATCH', `/api/artifacts/${task1}`, { title: 'x' })).status).toBe(404);
});

test('artifacts: the summary lede rides POST and PATCH, clears blank, and caps at 256 (MMR-319)', async () => {
  const created = await send('POST', `/api/nodes/${task1}/artifacts`, {
    content: '# body',
    summary: 'the lede',
    title: 'led',
  });
  expect(created.status).toBe(201);
  expect((await parse(created)).summary).toBe('the lede');
  expect((await parse(await get('/api/artifacts/MMR-a1'))).summary).toBe('the lede');
  // The cross-project feed carries it too.
  const listed = (await parse(await get('/api/artifacts'))) as { items: { summary?: string }[] };
  expect(listed.items[0]?.summary).toBe('the lede');

  const patched = await send('PATCH', '/api/artifacts/MMR-a1', { summary: 'a better lede' });
  expect(patched.status).toBe(200);
  expect((await parse(patched)).summary).toBe('a better lede');

  // A blank clears it — the key leaves the wire object entirely.
  const cleared = await send('PATCH', '/api/artifacts/MMR-a1', { summary: '  ' });
  expect(cleared.status).toBe(200);
  const clearedBody = await parse(cleared);
  expect(clearedBody.summary).toBeUndefined();
  expect(clearedBody.content).toBe('# body');

  // The cap is the node summary's, enforced core-side.
  expect((await send('PATCH', '/api/artifacts/MMR-a1', { summary: 'x'.repeat(257) })).status).toBe(
    400,
  );
  expect(
    (
      await send('POST', `/api/nodes/${task1}/artifacts`, {
        content: 'y',
        summary: 'x'.repeat(257),
        title: 'too long',
      })
    ).status,
  ).toBe(400);
});

test('POST /api/nodes/:id/reopen sends a done task back to in_progress (MMR-104)', async () => {
  await send('POST', `/api/nodes/${task1}/start`);
  await send('POST', `/api/nodes/${task1}/done`);
  const res = await send('POST', `/api/nodes/${task1}/reopen`, { reason: 'unverified' });
  expect(res.status).toBe(200);
  const record = await parse(res);
  expect(record.lifecycle).toBe('in_progress');
  expect(record.status).toBe('in_progress');
});

test('POST /api/nodes/:id/reopen on a live task returns 400 (MMR-104)', async () => {
  await send('POST', `/api/nodes/${task1}/start`);
  const res = await send('POST', `/api/nodes/${task1}/reopen`);
  expect(res.status).toBe(400);
});

// ---------------------------------------------------------------------------
// Transitions feed
// ---------------------------------------------------------------------------

test('GET /api/transitions pages by cursor: resume returns only newer entries', async () => {
  await send('POST', `/api/nodes/${task1}/start`);
  await send('POST', `/api/nodes/${task1}/done`);

  const first = await parse(await get('/api/transitions'));
  const items = first.items as Rec[];
  expect(items.length).toBeGreaterThanOrEqual(2);
  expect(items[0]?.node).toBe(task1);
  const cursor = first.next_cursor as string;
  expect(cursor).toBeDefined();

  const caughtUp = await parse(await get(`/api/transitions?since=${cursor}`));
  expect(caughtUp.items).toEqual([]);
  expect(caughtUp).not.toContainKey('next_cursor');

  await send('POST', `/api/nodes/${task2}/park`);
  const delta = await parse(await get(`/api/transitions?since=${cursor}`));
  expect((delta.items as Rec[]).length).toBe(1);
  expect((delta.items as Rec[])[0]?.kind).toBe('hold');

  expect((await get('/api/transitions?since=banana')).status).toBe(400);
});

test('GET /api/transitions?limit= truncates in log order', async () => {
  await send('POST', `/api/nodes/${task1}/start`);
  await send('POST', `/api/nodes/${task1}/done`);
  const body = await parse(await get('/api/transitions?limit=1'));
  expect((body.items as Rec[]).length).toBe(1);
});

// ---------------------------------------------------------------------------
// Protocol: bodies, fallbacks, origins
// ---------------------------------------------------------------------------

test('unknown body fields and malformed JSON are structural 400s', async () => {
  const unknown = await send('POST', `/api/nodes/${task1}/start`, { force: true });
  expect(unknown.status).toBe(400);

  const malformed = await fetch(`${base}/api/nodes/${task1}/park`, {
    body: '{not json',
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  expect(malformed.status).toBe(400);
});

test('unmatched routes get the 404 envelope', async () => {
  const res = await get('/api/bogus');
  expect(res.status).toBe(404);
  const body = await parse(res);
  expect(errorCode(body)).toBe('not_found');
  // Voice guide: token-as-subject, never the `no route …` headline form (MMR-290).
  expect((body as { error: { message: string } }).error.message).toBe("/api/bogus doesn't exist");
});

test('no origin gets a CORS grant, loopback dev origins included (MMR-426)', async () => {
  // The dev console reaches the API through the Vite proxy, same-origin; any
  // other page on loopback must not be able to read cross-origin.
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:4000', 'https://evil.example']) {
    const preflight = await fetch(`${base}/api/nodes`, { headers: { origin }, method: 'OPTIONS' });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
    expect(preflight.headers.get('access-control-allow-methods')).toBeNull();

    const read = await get('/api/nodes', { origin });
    expect(read.status).toBe(200);
    expect(read.headers.get('access-control-allow-origin')).toBeNull();
  }
});

test('browser writes from the same origin land: direct and through the Vite proxy (MMR-426)', async () => {
  const self = new URL(base).host;
  const proxied = { host: 'localhost:5173', origin: 'http://localhost:5173' };
  const direct = { host: self, origin: `http://${self}` };
  for (const [key, headers] of [
    ['DIR', direct],
    ['PXY', proxied],
  ] as const) {
    const res = await fetch(`${base}/api/projects`, {
      body: JSON.stringify({ key, name: key }),
      headers: { 'content-type': 'application/json', ...headers },
      method: 'POST',
    });
    expect(res.status).toBe(201);
  }
});

test('a cross-origin simple POST does not reach the board (MMR-426)', async () => {
  const res = await fetch(`${base}/api/projects`, {
    body: JSON.stringify({ key: 'EVL', name: 'evil' }),
    headers: { 'content-type': 'text/plain', origin: 'http://localhost:3000' },
    method: 'POST',
  });
  expect(res.status).toBe(403);
  expect((await get('/api/projects/EVL')).status).toBe(404);
});

// ---------------------------------------------------------------------------
// Derivation through the envelope
// ---------------------------------------------------------------------------

test("a prerequisite's terminal state frees the dependent through the API view", async () => {
  await send('POST', `/api/nodes/${task2}/depend`, { on: task1 });
  const prereq = findNodeInSet(deriveSet(await store.loadWorkingSet()), task1);
  if (prereq === undefined) {
    throw new Error(`fixture: no node ${task1}`);
  }
  await completeTask(store, prereq.id);

  const body = await parse(await get(`/api/nodes/${task2}`));
  expect(body.status).toBe('ready');
});

// --- project archive (ADR 0015, MMR-123) ---

test('POST archive freezes + hides a project; the door and unarchive round-trip', async () => {
  // an artifact so the archived list's artifact_count facet has something to count
  const frozen1 = await send('POST', `/api/nodes/${task1}/artifacts`, {
    content: 'frozen body',
    title: 'design',
  });
  expect(frozen1.status).toBe(201);

  // archive echoes the project with its archived_at
  const arc = await send('POST', '/api/projects/MMR/archive', { reason: 'superseded' });
  expect(arc.status).toBe(200);
  expect((await parse(arc)).archived_at).not.toBeUndefined();

  // hidden from the default project list; visible via the door; a sibling stays
  const active = await parse(await get('/api/projects'));
  expect((active.items as Rec[]).map((p) => p.id)).toEqual(['NRN']);
  // artifact_count is archived-door-only: the active list backs the UI's 10s
  // poll, which never reads it, so it must not pay the per-project artifact read
  expect((active.items as Rec[])[0]?.artifact_count).toBeUndefined();
  const archived = await parse(await get('/api/projects?status=archived'));
  expect((archived.items as Rec[]).map((p) => p.id)).toEqual(['MMR']);
  // the shelf's count line rides the list facets (MMR-125): the archived-404
  // detail route can't serve them, so the list row carries archived_at,
  // leaf_counts, and the artifact tally
  const shelfRow = (archived.items as Rec[])[0];
  expect(shelfRow?.archived_at).not.toBeUndefined();
  expect(shelfRow?.artifact_count).toBe(1);
  expect(shelfRow?.leaf_counts).not.toBeUndefined();
  const all = await parse(await get('/api/projects?status=all'));
  expect((all.items as { id: string }[]).map((p) => p.id).toSorted()).toEqual(['MMR', 'NRN']);

  // direct reads 404; a mutation under it is a conflict
  expect((await get('/api/projects/MMR')).status).toBe(404);
  expect((await get(`/api/nodes/${task1}`)).status).toBe(404);
  const frozen = await send('POST', `/api/nodes/${task1}/start`);
  expect(frozen.status).toBeGreaterThanOrEqual(400);
  expect(errorCode(await parse(frozen))).toBe('conflict');

  // unarchive restores everything
  const un = await send('POST', '/api/projects/MMR/unarchive');
  expect(un.status).toBe(200);
  expect((await parse(un)).archived_at).toBeUndefined();
  expect((await get('/api/projects/MMR')).status).toBe(200);
  expect((await get(`/api/nodes/${task1}`)).status).toBe(200);
});

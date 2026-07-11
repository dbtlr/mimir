import { afterEach, beforeEach, expect, test } from 'bun:test';

import { parseJson } from '@mimir/helpers';
import type { Server } from 'bun';

import {
  completeTask,
  createInitiative,
  createPhase,
  createProject,
  createSqliteStore,
  createTask,
  deriveSet,
  findNodeInSet,
} from '../core';
import type { Db, Store } from '../core';
import { createTestDb } from '../db/testing';
import { VAULT_SCHEMA } from '../vault';
import { createServer } from './server';

/**
 * The resource envelope end-to-end: a real server on an ephemeral loopback
 * port over a real in-memory DB — requests exercise routing, parsing, the
 * envelope, status mapping, and CORS exactly as a UI would.
 */

let db: Db;
let store: Store;
let server: Server<undefined>;
let base: string;
let phaseRef: string;
let initiativeRef: string;
let task1: string;
let task2: string;
let otherTask: string;

type Rec = Record<string, unknown>;

beforeEach(async () => {
  db = await createTestDb();
  store = createSqliteStore(db);
  const p = await createProject(store, { key: 'MMR', name: 'Mimir' });
  const init = await createInitiative(store, { projectId: p.id, title: 'build' });
  initiativeRef = `MMR-${String(init.seq)}`;
  const phase = await createPhase(store, { parentId: init.id, title: 'phase 4' });
  phaseRef = `MMR-${String(phase.seq)}`;
  const t1 = await createTask(store, { parentId: phase.id, title: 'first' });
  task1 = `MMR-${String(t1.seq)}`;
  const t2 = await createTask(store, { parentId: phase.id, priority: 'p1', title: 'second' });
  task2 = `MMR-${String(t2.seq)}`;

  const other = await createProject(store, { key: 'NRN', name: 'Norn' });
  const otherInit = await createInitiative(store, { projectId: other.id, title: 'other' });
  const otherPhase = await createPhase(store, { parentId: otherInit.id, title: 'op' });
  const ot = await createTask(store, { parentId: otherPhase.id, title: 'elsewhere' });
  otherTask = `NRN-${String(ot.seq)}`;

  server = createServer(createSqliteStore(db), { port: 0, version: '0.0.0-test' });
  base = `http://127.0.0.1:${String(server.port)}`;
});

afterEach(async () => {
  await server.stop(true);
  await db.destroy();
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

test('GET /api/health reports ok, the serving version, and the vault schema', async () => {
  const res = await get('/api/health');
  expect(res.status).toBe(200);
  expect(await parse(res)).toEqual({ schema: VAULT_SCHEMA, status: 'ok', version: '0.0.0-test' });
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

test('GET /api/projects carries the attention facet in snake_case (MMR-101)', async () => {
  const res = await get('/api/projects');
  const items = (await parse(res)).items as Rec[];
  // both seeded projects have only fresh (ready) leaf tasks → the live lane
  const attention = items[0]?.attention as Rec;
  expect(attention).toBeDefined();
  expect(attention.lane).toBe('live');
  expect(typeof attention.last_activity).toBe('string');
  expect(attention.stale).toBe(false);
});

test('GET /api/projects carries the leaf_counts facet for the card vitals (MMR-105)', async () => {
  const res = await get('/api/projects');
  const items = (await parse(res)).items as Rec[];
  // MMR's two seeded leaf tasks are both fresh → ready: 2 (snake_case wire key)
  expect(items[0]?.id).toBe('MMR');
  expect(items[0]?.leaf_counts).toEqual({ ready: 2 });
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

test('annotations: POST appends (201), GET lists the sub-resource', async () => {
  const created = await send('POST', `/api/nodes/${task1}/annotations`, { content: 'a note' });
  expect(created.status).toBe(201);

  const listed = await parse(await get(`/api/nodes/${task1}/annotations`));
  expect(listed.total).toBe(1);
  expect((listed.items as Rec[])[0]?.content).toBe('a note');
});

test('tags: PUT applies (idempotently, with a note), DELETE removes', async () => {
  const tagged = await parse(await send('PUT', `/api/nodes/${task1}/tags/urgent`, { note: 'why' }));
  const tags = tagged.tags as { tag: string; note: string | null }[];
  expect(tags.map((t) => t.tag)).toEqual(['urgent']);
  expect(tags[0]?.note).toBe('why');

  const untagged = await parse(await send('DELETE', `/api/nodes/${task1}/tags/urgent`));
  expect(untagged.tags).toEqual([]);
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

test('artifact detail degrades a dangling link to its bare id (MMR-229)', async () => {
  // SQLite FK-enforces links, but the vault backend stores them as file
  // frontmatter stems that can go stale. Serve the same data with the artifact
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
  expect((await send('PATCH', '/api/artifacts/MMR-a9', { title: 'x' })).status).toBe(404);
  expect((await send('PATCH', `/api/artifacts/${task1}`, { title: 'x' })).status).toBe(404);
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
// Protocol: bodies, fallbacks, CORS
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
  expect(errorCode(await parse(res))).toBe('not_found');
});

test('CORS: localhost dev origins are reflected, others get no grant', async () => {
  const preflight = await fetch(`${base}/api/nodes`, {
    headers: { origin: 'http://localhost:5173' },
    method: 'OPTIONS',
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');

  const dev = await get('/api/nodes', { origin: 'http://127.0.0.1:4000' });
  expect(dev.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:4000');

  const foreign = await get('/api/nodes', { origin: 'https://evil.example' });
  expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
  expect(foreign.status).toBe(200);
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

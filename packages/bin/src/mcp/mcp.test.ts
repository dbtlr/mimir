import { afterEach, beforeEach, expect, test } from 'bun:test';

import { parseJson } from '@mimir/helpers';

import {
  createInitiative,
  createPhase,
  createProject,
  createSqliteStore,
  createTask,
  findNodeByRef,
} from '../core';
import type { Db, Store } from '../core';
import { createTestDb } from '../db/testing';
import { buildMcpServer } from './server';
import {
  toolAnnotate,
  toolAttach,
  toolAbandon,
  toolArchive,
  toolBlock,
  toolCreate,
  toolDepend,
  toolDone,
  toolGet,
  toolList,
  toolMove,
  toolNext,
  toolPark,
  toolReopen,
  toolReorder,
  toolStart,
  toolStatus,
  toolTag,
  toolUnarchive,
  toolUnblock,
  toolUndepend,
  toolUnpark,
  toolUntag,
  toolUpdate,
} from './tools';

let db: Db;
let store: Store;
let phaseId: number;
let phaseRef: string;
let taskRef: string;
let initiativeId: number;

beforeEach(async () => {
  db = await createTestDb();
  store = createSqliteStore(db);
  const p = await createProject(store, { key: 'MMR', name: 'm' });
  const init = await createInitiative(store, { projectId: p.id, title: 'i' });
  initiativeId = init.id;
  const phase = await createPhase(store, { parentId: init.id, title: 'ph' });
  phaseId = phase.id;
  phaseRef = `MMR-${String(phase.seq)}`;
  const task = await createTask(store, { parentId: phase.id, title: 't' });
  taskRef = `MMR-${String(task.seq)}`;
});
afterEach(async () => {
  await db.destroy();
});

const textOf = (result: { content: { text: string }[] }) =>
  result.content.map((c) => c.text).join('');

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

test('buildMcpServer registers tools without throwing', () => {
  expect(() => buildMcpServer(store, '0.0.0')).not.toThrow();
});

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

test('next tool returns the structured envelope', async () => {
  await createTask(store, { parentId: phaseId, title: 'first' });
  const result = await toolNext(store, { scope: 'MMR' });
  expect(result.isError).toBeUndefined();
  const parsed = parseJson<{ total: number; tasks: { title: string }[] }>(textOf(result));
  // +1 because beforeEach creates a task too
  expect(parsed.total).toBeGreaterThanOrEqual(1);
  expect(parsed.tasks.some((t) => t.title === 'first')).toBe(true);
});

test('get tool returns a bare node; a missing id returns the structured error envelope', async () => {
  const ok = await toolGet(store, { id: taskRef });
  expect(ok.isError).toBeUndefined();
  expect(parseJson<{ title: string }>(textOf(ok)).title).toBe('t');

  const missing = await toolGet(store, { id: 'MMR-999' });
  expect(missing.isError).toBe(true);
  const parsed = parseJson<{ error: { code: string; message: string } }>(textOf(missing));
  expect(parsed.error.code).toBe('not_found');
  expect(typeof parsed.error.message).toBe('string');
});

test('status tool returns the rollup', async () => {
  const result = await toolStatus(store, { id: phaseRef });
  const parsed = parseJson<{
    status: string;
    distribution: Record<string, number>;
  }>(textOf(result));
  expect(parsed.status).toBe('ready');
  expect(parsed.distribution).toEqual({ ready: 1 });
});

// ---------------------------------------------------------------------------
// Lifecycle mutation tools
// ---------------------------------------------------------------------------

test('start echoes the node as bare json with status in_progress', async () => {
  const res = await toolStart(store, { id: taskRef });
  expect(res.isError).toBeUndefined();
  expect(JSON.parse(textOf(res)).status).toBe('in_progress');
});

test('done echoes the node as bare json with status done', async () => {
  await toolStart(store, { id: taskRef });
  const res = await toolDone(store, { id: taskRef });
  expect(res.isError).toBeUndefined();
  expect(JSON.parse(textOf(res)).status).toBe('done');
});

test('abandon echoes the node with status abandoned', async () => {
  const res = await toolAbandon(store, { id: taskRef, reason: 'superseded' });
  expect(res.isError).toBeUndefined();
  expect(JSON.parse(textOf(res)).status).toBe('abandoned');
});

test('toolReopen sends a done task back to in_progress (MMR-104)', async () => {
  await toolStart(store, { id: taskRef });
  await toolDone(store, { id: taskRef });
  const res = await toolReopen(store, { id: taskRef, reason: 'unverified' });
  expect(res.isError).toBeUndefined();
  const node = JSON.parse(textOf(res));
  expect(node.status).toBe('in_progress');
});

test('a not_found mutation returns the structured envelope as isError', async () => {
  const res = await toolDone(store, { id: 'MMR-9999' });
  expect(res.isError).toBe(true);
  const parsed = parseJson<{ error: { code: string } }>(textOf(res));
  expect(parsed.error.code).toBe('not_found');
});

// ---------------------------------------------------------------------------
// Hold mutation tools
// ---------------------------------------------------------------------------

test('park sets the hold overlay → status parked', async () => {
  const res = await toolPark(store, { id: taskRef, reason: 'waiting on review' });
  expect(res.isError).toBeUndefined();
  expect(JSON.parse(textOf(res)).status).toBe('parked');
});

test('unpark clears the hold', async () => {
  await toolPark(store, { id: taskRef });
  const res = await toolUnpark(store, { id: taskRef });
  expect(res.isError).toBeUndefined();
  expect(JSON.parse(textOf(res)).status).toBe('ready');
});

test('block then unblock', async () => {
  const blocked = await toolBlock(store, { id: taskRef, reason: 'ci red' });
  expect(blocked.isError).toBeUndefined();
  expect(JSON.parse(textOf(blocked)).status).toBe('blocked');

  const unblocked = await toolUnblock(store, { id: taskRef });
  expect(unblocked.isError).toBeUndefined();
  expect(JSON.parse(textOf(unblocked)).status).toBe('ready');
});

// ---------------------------------------------------------------------------
// Dependency mutation tools
// ---------------------------------------------------------------------------

test('depend adds edges; undepend removes them', async () => {
  const t2 = await createTask(store, { parentId: phaseId, title: 't2' });
  const ref2 = `MMR-${String(t2.seq)}`;

  const depRes = await toolDepend(store, { id: taskRef, on: [ref2] });
  expect(depRes.isError).toBeUndefined();

  const undepRes = await toolUndepend(store, { id: taskRef, on: [ref2] });
  expect(undepRes.isError).toBeUndefined();
});

test('depend on a missing id returns structured not_found', async () => {
  const res = await toolDepend(store, { id: taskRef, on: ['MMR-9999'] });
  expect(res.isError).toBe(true);
  expect(JSON.parse(textOf(res)).error.code).toBe('not_found');
});

// ---------------------------------------------------------------------------
// Structure mutation tools
// ---------------------------------------------------------------------------

test('move re-parents a task under a new phase', async () => {
  const phase2 = await createPhase(store, { parentId: initiativeId, title: 'ph2' });
  const ref2 = `MMR-${String(phase2.seq)}`;
  const res = await toolMove(store, { id: taskRef, to: ref2 });
  expect(res.isError).toBeUndefined();
  const parsed = parseJson<{ parent: string }>(textOf(res));
  expect(parsed.parent).toBe(ref2);
});

test('reorder top echoes the node', async () => {
  const res = await toolReorder(store, { id: taskRef, position: 'top' });
  expect(res.isError).toBeUndefined();
  expect(JSON.parse(textOf(res)).id).toBe(taskRef);
});

test('reorder before/after without ref returns structured validation error', async () => {
  const res = await toolReorder(store, { id: taskRef, position: 'before' });
  expect(res.isError).toBe(true);
  expect(JSON.parse(textOf(res)).error.code).toBe('validation');
});

// ---------------------------------------------------------------------------
// Data mutation tools
// ---------------------------------------------------------------------------

test('update patches scalar fields and echoes them', async () => {
  const res = await toolUpdate(store, {
    id: taskRef,
    priority: 'p1',
    size: 'large',
    title: 'renamed',
  });
  expect(res.isError).toBeUndefined();
  const v = parseJson<{ title: string; priority: string }>(textOf(res));
  expect(v.title).toBe('renamed');
  expect(v.priority).toBe('p1');
});

test('update echoes the description and summary it set (MMR-162)', async () => {
  // description is facet-gated now; the tool echo must still return it (and the
  // bulk-cheap summary), else an MCP client cannot confirm the write.
  const res = await toolUpdate(store, {
    description: 'the full prose body',
    id: taskRef,
    summary: 'the lede',
  });
  expect(res.isError).toBeUndefined();
  const v = parseJson<{ description?: string; summary?: string }>(textOf(res));
  expect(v.description).toBe('the full prose body');
  expect(v.summary).toBe('the lede');
});

test('annotate echoes the node', async () => {
  const res = await toolAnnotate(store, { content: 'looked into this', id: taskRef });
  expect(res.isError).toBeUndefined();
  expect(JSON.parse(textOf(res)).id).toBe(taskRef);
});

// ---------------------------------------------------------------------------
// Create tool
// ---------------------------------------------------------------------------

test('create project echoes {project:{key,name}}', async () => {
  const res = await toolCreate(store, { key: 'NEW', name: 'New Proj', type: 'project' });
  expect(res.isError).toBeUndefined();
  const v = parseJson<{ project: { key: string; name: string } }>(textOf(res));
  expect(v.project.key).toBe('NEW');
  expect(v.project.name).toBe('New Proj');
});

test('create task echoes a task node', async () => {
  const res = await toolCreate(store, { parent: phaseRef, title: 'x', type: 'task' });
  expect(res.isError).toBeUndefined();
  expect(JSON.parse(textOf(res)).type).toBe('task');
});

test('create phase echoes a phase node', async () => {
  const initNode = await findNodeByRef(db, 'MMR-1');
  const initRef = initNode !== undefined ? `MMR-${String(initNode.seq)}` : 'MMR-1';
  const res = await toolCreate(store, { parent: initRef, title: 'p2', type: 'phase' });
  expect(res.isError).toBeUndefined();
  expect(JSON.parse(textOf(res)).type).toBe('phase');
});

test('create initiative under a bare project KEY', async () => {
  const res = await toolCreate(store, { parent: 'MMR', title: 'Big bet', type: 'initiative' });
  expect(res.isError).toBeUndefined();
  expect(JSON.parse(textOf(res)).type).toBe('initiative');
});

test('create initiative with a node ref as parent returns structured validation error', async () => {
  const res = await toolCreate(store, { parent: taskRef, title: 'x', type: 'initiative' });
  expect(res.isError).toBe(true);
  expect(JSON.parse(textOf(res)).error.code).toBe('validation');
});

test('create project without key returns validation error', async () => {
  const res = await toolCreate(store, { name: 'Missing Key', type: 'project' });
  expect(res.isError).toBe(true);
  expect(JSON.parse(textOf(res)).error.code).toBe('validation');
});

// ---------------------------------------------------------------------------
// Attach tool
// ---------------------------------------------------------------------------

test('attach to a node infers the project and echoes an artifact id', async () => {
  const res = await toolAttach(store, { content: '# plan\n', node: taskRef, title: 'plan' });
  expect(res.isError).toBeUndefined();
  const v = parseJson<{ artifact: { id: string } }>(textOf(res));
  expect(v.artifact.id).toMatch(/^[A-Z]{2,4}-a\d+$/);
});

test('attach cross-project link returns structured validation error', async () => {
  const other = await createProject(store, { key: 'OTH', name: 'o' });
  const oi = await createInitiative(store, { projectId: other.id, title: 'i' });
  const op = await createPhase(store, { parentId: oi.id, title: 'p' });
  const ot = await createTask(store, { parentId: op.id, title: 't' });
  const otRef = `OTH-${String(ot.seq)}`;

  const res = await toolAttach(store, {
    content: 'x',
    links: [otRef],
    node: taskRef,
    title: 'x',
  });
  expect(res.isError).toBe(true);
  expect(JSON.parse(textOf(res)).error.code).toBe('validation');
});

test('attach with no node refs and no project returns structured validation error', async () => {
  const res = await toolAttach(store, { content: '# plan\n', title: 'plan' });
  expect(res.isError).toBe(true);
  expect(JSON.parse(textOf(res)).error.code).toBe('validation');
});

test('attach to a missing node is not_found', async () => {
  const res = await toolAttach(store, { content: 'x', node: 'MMR-9999', title: 'x' });
  expect(res.isError).toBe(true);
  expect(JSON.parse(textOf(res)).error.code).toBe('not_found');
});

test('attach with project disagreement returns structured validation error', async () => {
  // Create a second project
  const other = await createProject(store, { key: 'OTH', name: 'o' });
  const oi = await createInitiative(store, { projectId: other.id, title: 'i' });
  const op = await createPhase(store, { parentId: oi.id, title: 'p' });
  await createTask(store, { parentId: op.id, title: 't' });

  // node is in MMR but --project says OTH
  const res = await toolAttach(store, {
    content: 'x',
    node: taskRef,
    project: 'OTH',
    title: 'x',
  });
  expect(res.isError).toBe(true);
  expect(JSON.parse(textOf(res)).error.code).toBe('validation');
});

// ---------------------------------------------------------------------------
// Tag tools (MMR-31)
// ---------------------------------------------------------------------------

test('tag and untag round-trip over MCP, reaching project and node', async () => {
  const res = await toolTag(store, { ids: [taskRef, 'MMR'], note: 'why', tags: ['spec'] });
  expect(res.isError).toBeUndefined();
  expect(JSON.parse(textOf(res))).toEqual({ tagged: { ids: [taskRef, 'MMR'], tags: ['spec'] } });

  const view = await toolGet(store, { id: taskRef });
  const parsed = parseJson<{ tags: { tag: string; note: string | null }[] }>(textOf(view));
  expect(parsed.tags.map((t) => ({ note: t.note, tag: t.tag }))).toEqual([
    { note: 'why', tag: 'spec' },
  ]);

  const off = await toolUntag(store, { ids: [taskRef], tags: ['spec'] });
  expect(off.isError).toBeUndefined();
  const reread = parseJson<{ tags: unknown[] }>(textOf(await toolGet(store, { id: taskRef })));
  expect(reread.tags).toEqual([]);
});

test('tag on an unknown id returns a structured not_found', async () => {
  const res = await toolTag(store, { ids: ['MMR-999'], tags: ['x'] });
  expect(res.isError).toBe(true);
  expect(JSON.parse(textOf(res)).error.code).toBe('not_found');
});

test('create task with tags applies them', async () => {
  const res = await toolCreate(store, {
    parent: phaseRef,
    tags: ['v2'],
    title: 'tt',
    type: 'task',
  });
  expect(res.isError).toBeUndefined();
  const node = parseJson<{ id: string }>(textOf(res));
  const view = parseJson<{
    tags: { tag: string }[];
  }>(textOf(await toolGet(store, { id: node.id })));
  expect(view.tags.map((t) => t.tag)).toEqual(['v2']);
});

// ---------------------------------------------------------------------------
// Project update (MMR-88)
// ---------------------------------------------------------------------------

test('toolUpdate on a bare project KEY renames and patches description', async () => {
  const res = await toolUpdate(store, { description: 'details', id: 'MMR', name: 'Renamed' });
  expect(res.isError).toBeUndefined();
  const v = parseJson<{ type: string; title: string; description: string }>(textOf(res));
  expect(v.type).toBe('project');
  expect(v.title).toBe('Renamed');
  expect(v.description).toBe('details');
});

test('toolUpdate project rejects node-only flags', async () => {
  const res = await toolUpdate(store, { id: 'MMR', priority: 'p1' });
  expect(res.isError).toBe(true);
  expect(JSON.parse(textOf(res)).error.code).toBe('validation');
});

test('toolUpdate project with missing key returns not_found', async () => {
  const res = await toolUpdate(store, { id: 'ZZZ', name: 'x' });
  expect(res.isError).toBe(true);
  expect(JSON.parse(textOf(res)).error.code).toBe('not_found');
});

test('toolCreate project with description stores it', async () => {
  const res = await toolCreate(store, {
    description: 'a project',
    key: 'DSC',
    name: 'Described',
    type: 'project',
  });
  expect(res.isError).toBeUndefined();
  const get = await toolGet(store, { id: 'DSC' });
  const v = parseJson<{ description: string }>(textOf(get));
  expect(v.description).toBe('a project');
});

// ---------------------------------------------------------------------------
// Query surface v2 (MMR-33)
// ---------------------------------------------------------------------------

test('list folds value warnings into the payload (no stderr over MCP)', async () => {
  const res = await toolList(store, { eq: ['priority:p9'] });
  expect(res.isError).toBeUndefined();
  const parsed = parseJson<{
    total: number;
    warnings: { code: string; expected: string[] }[];
  }>(textOf(res));
  expect(parsed.total).toBe(0);
  expect(parsed.warnings[0]?.code).toBe('no_match_value');
  expect(parsed.warnings[0]?.expected).toEqual(['p0', 'p1', 'p2', 'p3']);
});

test('a structural fault over MCP is a validation error', async () => {
  const res = await toolList(store, { eq: ['bogus:x'] });
  expect(res.isError).toBe(true);
  expect(JSON.parse(textOf(res)).error.code).toBe('validation');
});

test('list selects by status universe and operators', async () => {
  const start = await toolStart(store, { id: taskRef });
  expect(start.isError).toBeUndefined();
  const inProgress = parseJson<{
    tasks: { id: string }[];
  }>(textOf(await toolList(store, { status: 'in_progress' })));
  expect(inProgress.tasks.map((t) => t.id)).toEqual([taskRef]);

  const byStatus = parseJson<{
    tasks: { id: string }[];
  }>(textOf(await toolList(store, { eq: ['status:in_progress'] })));
  expect(byStatus.tasks.map((t) => t.id)).toEqual([taskRef]);
});

// --- project archive (ADR 0015, MMR-123) ---

test('MCP archive freezes + hides; the list door and unarchive round-trip', async () => {
  const arc = await toolArchive(store, { key: 'MMR', reason: 'superseded' });
  expect(arc.isError).toBeUndefined();
  expect(parseJson<{ archived_at: string }>(textOf(arc)).archived_at).not.toBeUndefined();

  // frozen: a mutation under it is a conflict
  const frozen = await toolStart(store, { id: taskRef });
  expect(frozen.isError).toBe(true);
  expect(parseJson<{ error: { code: string } }>(textOf(frozen)).error.code).toBe('conflict');

  // hidden: a normal list excludes it; the door lists the archived project
  const live = await toolList(store, { scope: 'MMR', status: 'all' });
  expect(parseJson<{ total: number }>(textOf(live)).total).toBe(0);
  const door = await toolList(store, { status: 'archived' });
  const shelf = parseJson<{ projects: { id: string }[] }>(textOf(door));
  expect(shelf.projects.map((p) => p.id)).toEqual(['MMR']);

  // unarchive restores mutation
  const un = await toolUnarchive(store, { key: 'MMR' });
  expect(un.isError).toBeUndefined();
  expect(parseJson<{ archived_at?: string }>(textOf(un)).archived_at).toBeUndefined();
  expect((await toolStart(store, { id: taskRef })).isError).toBeUndefined();
});

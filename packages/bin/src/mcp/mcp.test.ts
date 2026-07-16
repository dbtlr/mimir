import { afterEach, beforeEach, expect, test } from 'bun:test';

import { parseJson } from '@mimir/helpers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  createInitiative,
  createPhase,
  createProject,
  createTask,
  deriveSet,
  findNodeInSet,
} from '../core';
import type { Store } from '../core';
import { createTestStore, inertStore, nodeIdOf, projectIdOf } from '../testing/store';
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
  toolOverview,
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

const NORN = Bun.which('norn') !== null;

let store: Store;
let projectId: string;
let closeStore: () => Promise<void>;
let phaseId: string;
let phaseRef: string;
let taskRef: string;
let initiativeId: string;

beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
  await createProject(store, { key: 'MMR', name: 'm' });
  projectId = await projectIdOf(store, 'MMR');
  const init = await createInitiative(store, { projectId, title: 'i' });
  initiativeId = await nodeIdOf(store, `MMR-${String(init.seq)}`);
  const phase = await createPhase(store, { parentId: initiativeId, title: 'ph' });
  phaseRef = `MMR-${String(phase.seq)}`;
  phaseId = await nodeIdOf(store, phaseRef);
  const task = await createTask(store, { parentId: phaseId, title: 't' });
  taskRef = `MMR-${String(task.seq)}`;
});
afterEach(async () => {
  await closeStore();
});

const textOf = (result: { content: { text: string }[] }) =>
  result.content.map((c) => c.text).join('');

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

test.skipIf(!NORN)('buildMcpServer registers tools without throwing', () => {
  expect(() => buildMcpServer(store, '0.0.0')).not.toThrow();
});

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

test.skipIf(!NORN)('next tool returns the structured envelope', async () => {
  await createTask(store, { parentId: phaseId, title: 'first' });
  const result = await toolNext(store, { scope: 'MMR' });
  expect(result.isError).toBeUndefined();
  const parsed = parseJson<{ total: number; tasks: { title: string }[] }>(textOf(result));
  // +1 because beforeEach creates a task too
  expect(parsed.total).toBeGreaterThanOrEqual(1);
  expect(parsed.tasks.some((t) => t.title === 'first')).toBe(true);
});

test.skipIf(!NORN)(
  'get tool returns a bare node; a missing id returns the structured error envelope',
  async () => {
    const ok = await toolGet(store, { id: taskRef });
    expect(ok.isError).toBeUndefined();
    expect(parseJson<{ title: string }>(textOf(ok)).title).toBe('t');

    const missing = await toolGet(store, { id: 'MMR-999' });
    expect(missing.isError).toBe(true);
    const parsed = parseJson<{ error: { code: string; message: string } }>(textOf(missing));
    expect(parsed.error.code).toBe('not_found');
    expect(typeof parsed.error.message).toBe('string');
  },
);

test.skipIf(!NORN)('status tool returns the rollup', async () => {
  const result = await toolStatus(store, { id: phaseRef });
  const parsed = parseJson<{
    status: string;
    distribution: Record<string, number>;
  }>(textOf(result));
  expect(parsed.status).toBe('ready');
  expect(parsed.distribution).toEqual({ ready: 1 });
});

test.skipIf(!NORN)('overview tool returns the composite envelope (MMR-278)', async () => {
  const result = await toolOverview(store, { scope: 'MMR' });
  expect(result.isError).toBeUndefined();
  const parsed = parseJson<{
    project: { id: string; status: string; distribution: Record<string, number> };
    in_flight: { count: number; tasks: { id: string }[] };
    next: { count: number; tasks: { id: string; status: string }[] };
    awaiting: { count: number; tasks: unknown[] };
    hygiene: { untriaged: number; blocked: number; stale: number; dropped: number };
  }>(textOf(result));
  expect(parsed.project.id).toBe('MMR');
  // beforeEach leaves one ready task under the phase.
  expect(parsed.next.count).toBe(1);
  expect(parsed.next.tasks[0]?.status).toBe('ready');
  expect(parsed.hygiene).toEqual({ blocked: 0, dropped: 0, stale: 0, untriaged: 0 });
});

test.skipIf(!NORN)('overview tool rejects the cross-project all escape (MMR-278)', async () => {
  const result = await toolOverview(store, { scope: 'all' });
  expect(result.isError).toBe(true);
  const parsed = parseJson<{ error: { code: string; message: string } }>(textOf(result));
  expect(parsed.error.code).toBe('validation');
});

test.skipIf(!NORN)('overview tool defaults to the bound scope (MMR-278)', async () => {
  const result = await toolOverview(store, {}, 'MMR');
  expect(result.isError).toBeUndefined();
  expect(parseJson<{ project: { id: string } }>(textOf(result)).project.id).toBe('MMR');
});

// ---------------------------------------------------------------------------
// Lifecycle mutation tools
// ---------------------------------------------------------------------------

test.skipIf(!NORN)('start echoes the node as bare json with status in_progress', async () => {
  const res = await toolStart(store, { id: taskRef });
  expect(res.isError).toBeUndefined();
  expect(JSON.parse(textOf(res)).status).toBe('in_progress');
});

test.skipIf(!NORN)('done echoes the node as bare json with status done', async () => {
  await toolStart(store, { id: taskRef });
  const res = await toolDone(store, { id: taskRef });
  expect(res.isError).toBeUndefined();
  expect(JSON.parse(textOf(res)).status).toBe('done');
});

test.skipIf(!NORN)('abandon echoes the node with status abandoned', async () => {
  const res = await toolAbandon(store, { id: taskRef, reason: 'superseded' });
  expect(res.isError).toBeUndefined();
  expect(JSON.parse(textOf(res)).status).toBe('abandoned');
});

test.skipIf(!NORN)('toolReopen sends a done task back to in_progress (MMR-104)', async () => {
  await toolStart(store, { id: taskRef });
  await toolDone(store, { id: taskRef });
  const res = await toolReopen(store, { id: taskRef, reason: 'unverified' });
  expect(res.isError).toBeUndefined();
  const node = JSON.parse(textOf(res));
  expect(node.status).toBe('in_progress');
});

test.skipIf(!NORN)('a not_found mutation returns the structured envelope as isError', async () => {
  const res = await toolDone(store, { id: 'MMR-9999' });
  expect(res.isError).toBe(true);
  const parsed = parseJson<{ error: { code: string } }>(textOf(res));
  expect(parsed.error.code).toBe('not_found');
});

// ---------------------------------------------------------------------------
// Hold mutation tools
// ---------------------------------------------------------------------------

test.skipIf(!NORN)('park sets the hold overlay → status parked', async () => {
  const res = await toolPark(store, { id: taskRef, reason: 'waiting on review' });
  expect(res.isError).toBeUndefined();
  expect(JSON.parse(textOf(res)).status).toBe('parked');
});

test.skipIf(!NORN)('unpark clears the hold', async () => {
  await toolPark(store, { id: taskRef });
  const res = await toolUnpark(store, { id: taskRef });
  expect(res.isError).toBeUndefined();
  expect(JSON.parse(textOf(res)).status).toBe('ready');
});

test.skipIf(!NORN)('block then unblock', async () => {
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

test.skipIf(!NORN)('depend adds edges; undepend removes them', async () => {
  const t2 = await createTask(store, { parentId: phaseId, title: 't2' });
  const ref2 = `MMR-${String(t2.seq)}`;

  const depRes = await toolDepend(store, { id: taskRef, on: [ref2] });
  expect(depRes.isError).toBeUndefined();

  const undepRes = await toolUndepend(store, { id: taskRef, on: [ref2] });
  expect(undepRes.isError).toBeUndefined();
});

test.skipIf(!NORN)('depend on a missing id returns structured not_found', async () => {
  const res = await toolDepend(store, { id: taskRef, on: ['MMR-9999'] });
  expect(res.isError).toBe(true);
  expect(JSON.parse(textOf(res)).error.code).toBe('not_found');
});

// ---------------------------------------------------------------------------
// Structure mutation tools
// ---------------------------------------------------------------------------

test.skipIf(!NORN)('move re-parents a task under a new phase', async () => {
  const phase2 = await createPhase(store, { parentId: initiativeId, title: 'ph2' });
  const ref2 = `MMR-${String(phase2.seq)}`;
  const res = await toolMove(store, { id: taskRef, to: ref2 });
  expect(res.isError).toBeUndefined();
  const parsed = parseJson<{ parent: string }>(textOf(res));
  expect(parsed.parent).toBe(ref2);
});

test.skipIf(!NORN)('reorder top echoes the node', async () => {
  const res = await toolReorder(store, { id: taskRef, position: 'top' });
  expect(res.isError).toBeUndefined();
  expect(JSON.parse(textOf(res)).id).toBe(taskRef);
});

test.skipIf(!NORN)(
  'reorder before/after without ref returns structured validation error',
  async () => {
    const res = await toolReorder(store, { id: taskRef, position: 'before' });
    expect(res.isError).toBe(true);
    expect(JSON.parse(textOf(res)).error.code).toBe('validation');
  },
);

// ---------------------------------------------------------------------------
// Data mutation tools
// ---------------------------------------------------------------------------

test.skipIf(!NORN)('update patches scalar fields and echoes them', async () => {
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

test.skipIf(!NORN)('update echoes the description and summary it set (MMR-162)', async () => {
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

test.skipIf(!NORN)('annotate echoes the node', async () => {
  const res = await toolAnnotate(store, { content: 'looked into this', id: taskRef });
  expect(res.isError).toBeUndefined();
  expect(JSON.parse(textOf(res)).id).toBe(taskRef);
});

test.skipIf(!NORN)(
  'annotate on a container echoes the true rollup, matching get (MMR-242)',
  async () => {
    await createTask(store, { parentId: phaseId, title: 't2' });

    const getView = parseJson<{ distribution: Record<string, number> }>(
      textOf(await toolGet(store, { id: phaseRef })),
    );

    const res = await toolAnnotate(store, { content: 'checked in', id: phaseRef });
    expect(res.isError).toBeUndefined();
    const annotateView = parseJson<{ distribution: Record<string, number> }>(textOf(res));

    // The mutation echo must derive its rollup from the same source as `get` —
    // not read as an unloaded, childless node.
    expect(annotateView.distribution).toEqual(getView.distribution);
    expect(annotateView.distribution).toEqual({ ready: 2 });
  },
);

test.skipIf(!NORN)(
  'update on a project echoes the true rollup, matching get (MMR-242)',
  async () => {
    // The project already carries one root initiative (from beforeEach) — add a
    // second so the count is unambiguous.
    await createInitiative(store, { projectId, title: 'i2' });

    const getView = parseJson<{ children: unknown[]; distribution: Record<string, number> }>(
      textOf(await toolGet(store, { id: 'MMR' })),
    );

    const res = await toolUpdate(store, { description: 'renamed body', id: 'MMR' });
    expect(res.isError).toBeUndefined();
    const updateView = parseJson<{ children: unknown[]; distribution: Record<string, number> }>(
      textOf(res),
    );

    // The project write-echo must derive its rollup from the same sources as
    // `get KEY` — not read as an unloaded, childless project.
    expect(updateView.children).toEqual(getView.children);
    expect(updateView.distribution).toEqual(getView.distribution);
    expect(updateView.distribution).toEqual({ new: 1, ready: 1 });
  },
);

// ---------------------------------------------------------------------------
// Create tool
// ---------------------------------------------------------------------------

test.skipIf(!NORN)('create project echoes {project:{key,name}}', async () => {
  const res = await toolCreate(store, { key: 'NEW', name: 'New Proj', type: 'project' });
  expect(res.isError).toBeUndefined();
  const v = parseJson<{ project: { key: string; name: string } }>(textOf(res));
  expect(v.project.key).toBe('NEW');
  expect(v.project.name).toBe('New Proj');
});

test.skipIf(!NORN)('create task echoes a task node', async () => {
  const res = await toolCreate(store, { parent: phaseRef, title: 'x', type: 'task' });
  expect(res.isError).toBeUndefined();
  expect(JSON.parse(textOf(res)).type).toBe('task');
});

test.skipIf(!NORN)('create phase echoes a phase node', async () => {
  const initNode = findNodeInSet(deriveSet(await store.loadWorkingSet()), 'MMR-1');
  const initRef = initNode !== undefined ? `MMR-${String(initNode.seq)}` : 'MMR-1';
  const res = await toolCreate(store, { parent: initRef, title: 'p2', type: 'phase' });
  expect(res.isError).toBeUndefined();
  expect(JSON.parse(textOf(res)).type).toBe('phase');
});

test.skipIf(!NORN)('create initiative under a bare project KEY', async () => {
  const res = await toolCreate(store, { parent: 'MMR', title: 'Big bet', type: 'initiative' });
  expect(res.isError).toBeUndefined();
  expect(JSON.parse(textOf(res)).type).toBe('initiative');
});

test.skipIf(!NORN)(
  'create initiative with a node ref as parent returns structured validation error',
  async () => {
    const res = await toolCreate(store, { parent: taskRef, title: 'x', type: 'initiative' });
    expect(res.isError).toBe(true);
    expect(JSON.parse(textOf(res)).error.code).toBe('validation');
  },
);

test.skipIf(!NORN)('create project without key returns validation error', async () => {
  const res = await toolCreate(store, { name: 'Missing Key', type: 'project' });
  expect(res.isError).toBe(true);
  expect(JSON.parse(textOf(res)).error.code).toBe('validation');
});

// ---------------------------------------------------------------------------
// Attach tool
// ---------------------------------------------------------------------------

test.skipIf(!NORN)('attach to a node infers the project and echoes an artifact id', async () => {
  const res = await toolAttach(store, { content: '# plan\n', node: taskRef, title: 'plan' });
  expect(res.isError).toBeUndefined();
  const v = parseJson<{ artifact: { id: string } }>(textOf(res));
  expect(v.artifact.id).toMatch(/^[A-Z]{2,4}-a\d+$/);
});

test.skipIf(!NORN)('attach cross-project link returns structured validation error', async () => {
  await createProject(store, { key: 'OTH', name: 'o' });
  const otherProjectId = await projectIdOf(store, 'OTH');
  const oi = await createInitiative(store, { projectId: otherProjectId, title: 'i' });
  const oiId = await nodeIdOf(store, `OTH-${String(oi.seq)}`);
  const op = await createPhase(store, { parentId: oiId, title: 'p' });
  const opId = await nodeIdOf(store, `OTH-${String(op.seq)}`);
  const ot = await createTask(store, { parentId: opId, title: 't' });
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

test.skipIf(!NORN)(
  'attach with no node refs and no project returns structured validation error',
  async () => {
    const res = await toolAttach(store, { content: '# plan\n', title: 'plan' });
    expect(res.isError).toBe(true);
    expect(JSON.parse(textOf(res)).error.code).toBe('validation');
  },
);

test.skipIf(!NORN)('attach to a missing node is not_found', async () => {
  const res = await toolAttach(store, { content: 'x', node: 'MMR-9999', title: 'x' });
  expect(res.isError).toBe(true);
  expect(JSON.parse(textOf(res)).error.code).toBe('not_found');
});

test.skipIf(!NORN)(
  'attach with project disagreement returns structured validation error',
  async () => {
    // Create a second project
    await createProject(store, { key: 'OTH', name: 'o' });
    const otherProjectId = await projectIdOf(store, 'OTH');
    const oi = await createInitiative(store, { projectId: otherProjectId, title: 'i' });
    const oiId = await nodeIdOf(store, `OTH-${String(oi.seq)}`);
    const op = await createPhase(store, { parentId: oiId, title: 'p' });
    const opId = await nodeIdOf(store, `OTH-${String(op.seq)}`);
    await createTask(store, { parentId: opId, title: 't' });

    // node is in MMR but --project says OTH
    const res = await toolAttach(store, {
      content: 'x',
      node: taskRef,
      project: 'OTH',
      title: 'x',
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse(textOf(res)).error.code).toBe('validation');
  },
);

// ---------------------------------------------------------------------------
// Tag tools (MMR-31)
// ---------------------------------------------------------------------------

test.skipIf(!NORN)('tag and untag round-trip over MCP, reaching project and node', async () => {
  const res = await toolTag(store, { ids: [taskRef, 'MMR'], tags: ['spec'] });
  expect(res.isError).toBeUndefined();
  expect(JSON.parse(textOf(res))).toEqual({ tagged: { ids: [taskRef, 'MMR'], tags: ['spec'] } });

  const view = await toolGet(store, { id: taskRef });
  const parsed = parseJson<{ tags: { created_at: string; tag: string }[] }>(textOf(view));
  // A tag application carries no note on any entity (ADR 0005 Refinement,
  // MMR-270) — exact-shape assertion so a resurrected wire field fails loud.
  expect(parsed.tags).toEqual([{ created_at: expect.any(String) as string, tag: 'spec' }]);

  const off = await toolUntag(store, { ids: [taskRef], tags: ['spec'] });
  expect(off.isError).toBeUndefined();
  const reread = parseJson<{ tags: unknown[] }>(textOf(await toolGet(store, { id: taskRef })));
  expect(reread.tags).toEqual([]);
});

test.skipIf(!NORN)('tag on an unknown id returns a structured not_found', async () => {
  const res = await toolTag(store, { ids: ['MMR-999'], tags: ['x'] });
  expect(res.isError).toBe(true);
  expect(JSON.parse(textOf(res)).error.code).toBe('not_found');
});

test.skipIf(!NORN)('create task with tags applies them', async () => {
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

test.skipIf(!NORN)('toolUpdate on a bare project KEY renames and patches description', async () => {
  const res = await toolUpdate(store, { description: 'details', id: 'MMR', name: 'Renamed' });
  expect(res.isError).toBeUndefined();
  const v = parseJson<{ type: string; title: string; description: string }>(textOf(res));
  expect(v.type).toBe('project');
  expect(v.title).toBe('Renamed');
  expect(v.description).toBe('details');
});

test.skipIf(!NORN)('toolUpdate project rejects node-only flags', async () => {
  const res = await toolUpdate(store, { id: 'MMR', priority: 'p1' });
  expect(res.isError).toBe(true);
  expect(JSON.parse(textOf(res)).error.code).toBe('validation');
});

test.skipIf(!NORN)(
  'toolUpdate project and artifact reject upstream, never silently no-op (MMR-284)',
  async () => {
    const proj = await toolUpdate(store, { id: 'MMR', upstream: 'NRN-s3' });
    expect(proj.isError).toBe(true);
    expect(JSON.parse(textOf(proj)).error.code).toBe('validation');

    const attached = await toolAttach(store, { content: '# a\n', node: taskRef, title: 'a' });
    const aid = parseJson<{ artifact: { id: string } }>(textOf(attached)).artifact.id;
    const art = await toolUpdate(store, { id: aid, upstream: 'NRN-s3' });
    expect(art.isError).toBe(true);
    expect(JSON.parse(textOf(art)).error.code).toBe('validation');
  },
);

test.skipIf(!NORN)(
  'toolUpdate upstream "none" clears a set seed pointer (set-then-clear roundtrip, MMR-301)',
  async () => {
    const set = await toolUpdate(store, { id: taskRef, upstream: 'NRN-s3' });
    expect(set.isError).toBeUndefined();
    expect(parseJson<{ upstream: string }>(textOf(set)).upstream).toBe('NRN-s3');

    const cleared = await toolUpdate(store, { id: taskRef, upstream: 'none' });
    expect(cleared.isError).toBeUndefined();
    expect(parseJson<{ upstream: string | null }>(textOf(cleared)).upstream).toBeNull();
  },
);

test.skipIf(!NORN)(
  'toolUpdate upstream "none" on an already-empty upstream is idempotent (MMR-301)',
  async () => {
    const cleared = await toolUpdate(store, { id: taskRef, upstream: 'none' });
    expect(cleared.isError).toBeUndefined();
    expect(parseJson<{ upstream: string | null }>(textOf(cleared)).upstream).toBeNull();
  },
);

test.skipIf(!NORN)(
  'toolUpdate upstream "" (blank) is still rejected, not treated as clear (MMR-301)',
  async () => {
    const res = await toolUpdate(store, { id: taskRef, upstream: '' });
    expect(res.isError).toBe(true);
    expect(JSON.parse(textOf(res)).error.code).toBe('validation');
  },
);

test.skipIf(!NORN)(
  'toolUpdate upstream "none" leaves an unrelated field untouched (MMR-301)',
  async () => {
    const titled = await toolUpdate(store, { id: taskRef, title: 'kept across clear' });
    expect(titled.isError).toBeUndefined();
    const res = await toolUpdate(store, { id: taskRef, upstream: 'none' });
    expect(res.isError).toBeUndefined();
    const v = parseJson<{ upstream: string | null; title: string }>(textOf(res));
    expect(v.upstream).toBeNull();
    expect(v.title).toBe('kept across clear');
  },
);

test.skipIf(!NORN)('toolUpdate project with missing key returns not_found', async () => {
  const res = await toolUpdate(store, { id: 'ZZZ', name: 'x' });
  expect(res.isError).toBe(true);
  expect(JSON.parse(textOf(res)).error.code).toBe('not_found');
});

test.skipIf(!NORN)('toolCreate project with description stores it', async () => {
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

test.skipIf(!NORN)('list folds value warnings into the payload (no stderr over MCP)', async () => {
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

test.skipIf(!NORN)('a structural fault over MCP is a validation error', async () => {
  const res = await toolList(store, { eq: ['bogus:x'] });
  expect(res.isError).toBe(true);
  expect(JSON.parse(textOf(res)).error.code).toBe('validation');
});

test.skipIf(!NORN)('list selects by status universe and operators', async () => {
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

test.skipIf(!NORN)(
  'MCP archive freezes + hides; the list door and unarchive round-trip',
  async () => {
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
  },
);

// ---------------------------------------------------------------------------
// Input-schema voice guard (MMR-292) — driven through the real transport, so
// the SDK's pre-handler zod validation runs. The handler never executes on a
// schema miss, so an inert store suffices and these run without norn (the
// in-memory transport doubles as the MCP smoke).
// ---------------------------------------------------------------------------

/** Connect an in-memory client to a freshly-built server over an inert store. */
async function connectClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = buildMcpServer(inertStore(), '0.0.0');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, close: () => client.close() };
}

type ToolCall = { content?: { text?: string }[]; isError?: boolean };
const callText = (r: ToolCall): string => (r.content ?? []).map((c) => c.text ?? '').join('');

/** The library wording the SDK ships verbatim today — none may reach the client. */
const LIBRARY_LEAKS = [
  'MCP error',
  '-32602',
  'Input validation error',
  'Invalid arguments for tool',
  'invalid_type',
  'expected string, received',
];

test('a schema miss over the transport ships house voice, not zod wording', async () => {
  const { client, close } = await connectClient();
  try {
    // id must be a string; passing a number trips the SDK's pre-handler zod
    // validation. Before MMR-292 the client saw:
    //   "MCP error -32602: Input validation error: Invalid arguments for tool
    //    get: [ { "expected": "string", "code": "invalid_type", ... } ]"
    const res = (await client.callTool({ arguments: { id: 123 }, name: 'get' })) as ToolCall;
    expect(res.isError).toBe(true);
    const text = callText(res);
    for (const leak of LIBRARY_LEAKS) {
      expect(text).not.toContain(leak);
    }
    const parsed = parseJson<{ error: { code: string; hint: string; message: string } }>(text);
    expect(parsed.error.code).toBe('validation');
    expect(parsed.error.message).toBe('id must be a string');
    expect(parsed.error.hint).toBe("check the arguments against the 'get' tool schema");
  } finally {
    await close();
  }
});

test('a missing required arg names the arg as required', async () => {
  const { client, close } = await connectClient();
  try {
    const res = (await client.callTool({ arguments: {}, name: 'create' })) as ToolCall;
    expect(res.isError).toBe(true);
    const parsed = parseJson<{ error: { message: string } }>(callText(res));
    expect(parsed.error.message).toBe('type is required');
  } finally {
    await close();
  }
});

test('an out-of-vocabulary enum arg states the constraint, no zod dump', async () => {
  const { client, close } = await connectClient();
  try {
    const res = (await client.callTool({
      arguments: { id: 'MMR-1', priority: 'p9' },
      name: 'update',
    })) as ToolCall;
    expect(res.isError).toBe(true);
    const text = callText(res);
    expect(text).not.toContain('Invalid option');
    const parsed = parseJson<{ error: { message: string } }>(text);
    expect(parsed.error.message).toBe("priority must be one of 'p0', 'p1', 'p2', 'p3'");
  } finally {
    await close();
  }
});

test('the tools/list advertised inputSchema is undegraded (MMR-292)', async () => {
  const { client, close } = await connectClient();
  try {
    const { tools } = await client.listTools();
    const get = tools.find((t) => t.name === 'get');
    expect(get).toBeDefined();
    // The guard changes no schema: get still advertises a required string id and
    // its optional facets array — exactly as informative as before the guard.
    const schema = get?.inputSchema as {
      properties?: Record<string, { type?: string }>;
      required?: string[];
    };
    expect(schema.properties?.id?.type).toBe('string');
    expect(schema.required).toContain('id');
    expect(schema.properties?.facets?.type).toBe('array');
  } finally {
    await close();
  }
});

// A compliant client omits the `arguments` key entirely; the SDK's own client
// does this. The guard must coalesce and write back so the SDK's re-validation
// sees `{}`, not `undefined` — else all-optional tools re-leak the zod dump.
const ALL_OPTIONAL_TOOLS = ['next', 'list', 'seeds', 'overview', 'triage'];

test.each(ALL_OPTIONAL_TOOLS)(
  "a no-arguments call to '%s' never ships library text (MMR-292)",
  async (name) => {
    const { client, close } = await connectClient();
    try {
      // No `arguments` key at all — the regression scenario. Over an inert store
      // the handler's read fails loudly, but that fault is house-shaped; what
      // must never appear is the SDK's pre-handler zod dump.
      const res = (await client.callTool({ name })) as ToolCall;
      const text = callText(res);
      for (const leak of LIBRARY_LEAKS) {
        expect(text).not.toContain(leak);
      }
    } finally {
      await close();
    }
  },
);

test.skipIf(!NORN)('a no-arguments call to an all-optional tool succeeds (MMR-292)', async () => {
  const server = buildMcpServer(store, '0.0.0');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    // `next` with no arguments runs against the whole vault (no bound board) —
    // it must reach the handler and return a set, not error on a missing arg.
    const res = (await client.callTool({ name: 'next' })) as ToolCall;
    expect(res.isError).toBeUndefined();
    expect(parseJson<{ total: number }>(callText(res)).total).toBeGreaterThanOrEqual(0);
  } finally {
    await client.close();
  }
});

test.skipIf(!NORN)('a valid call still dispatches to the handler through the guard', async () => {
  const server = buildMcpServer(store, '0.0.0');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const res = (await client.callTool({ arguments: { id: 'MMR' }, name: 'get' })) as ToolCall;
    // Reaches toolGet, which returns the project record (not the guard's fault).
    expect(res.isError).toBeUndefined();
    expect(parseJson<{ id: string }>(callText(res)).id).toBe('MMR');
  } finally {
    await client.close();
  }
});

import { afterEach, beforeEach, expect, test } from 'bun:test';

import type { Server } from 'bun';

import { runCli } from './cli/run';
import { fakeIo } from './cli/testing';
import {
  attachArtifact,
  createInitiative,
  createPhase,
  createProject,
  createTask,
  fileSeed,
  getNode,
  updateNode,
  updateProject,
} from './core';
import type { Store } from './core';
import { createServer } from './http/server';
import { toolUpdate } from './mcp/tools';
import { createTestStore, nodeIdOf, projectIdOf } from './testing/store';

/**
 * The owned `## Next` direction narrative (MMR-321, ADR 0026 Decision 2), end to
 * end over a real vault: the set → replace → clear → no-op cycle in the
 * document bytes, the container-only applicability refusals in each transport's
 * own voice, and an accept-AND-apply pin per transport (the MMR-315 gap — a
 * surface that advertises the field but never writes it).
 */

const NORN = Bun.which('norn') !== null;

let store: Store;
let closeStore: (() => Promise<void>) | undefined;
let readDocument: (path: string) => string;
let server: Server<undefined>;
let base: string;
let projectId: string;
let initiativeRef: string;
let phaseRef: string;
let taskRef: string;
let seedRef: string;
let artifactRef: string;

beforeEach(async () => {
  if (!NORN) {
    return;
  }
  ({ close: closeStore, readDocument, store } = await createTestStore());
  await createProject(store, { key: 'MMR', name: 'Mimir' });
  projectId = await projectIdOf(store, 'MMR');
  const initiative = await createInitiative(store, { projectId, title: 'init' });
  initiativeRef = `MMR-${String(initiative.seq)}`;
  const phase = await createPhase(store, {
    parentId: await nodeIdOf(store, initiativeRef),
    title: 'phase',
  });
  phaseRef = `MMR-${String(phase.seq)}`;
  const task = await createTask(store, {
    parentId: await nodeIdOf(store, phaseRef),
    title: 'task',
  });
  taskRef = `MMR-${String(task.seq)}`;
  seedRef = (await fileSeed(store, { kind: 'idea', project: 'MMR', requester: null, title: 's' }))
    .id;
  artifactRef = (await attachArtifact(store, { content: 'frozen', projectId, title: 'note' }))
    .renderedId;
  server = createServer(store, { port: 0, version: '0.0.0-test' });
  base = `http://127.0.0.1:${String(server.port)}`;
});

afterEach(async () => {
  await server?.stop(true);
  await closeStore?.();
});

/** The `next` facet as a detail `get` projects it (absent when the section is). */
async function readNext(ref: string): Promise<string | undefined> {
  return (await getNode(store, ref)).next;
}

/** Run the CLI over the fixture store, asserting the exit code. */
async function cli(argv: string[], code = 0): Promise<string> {
  const io = fakeIo(false);
  expect(await runCli(argv, () => store, io)).toBe(code);
  return [...io.out, ...io.err].join('\n');
}

// ── The write cycle ────────────────────────────────────────────────────────

test.skipIf(!NORN)('set, replace, and clear re-author the whole section (MMR-321)', async () => {
  const id = await nodeIdOf(store, phaseRef);
  await updateNode(store, id, { next: 'Land the read path.' });
  expect(await readNext(phaseRef)).toBe('Land the read path.');
  // The section sits above `## History`, and its prose is the WHOLE body.
  const set = readDocument(`MMR/${phaseRef}.md`);
  expect(set).toContain('## Next\n\nLand the read path.\n## History');

  await updateNode(store, id, { next: 'Actually: revisit caching first.' });
  expect(await readNext(phaseRef)).toBe('Actually: revisit caching first.');
  // Replace, not append — the superseded sentence is gone, and there is exactly
  // one `## Next` heading.
  const replaced = readDocument(`MMR/${phaseRef}.md`);
  expect(replaced).not.toContain('Land the read path.');
  expect(replaced.split('## Next').length - 1).toBe(1);

  await updateNode(store, id, { next: '' });
  expect(await readNext(phaseRef)).toBeUndefined();
  // A clear removes the heading too — an empty section is never left behind.
  expect(readDocument(`MMR/${phaseRef}.md`)).not.toContain('## Next');
});

test.skipIf(!NORN)('a no-op re-author writes nothing at all (MMR-321)', async () => {
  const id = await nodeIdOf(store, phaseRef);
  await updateNode(store, id, { next: 'Hold the line.' });
  const before = readDocument(`MMR/${phaseRef}.md`);
  const stampBefore = (await getNode(store, phaseRef)).updatedAt;

  await updateNode(store, id, { next: 'Hold the line.' });
  // Byte-identical, stamp unmoved: `updated_at` drives the stale predicate, so a
  // re-author that changes nothing must not look like activity.
  expect(readDocument(`MMR/${phaseRef}.md`)).toBe(before);
  expect((await getNode(store, phaseRef)).updatedAt).toBe(stampBefore);
});

test.skipIf(!NORN)('multiline prose round-trips through the section codec (MMR-321)', async () => {
  const prose = 'First, the read path.\n\n- then caching\n- then the UI\n\n## not a heading';
  await updateNode(store, await nodeIdOf(store, initiativeRef), { next: prose });
  expect(await readNext(initiativeRef)).toBe(prose);
});

// ── Applicability ──────────────────────────────────────────────────────────

test.skipIf(!NORN)('a task refuses the direction narrative (MMR-321)', async () => {
  const out = await cli(['update', taskRef, '--direction', 'nope'], 1);
  expect(out).toContain('next applies only to phases and initiatives');
});

test.skipIf(!NORN)('a seed and an artifact refuse it in each voice (MMR-321)', async () => {
  const seedOut = await cli(['update', seedRef, '--direction', 'nope'], 2);
  expect(seedOut).toContain("--direction doesn't apply to a seed");
  const artifactOut = await cli(['update', artifactRef, '--direction', 'nope'], 1);
  expect(artifactOut).toContain("--direction doesn't apply to an artifact");

  const seedTool = await toolUpdate(store, { id: seedRef, next: 'nope' });
  expect(seedTool.isError).toBe(true);
  expect(seedTool.content[0]?.text).toContain('next do not apply to a seed');
  const artifactTool = await toolUpdate(store, { id: artifactRef, next: 'nope' });
  expect(artifactTool.isError).toBe(true);
  expect(artifactTool.content[0]?.text).toContain('next applies only to nodes');
});

// ── Per-transport accept AND apply ─────────────────────────────────────────

test.skipIf(!NORN)('the CLI applies the narrative to a container and a project', async () => {
  await cli(['update', phaseRef, '--direction', 'cli direction']);
  expect(await readNext(phaseRef)).toBe('cli direction');
  await cli(['update', 'MMR', '--direction', 'cli project direction']);
  expect(await readNext('MMR')).toBe('cli project direction');
});

test.skipIf(!NORN)('MCP applies the narrative to a container and a project', async () => {
  expect(
    (await toolUpdate(store, { id: initiativeRef, next: 'mcp direction' })).isError,
  ).toBeUndefined();
  expect(await readNext(initiativeRef)).toBe('mcp direction');
  expect(
    (await toolUpdate(store, { id: 'MMR', next: 'mcp project direction' })).isError,
  ).toBeUndefined();
  expect(await readNext('MMR')).toBe('mcp project direction');
});

test.skipIf(!NORN)('HTTP applies the narrative to a container and a project', async () => {
  const node = await fetch(`${base}/api/nodes/${phaseRef}`, {
    body: JSON.stringify({ next: 'http direction' }),
    headers: { 'content-type': 'application/json' },
    method: 'PATCH',
  });
  expect(node.status).toBe(200);
  expect(((await node.json()) as { next?: string }).next).toBe('http direction');
  expect(await readNext(phaseRef)).toBe('http direction');

  const project = await fetch(`${base}/api/projects/MMR`, {
    body: JSON.stringify({ next: 'http project direction' }),
    headers: { 'content-type': 'application/json' },
    method: 'PATCH',
  });
  expect(project.status).toBe(200);
  expect(((await project.json()) as { next?: string }).next).toBe('http project direction');
  expect(await readNext('MMR')).toBe('http project direction');
});

// ── Read surface ───────────────────────────────────────────────────────────

test.skipIf(!NORN)('the records view shows the narrative only when set (MMR-321)', async () => {
  expect(await cli(['get', phaseRef])).not.toContain('rendered direction');
  await updateNode(store, await nodeIdOf(store, phaseRef), { next: 'rendered direction' });
  expect(await cli(['get', phaseRef])).toMatch(/\bnext\s+rendered direction\b/);
  await updateProject(store, projectId, { next: 'project direction' });
  expect(await cli(['get', 'MMR'])).toMatch(/\bnext\s+project direction\b/);
});

test.skipIf(!NORN)(
  '--col next is opt-in vocabulary and never lands on a task (MMR-321)',
  async () => {
    await updateNode(store, await nodeIdOf(store, phaseRef), { next: 'column direction' });
    expect(await cli(['get', phaseRef, '--col', 'next', '-f', 'json'])).toContain(
      'column direction',
    );
    // A task carries no `## Next`, so the key is absent even when asked for.
    const task: unknown = JSON.parse(await cli(['get', taskRef, '--col', 'next', '-f', 'json']));
    expect(Object.keys(task as Record<string, unknown>)).not.toContain('next');
  },
);

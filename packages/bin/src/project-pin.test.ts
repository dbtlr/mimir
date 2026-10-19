import { afterEach, beforeEach, expect, test } from 'bun:test';

import {
  attachArtifact,
  createInitiative,
  createPhase,
  createProject,
  createTask,
  fileSeed,
  getNode,
  listProjects,
  updateProject,
} from '@mimir/core';
import type { Store } from '@mimir/core';
import { createTestStore, projectIdOf } from '@mimir/core/testing';

import { runCli } from './cli/run';
import { fakeIo } from './cli/testing';
import { toolProjects, toolUpdate } from './mcp/tools';

/**
 * The project pin (MMR-493), end to end: the operator's "keep this one at hand"
 * mark lives in the store, reads as `pinned` on every project projection, and is
 * written through `update KEY` on the CLI and MCP. Only a project can be pinned;
 * a task, container, seed, or artifact refuses it in the transport's own voice.
 */

let store: Store;
let closeStore: (() => Promise<void>) | undefined;
let projectId: string;
let phaseRef: string;
let taskRef: string;
let seedRef: string;
let artifactRef: string;

beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
  await createProject(store, { key: 'MMR', name: 'Mimir' });
  await createProject(store, { key: 'OPS', name: 'Operations' });
  projectId = await projectIdOf(store, 'MMR');
  const initiative = await createInitiative(store, { projectId, title: 'init' });
  const phase = await createPhase(store, { parentId: initiative.id, title: 'phase' });
  phaseRef = `MMR-${String(phase.seq)}`;
  const task = await createTask(store, { parentId: phase.id, title: 'task' });
  taskRef = `MMR-${String(task.seq)}`;
  seedRef = (await fileSeed(store, { kind: 'idea', project: 'MMR', requester: null, title: 's' }))
    .id;
  artifactRef = (await attachArtifact(store, { content: 'frozen', projectId, title: 'note' }))
    .renderedId;
});

afterEach(async () => {
  await closeStore?.();
});

/** Run the CLI over the fixture store, asserting the exit code. */
async function cli(argv: string[], code = 0): Promise<string> {
  const io = fakeIo(false);
  expect(await runCli(argv, () => store, io)).toBe(code);
  return [...io.out, ...io.err].join('\n');
}

/** The `pinned` of every listed project, keyed by project. */
async function pinsOf(): Promise<Record<string, boolean | undefined>> {
  const views = await listProjects(store, []);
  return Object.fromEntries(views.map((view) => [view.id, view.pinned]));
}

// ── Reads ──────────────────────────────────────────────────────────────────

test('a project reads unpinned until it is pinned, on get and on the list', async () => {
  expect((await getNode(store, 'MMR')).pinned).toBe(false);
  expect(await pinsOf()).toEqual({ MMR: false, OPS: false });

  await updateProject(store, projectId, { pinned: true });
  expect((await getNode(store, 'MMR')).pinned).toBe(true);
  expect(await pinsOf()).toEqual({ MMR: true, OPS: false });

  // A node is not a project: the field is project-only.
  expect((await getNode(store, taskRef)).pinned).toBeUndefined();
});

test('the wire carries pinned on a project and on no other node', async () => {
  await updateProject(store, projectId, { pinned: true });
  const project = JSON.parse(await cli(['get', 'MMR', '-f', 'json'])) as Record<string, unknown>;
  expect(project.pinned).toBe(true);
  const task = JSON.parse(await cli(['get', taskRef, '-f', 'json'])) as Record<string, unknown>;
  expect(Object.keys(task)).not.toContain('pinned');

  const listed = JSON.parse(await cli(['projects', '-f', 'json'])) as {
    projects: { id: string; pinned: boolean }[];
  };
  expect(listed.projects.map((p) => [p.id, p.pinned])).toEqual([
    ['MMR', true],
    ['OPS', false],
  ]);
});

test('the records view shows a pin only while it is set', async () => {
  expect(await cli(['get', 'MMR'])).not.toMatch(/\bpinned\b/);
  await updateProject(store, projectId, { pinned: true });
  expect(await cli(['get', 'MMR'])).toMatch(/\bpinned\s+yes\b/);
});

// ── Writes: accept AND apply, per transport ────────────────────────────────

test('the CLI pins and unpins with --pinned / --not-pinned and echoes the project', async () => {
  const pinned = JSON.parse(await cli(['update', 'MMR', '--pinned', '-f', 'json'])) as {
    pinned: boolean;
  };
  expect(pinned.pinned).toBe(true);
  expect(await pinsOf()).toEqual({ MMR: true, OPS: false });

  const unpinned = JSON.parse(await cli(['update', 'MMR', '--not-pinned', '-f', 'json'])) as {
    pinned: boolean;
  };
  expect(unpinned.pinned).toBe(false);
  expect(await pinsOf()).toEqual({ MMR: false, OPS: false });
});

test('the CLI refuses both pin flags at once, and leaves the project alone', async () => {
  const out = await cli(['update', 'MMR', '--pinned', '--not-pinned'], 2);
  expect(out).toContain('at most one of --pinned | --not-pinned');
  expect(await pinsOf()).toEqual({ MMR: false, OPS: false });
});

test('MCP pins and unpins a project through update', async () => {
  const pinned = await toolUpdate(store, { id: 'MMR', pinned: true });
  expect(pinned.isError).toBeUndefined();
  expect((JSON.parse(pinned.content[0]?.text ?? '{}') as { pinned: boolean }).pinned).toBe(true);
  expect(await pinsOf()).toEqual({ MMR: true, OPS: false });

  expect((await toolUpdate(store, { id: 'MMR', pinned: false })).isError).toBeUndefined();
  expect(await pinsOf()).toEqual({ MMR: false, OPS: false });
});

test('the MCP projects tool lists the pin', async () => {
  await updateProject(store, projectId, { pinned: true });
  const result = await toolProjects(store, {});
  const listed = JSON.parse(result.content[0]?.text ?? '{}') as {
    projects: { id: string; pinned: boolean }[];
  };
  expect(listed.projects.map((p) => [p.id, p.pinned])).toEqual([
    ['MMR', true],
    ['OPS', false],
  ]);
});

test('a pin write leaves the rest of the project alone', async () => {
  await updateProject(store, projectId, { description: 'keep me', name: 'Renamed' });
  await updateProject(store, projectId, { pinned: true });
  const view = await getNode(store, 'MMR');
  expect(view).toMatchObject({ description: 'keep me', pinned: true, title: 'Renamed' });
});

// ── Only a project can be pinned ───────────────────────────────────────────

test('the CLI refuses a pin on a task, a container, a seed, and an artifact', async () => {
  for (const ref of [taskRef, phaseRef]) {
    const out = await cli(['update', ref, '--pinned'], 1);
    expect(out).toContain("--pinned doesn't apply to a task or container");
    expect(out).toContain('only a project can be pinned');
  }
  expect(await cli(['update', taskRef, '--not-pinned'], 1)).toContain(
    "--not-pinned doesn't apply to a task or container",
  );
  // A seed's refusal is the usage class (exit 2), as for every node-only flag.
  expect(await cli(['update', seedRef, '--pinned'], 2)).toContain(
    "--pinned doesn't apply to a seed",
  );
  expect(await cli(['update', artifactRef, '--pinned'], 1)).toContain(
    "--pinned doesn't apply to an artifact",
  );
});

test('the CLI refuses a pin flag on a verb that does not read it', async () => {
  const out = await cli(['list', '--pinned'], 2);
  expect(out).toContain("'--pinned' doesn't apply to list");
  expect(out).toContain('mimir update <KEY> --pinned');
});

test('MCP refuses a pin on a task, a container, a seed, and an artifact', async () => {
  for (const ref of [taskRef, phaseRef, seedRef, artifactRef]) {
    const result = await toolUpdate(store, { id: ref, pinned: true });
    expect(result.isError, ref).toBe(true);
    expect(result.content[0]?.text, ref).toContain('only a project can be pinned');
  }
});

// ── Only a project can be renamed with --name (MMR-499) ────────────────────

test('the CLI refuses --name on a task, a container, a seed, and an artifact', async () => {
  for (const ref of [taskRef, phaseRef]) {
    const out = await cli(['update', ref, '--name', 'x'], 1);
    expect(out).toContain("--name doesn't apply to a task or container");
    expect(out).toContain('only a project can be renamed');
  }
  // A seed's refusal is the usage class (exit 2), as for every project-only flag.
  expect(await cli(['update', seedRef, '--name', 'x'], 2)).toContain(
    "--name doesn't apply to a seed",
  );
  expect(await cli(['update', artifactRef, '--name', 'x'], 1)).toContain(
    "--name doesn't apply to an artifact",
  );
  expect((await getNode(store, taskRef)).title).toBe('task');
});

test('the CLI still renames a project with --name', async () => {
  await cli(['update', 'MMR', '--name', 'Renamed']);
  expect((await getNode(store, 'MMR')).title).toBe('Renamed');
});

test('MCP refuses name on a task, a container, a seed, and an artifact', async () => {
  for (const ref of [taskRef, phaseRef, seedRef, artifactRef]) {
    const result = await toolUpdate(store, { id: ref, name: 'x' });
    expect(result.isError, ref).toBe(true);
    expect(result.content[0]?.text, ref).toContain('only a project can be renamed');
  }
  expect((await getNode(store, taskRef)).title).toBe('task');
});

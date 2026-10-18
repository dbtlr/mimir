import { afterEach, beforeEach, expect, test } from 'bun:test';

import { serveApi } from '@mimir/api/testing';
import {
  attachArtifact,
  createInitiative,
  createPhase,
  createProject,
  createTask,
  fileSeed,
  getNode,
} from '@mimir/core';
import type { Store } from '@mimir/core';
import { createTestStore, projectIdOf } from '@mimir/core/testing';
import type { Server } from 'bun';

import { runCli } from './cli/run';
import { fakeIo } from './cli/testing';
import { toolCreate, toolUpdate } from './mcp/tools';

/**
 * The project remote (MMR-543), end to end: a Git clone URL stored normalized on
 * a project, read as `remote`, and written through create and update on each
 * transport. A blank value clears it. Only a project takes it; any other node,
 * seed, or artifact refuses it in the transport's own voice.
 */

let store: Store;
let closeStore: (() => Promise<void>) | undefined;
let server: Server<undefined>;
let base: string;
let projectId: string;
let phaseRef: string;
let taskRef: string;
let seedRef: string;
let artifactRef: string;

beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
  await createProject(store, { key: 'MMR', name: 'Mimir' });
  projectId = await projectIdOf(store, 'MMR');
  const initiative = await createInitiative(store, {
    projectId,
    title: 'init',
  });
  const phase = await createPhase(store, {
    parentId: initiative.id,
    title: 'phase',
  });
  phaseRef = `MMR-${String(phase.seq)}`;
  const task = await createTask(store, { parentId: phase.id, title: 'task' });
  taskRef = `MMR-${String(task.seq)}`;
  seedRef = (
    await fileSeed(store, {
      kind: 'idea',
      project: 'MMR',
      requester: null,
      title: 's',
    })
  ).id;
  artifactRef = (await attachArtifact(store, { content: 'frozen', projectId, title: 'note' }))
    .renderedId;
  server = serveApi(store, { version: '0.0.0-test' });
  base = `http://127.0.0.1:${String(server.port)}`;
});

afterEach(async () => {
  await server?.stop(true);
  await closeStore?.();
});

/** Run the CLI over the fixture store, asserting the exit code. */
async function cli(argv: string[], code = 0): Promise<string> {
  const io = fakeIo(false);
  expect(await runCli(argv, () => store, io)).toBe(code);
  return [...io.out, ...io.err].join('\n');
}

async function patch(
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/${path}`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'PATCH',
  });
  return {
    json: (await res.json()) as Record<string, unknown>,
    status: res.status,
  };
}

/** The stored remote of a project, read through `get`. */
async function remoteOf(key: string): Promise<string | null | undefined> {
  return (await getNode(store, key)).remote;
}

async function post(
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/${path}`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  return {
    json: (await res.json()) as Record<string, unknown>,
    status: res.status,
  };
}

const SSH = 'git@github.com:dbtlr/mimir.git';
const NORMAL = 'github.com/dbtlr/mimir';

test('the CLI sets, shows, and clears a remote; a blank clears it', async () => {
  const set = JSON.parse(await cli(['update', 'MMR', '--remote', SSH, '-f', 'json'])) as {
    remote: string;
  };
  expect(set.remote).toBe(NORMAL);
  const got = JSON.parse(await cli(['get', 'MMR', '-f', 'json'])) as {
    remote: string;
  };
  expect(got.remote).toBe(NORMAL);
  expect(await cli(['get', 'MMR'])).toMatch(/\bremote\s+github\.com\/dbtlr\/mimir/);

  await cli(['update', 'MMR', '--remote', '']);
  expect(await remoteOf('MMR')).toBeNull();
  expect(await cli(['get', 'MMR'])).not.toMatch(/\bremote\b/);
});

test('the CLI refuses a value that is not a remote and keeps the stored one', async () => {
  await cli(['update', 'MMR', '--remote', SSH]);
  expect(await cli(['update', 'MMR', '--remote', 'nope'], 1)).toContain('not a Git remote');
  expect(await remoteOf('MMR')).toBe(NORMAL);
});

test('the CLI creates a project with a remote, and a blank means none', async () => {
  await cli(['create', 'project', 'New', '--key', 'NEW', '-y', '--remote', SSH]);
  expect(await remoteOf('NEW')).toBe(NORMAL);
  await cli(['create', 'project', 'Two', '--key', 'TWO', '-y', '--remote', '']);
  expect(await remoteOf('TWO')).toBeNull();
});

test('MCP creates, updates, and clears a remote', async () => {
  const created = await toolCreate(store, {
    key: 'MCP',
    name: 'm',
    remote: SSH,
    type: 'project',
  });
  expect(created.isError).toBeUndefined();
  expect(await remoteOf('MCP')).toBe(NORMAL);

  expect((await toolUpdate(store, { id: 'MCP', remote: '' })).isError).toBeUndefined();
  expect(await remoteOf('MCP')).toBeNull();
  expect((await toolUpdate(store, { id: 'MCP', remote: SSH })).isError).toBeUndefined();
  expect(await remoteOf('MCP')).toBe(NORMAL);

  const blank = await toolCreate(store, {
    key: 'BLK',
    name: 'b',
    remote: '',
    type: 'project',
  });
  expect(blank.isError).toBeUndefined();
  expect(await remoteOf('BLK')).toBeNull();
});

test('HTTP creates a project with a remote, and PATCH sets and clears it', async () => {
  const created = await post('projects', {
    key: 'HTP',
    name: 'h',
    remote: SSH,
  });
  expect(created.status).toBe(201);
  expect(created.json.remote).toBe(NORMAL);

  const cleared = await patch('projects/HTP', { remote: '  ' });
  expect(cleared.status).toBe(200);
  expect(await remoteOf('HTP')).toBeNull();
  const set = await patch('projects/HTP', { remote: SSH });
  expect(set.json.remote).toBe(NORMAL);
  expect((await patch('projects/HTP', { remote: 'nope' })).status).toBe(400);
  expect(await remoteOf('HTP')).toBe(NORMAL);
});

test('the CLI refuses --remote on a task, a container, a seed, and an artifact', async () => {
  for (const ref of [taskRef, phaseRef]) {
    expect(await cli(['update', ref, '--remote', SSH], 1)).toContain(
      "--remote doesn't apply to a task or container",
    );
  }
  expect(await cli(['update', seedRef, '--remote', SSH], 2)).toContain(
    "--remote doesn't apply to a seed",
  );
  expect(await cli(['update', artifactRef, '--remote', SSH], 1)).toContain(
    "--remote doesn't apply to an artifact",
  );
  expect(await cli(['create', 'task', 'x', '--parent', phaseRef, '--remote', SSH], 1)).toContain(
    '--remote applies only to a project',
  );
});

test('MCP refuses remote on a task, a container, a seed, and an artifact', async () => {
  for (const ref of [taskRef, phaseRef, seedRef, artifactRef]) {
    const result = await toolUpdate(store, { id: ref, remote: SSH });
    expect(result.isError, ref).toBe(true);
  }
  const created = await toolCreate(store, {
    parent: phaseRef,
    remote: SSH,
    title: 't',
    type: 'task',
  });
  expect(created.isError).toBe(true);
});

test('HTTP refuses remote on a node, a seed, and an artifact', async () => {
  for (const path of [
    `nodes/${taskRef}`,
    `nodes/${phaseRef}`,
    `seeds/${seedRef}`,
    `artifacts/${artifactRef}`,
  ]) {
    const res = await patch(path, { remote: SSH });
    expect(res.status, path).toBe(400);
    expect(JSON.stringify(res.json), path).toContain('remote');
  }
});

import { afterEach, beforeEach, expect, test } from 'bun:test';

import { OP_FACTS, UNIFORM_VERBS } from '@mimir/contract';
import type { TaskStatusWord, UniformVerb } from '@mimir/contract';
import type { Server } from 'bun';

import { runCli } from './cli/run';
import { fakeIo } from './cli/testing';
import {
  archiveProject,
  blockTask,
  completeTask,
  createInitiative,
  createPhase,
  createProject,
  createTask,
  deriveSet,
  findNodeInSet,
  nodeStatusWord,
  parkTask,
  startTask,
  submitTask,
} from './core';
import type { Store } from './core';
import { createServer } from './http/server';
import { toolUniform } from './mcp/tools';
import { createTestStore, nodeIdOf, projectIdOf } from './testing/store';

/**
 * The route-level propagation pin for the operation registry (ADR 0025, MMR-316)
 * — the ops sibling of the field application pin. Registering/routing a uniform
 * verb without wiring its `run` would be an advertise-without-execute gap; this
 * drives every uniform verb end-to-end through each real transport (the CLI via
 * `runCli`, HTTP via a live loopback server, MCP via `toolUniform` over a real
 * store) from its correct pre-state and asserts the transition actually lands.
 * A registry entry whose transport dispatch doesn't reach the core turns it red.
 */

const NORN = Bun.which('norn') !== null;

let store: Store;
let closeStore: (() => Promise<void>) | undefined;
let server: Server<undefined>;
let base: string;
let projectId: string;
let phaseId: string;

beforeEach(async () => {
  if (!NORN) {
    return;
  }
  ({ close: closeStore, store } = await createTestStore());
  await createProject(store, { key: 'MMR', name: 'Mimir' });
  projectId = await projectIdOf(store, 'MMR');
  const init = await createInitiative(store, { projectId, title: 'init' });
  const initId = await nodeIdOf(store, `MMR-${String(init.seq)}`);
  const phase = await createPhase(store, { parentId: initId, title: 'phase' });
  phaseId = await nodeIdOf(store, `MMR-${String(phase.seq)}`);
  server = createServer(store, { port: 0, version: '0.0.0-test' });
  base = `http://127.0.0.1:${String(server.port)}`;
});

afterEach(async () => {
  await server?.stop(true);
  await closeStore?.();
});

/** A fresh task in the pre-state the verb-under-test requires. */
async function taskInPreState(verb: UniformVerb): Promise<string> {
  const task = await createTask(store, { parentId: phaseId, title: 't' });
  const ref = `MMR-${String(task.seq)}`;
  const id = await nodeIdOf(store, ref);
  switch (verb) {
    case 'submit':
    case 'done': {
      // `done` is legal from todo, but exercise the in_progress path.
      await startTask(store, id);
      break;
    }
    case 'return': {
      await startTask(store, id);
      await submitTask(store, id);
      break;
    }
    case 'reopen': {
      await completeTask(store, id);
      break;
    }
    case 'unpark': {
      await parkTask(store, id);
      break;
    }
    case 'unblock': {
      await blockTask(store, id);
      break;
    }
    default: {
      break; // start/abandon/park/block act on a fresh todo task
    }
  }
  return ref;
}

/** A fresh project KEY in the pre-state the archive verb requires. */
let projectSeq = 0;
async function projectInPreState(verb: UniformVerb): Promise<string> {
  // Project keys are uppercase-letter only ([A-Z]{2,4}); cycle XA, XB, ….
  const key = `X${String.fromCharCode(65 + projectSeq)}`;
  projectSeq += 1;
  await createProject(store, { key, name: key });
  if (verb === 'unarchive') {
    await archiveProject(store, await projectIdOf(store, key));
  }
  return key;
}

/** The status word each node verb lands the task on (its post-state). */
const NODE_POST: Partial<Record<UniformVerb, TaskStatusWord>> = {
  abandon: 'abandoned',
  block: 'blocked',
  done: 'done',
  park: 'parked',
  reopen: 'in_progress',
  return: 'in_progress',
  start: 'in_progress',
  submit: 'under_review',
  unblock: 'ready',
  unpark: 'ready',
};

async function nodeStatus(ref: string): Promise<TaskStatusWord | undefined> {
  const set = deriveSet(await store.loadWorkingSet());
  const node = findNodeInSet(set, ref);
  return node === undefined ? undefined : (nodeStatusWord(set, node) as TaskStatusWord);
}

async function projectArchived(key: string): Promise<boolean> {
  const ws = await store.loadWorkingSet();
  return ws.projects.find((p) => p.key === key)?.archived_at !== null;
}

type Driver = (verb: UniformVerb, ref: string) => Promise<void>;

const cliDrive: Driver = async (verb, ref) => {
  const code = await runCli([verb, ref, '-f', 'json'], () => store, fakeIo(false));
  expect(code).toBe(0);
};

const httpDrive: Driver = async (verb, ref) => {
  const path =
    OP_FACTS[verb].subject === 'project'
      ? `${base}/api/projects/${ref}/${verb}`
      : `${base}/api/nodes/${ref}/${verb}`;
  const res = await fetch(path, { method: 'POST' });
  expect(res.status).toBe(200);
};

const mcpDrive: Driver = async (verb, ref) => {
  const args = OP_FACTS[verb].subject === 'project' ? { key: ref } : { id: ref };
  const res = await toolUniform(store, verb, args);
  expect(res.isError).toBeUndefined();
};

const DRIVERS: [name: string, drive: Driver][] = [
  ['cli', cliDrive],
  ['http', httpDrive],
  ['mcp', mcpDrive],
];

/**
 * Golden pin of the twelve human-format echo signposts through the real CLI
 * dispatch (plain rendering, reasoned variant where the policy allows). The
 * `-f json` driver below bypasses the prose entirely, so participle or
 * transition-suffix template drift (`doned`, a lost bare arrow) lands here.
 */
const ECHO_SIGNPOST: Record<UniformVerb, (ref: string) => string> = {
  abandon: (r) => `[ok] abandoned ${r}`,
  archive: (r) => `[ok] archived ${r}`,
  block: (r) => `[ok] blocked ${r}`,
  done: (r) => `[ok] completed ${r}`,
  park: (r) => `[ok] parked ${r}`,
  reopen: (r) => `[ok] reopened ${r} -> in_progress`,
  return: (r) => `[ok] returned ${r} · under_review -> in_progress`,
  start: (r) => `[ok] started ${r} · todo -> in_progress`,
  submit: (r) => `[ok] submitted ${r} · in_progress -> under_review`,
  unarchive: (r) => `[ok] unarchived ${r}`,
  unblock: (r) => `[ok] unblocked ${r}`,
  unpark: (r) => `[ok] unparked ${r}`,
};

async function refInPreState(verb: UniformVerb): Promise<string> {
  return OP_FACTS[verb].subject === 'project'
    ? await projectInPreState(verb)
    : await taskInPreState(verb);
}

for (const verb of UNIFORM_VERBS) {
  test.skipIf(!NORN)(`cli echo golden: ${verb}`, async () => {
    const ref = await refInPreState(verb);
    const io = fakeIo(false);
    expect(await runCli([verb, ref, '-f', 'records'], () => store, io)).toBe(0);
    expect(io.out.join('\n')).toContain(ECHO_SIGNPOST[verb](ref));
  });
  if (OP_FACTS[verb].reason === 'optional') {
    test.skipIf(!NORN)(`cli echo golden: ${verb} with reason`, async () => {
      const ref = await refInPreState(verb);
      const io = fakeIo(false);
      expect(await runCli([verb, ref, 'smoke reason', '-f', 'records'], () => store, io)).toBe(0);
      expect(io.out.join('\n')).toContain(`${ECHO_SIGNPOST[verb](ref)} · smoke reason`);
    });
  }
}

for (const verb of UNIFORM_VERBS) {
  for (const [name, drive] of DRIVERS) {
    test.skipIf(!NORN)(`${name} drives ${verb} end-to-end`, async () => {
      if (OP_FACTS[verb].subject === 'project') {
        const key = await projectInPreState(verb);
        await drive(verb, key);
        expect(await projectArchived(key)).toBe(verb === 'archive');
        return;
      }
      const ref = await taskInPreState(verb);
      await drive(verb, ref);
      expect(await nodeStatus(ref)).toBe(NODE_POST[verb] as TaskStatusWord);
    });
  }
}

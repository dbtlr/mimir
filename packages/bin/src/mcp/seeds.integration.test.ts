import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseJson } from '@mimir/helpers';

import {
  createInitiative,
  createPhase,
  createProject,
  deriveSet,
  findNodeInSet,
  resolveProjectKeyInSet,
} from '../core';
import type { Store } from '../core';
import { bunExec } from '../exec';
import { NornClient } from '../norn/client';
import { createNornWriteStore } from '../norn/writer';
import { converge } from '../vault/converge';
import { toolPromote, toolReject, toolSeed, toolSeeds } from './tools';
import type { ToolResult } from './tools';

/** The seed MCP tools (MMR-245) over a real Norn store. Needs `norn`. */
const NORN = Bun.which('norn') !== null;

let root: string;
let client: NornClient;
let store: Store;
let phaseRef: string;

const body = (r: ToolResult): Record<string, unknown> =>
  parseJson<Record<string, unknown>>(r.content[0]?.text ?? '');

async function idOf(ref: string): Promise<number> {
  const node = findNodeInSet(deriveSet(await store.loadWorkingSet()), ref);
  if (node === undefined) {
    throw new Error(`no node ${ref}`);
  }
  return node.id;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mimir-mcpseed-'));
  const vault = join(root, 'vault');
  await converge(vault, { allowCreate: true, exec: bunExec });
  client = new NornClient({ vaultPath: vault });
  store = createNornWriteStore(client, vault);
  await createProject(store, { key: 'MMR', name: 'Mimir' });
  const pid = resolveProjectKeyInSet(deriveSet(await store.loadWorkingSet()), 'MMR');
  const init = await createInitiative(store, { projectId: pid, title: 'init' });
  const phase = await createPhase(store, {
    parentId: await idOf(`MMR-${String(init.seq)}`),
    title: 'phase',
  });
  phaseRef = `MMR-${String(phase.seq)}`;
});

afterEach(async () => {
  await client.close();
  rmSync(root, { force: true, recursive: true });
});

describe.skipIf(!NORN)('seed MCP tools', () => {
  test('seed defaults the target from the bound scope; seeds lists it', async () => {
    const filed = body(await toolSeed(store, { kind: 'bug', title: 'flaky' }, 'MMR'));
    expect(filed).toMatchObject({ id: 'MMR-s1', kind: 'bug', project: 'MMR', requester: null });
    const queue = body(await toolSeeds(store, {}, 'MMR')) as { seeds: { id: string }[] };
    expect(queue.seeds.map((s) => s.id)).toEqual(['MMR-s1']);
  });

  test('promote spawns work and moves the seed to promoted; reject is terminal', async () => {
    await toolSeed(store, { kind: 'feature', title: 's' }, 'MMR');
    const promoted = body(await toolPromote(store, { id: 'MMR-s1', parent: phaseRef })) as {
      lifecycle: string;
      spawned: string[];
      created?: string;
    };
    expect(promoted.lifecycle).toBe('promoted');
    expect(promoted.spawned).toHaveLength(1);
    // The created task id rides as a sibling of the seed wire (B7).
    expect(promoted.created).toMatch(/^MMR-\d+$/);

    await toolSeed(store, { kind: 'idea', title: 't' }, 'MMR');
    const rejected = body(await toolReject(store, { id: 'MMR-s2', reason: 'out of scope' }));
    expect(rejected).toMatchObject({ id: 'MMR-s2', lifecycle: 'rejected' });
  });

  test('seed with an unknown kind returns a structured error', async () => {
    const res = await toolSeed(store, { kind: 'chore', title: 'x' }, 'MMR');
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toMatch(/invalid kind/);
  });
});

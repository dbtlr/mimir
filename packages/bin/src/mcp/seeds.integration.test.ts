import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseJson } from '@mimir/helpers';

import {
  createInitiative,
  createPhase,
  createProject,
  createTask,
  deriveSet,
  findNodeInSet,
  resolveProjectKeyInSet,
} from '../core';
import type { Store } from '../core';
import { NornClient } from '../core/store-norn/client';
import { createNornWriteStore } from '../core/store-norn/writer';
import { bunExec } from '../exec';
import { converge } from '../vault/converge';
import { toolPromote, toolReject, toolResolve, toolSeed, toolSeeds, toolTriage } from './tools';
import type { ToolResult } from './tools';

/** The seed MCP tools (MMR-245) over a real Norn store. Needs `norn`. */
const NORN = Bun.which('norn') !== null;

let root: string;
let client: NornClient;
let store: Store;
let phaseRef: string;

const body = (r: ToolResult): Record<string, unknown> =>
  parseJson<Record<string, unknown>>(r.content[0]?.text ?? '');

async function idOf(ref: string): Promise<string> {
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

  test('triage reports the three checks and idempotently annotates upstream resolutions', async () => {
    // An untriaged seed, plus a resolved seed a requester-side task answers.
    await toolSeed(store, { kind: 'idea', title: 'rough' }, 'MMR');
    await toolSeed(store, { kind: 'bug', title: 'the ask' }, 'MMR');
    const task = await createTask(store, {
      parentId: await idOf(phaseRef),
      title: 'answers',
      upstream: 'MMR-s2',
    });
    await toolResolve(store, { id: 'MMR-s2', reason: 'shipped' });

    const first = body(await toolTriage(store, {}, 'MMR')) as {
      board: string;
      dry_run: boolean;
      untriaged: { id: string }[];
      upstream_resolutions: { task: string; upstream: string; annotated: boolean }[];
    };
    expect(first.board).toBe('MMR');
    expect(first.dry_run).toBe(false);
    expect(first.untriaged.map((s) => s.id)).toEqual(['MMR-s1']);
    expect(first.upstream_resolutions).toEqual([
      expect.objectContaining({
        annotated: true,
        task: `MMR-${String(task.seq)}`,
        upstream: 'MMR-s2',
      }),
    ]);

    // A re-run recognizes its own annotation — a no-op.
    const second = body(await toolTriage(store, {}, 'MMR')) as {
      upstream_resolutions: { annotated: boolean; already_recorded: boolean }[];
    };
    expect(second.upstream_resolutions[0]).toMatchObject({
      already_recorded: true,
      annotated: false,
    });
  });

  test('triage with a blank board is the friendly board error (not projectNotFound)', async () => {
    for (const board of ['', '   ']) {
      const res = await toolTriage(store, { board }, undefined);
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toMatch(/triage requires a board/);
    }
  });
});

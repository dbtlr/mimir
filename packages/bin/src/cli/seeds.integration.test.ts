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
import { runCli } from './run';
import { fakeIo } from './testing';

/**
 * The seed CLI verbs (MMR-245) end-to-end over a real Norn store — dispatch,
 * parsing, the resolving read, and the JSON echo contract. Needs `norn`.
 */
const NORN = Bun.which('norn') !== null;

let root: string;
let client: NornClient;
let store: Store;
let phaseRef: string;

/** Run a CLI invocation bound to MMR; returns the exit code + captured io. */
async function cli(
  argv: string[],
  scope = 'MMR',
): Promise<{ code: number; io: ReturnType<typeof fakeIo> }> {
  const io = fakeIo();
  const code = await runCli(argv, () => store, io, { scope });
  return { code, io };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mimir-cliseed-'));
  const vault = join(root, 'vault');
  await converge(vault, { allowCreate: true, exec: bunExec });
  client = new NornClient({ vaultPath: vault });
  store = createNornWriteStore(client, vault);
  await createProject(store, { key: 'MMR', name: 'Mimir' });
  const pid = resolveProjectKeyInSet(deriveSet(await store.loadWorkingSet()), 'MMR');
  const init = await createInitiative(store, { projectId: pid, title: 'init' });
  const initId = await idOf(`MMR-${String(init.seq)}`);
  const phase = await createPhase(store, { parentId: initId, title: 'phase' });
  phaseRef = `MMR-${String(phase.seq)}`;
});

/** Resolve a node's surrogate id by its KEY-seq ref (Norn ids are provisional). */
async function idOf(ref: string): Promise<number> {
  const node = findNodeInSet(deriveSet(await store.loadWorkingSet()), ref);
  if (node === undefined) {
    throw new Error(`no node ${ref}`);
  }
  return node.id;
}

afterEach(async () => {
  await client.close();
  rmSync(root, { force: true, recursive: true });
});

describe.skipIf(!NORN)('seed CLI verbs', () => {
  test('seed files against the bound board, echoing the record (-f json)', async () => {
    const { code, io } = await cli(['seed', 'flaky login', '-k', 'bug', '-f', 'json']);
    expect(code).toBe(0);
    const rec = parseJson<Record<string, unknown>>(io.out.join(''));
    expect(rec).toMatchObject({
      id: 'MMR-s1',
      kind: 'bug',
      lifecycle: 'new',
      project: 'MMR',
      requester: null,
      title: 'flaky login',
    });
  });

  test('seed -k rejects an invalid kind (usage, exit 2)', async () => {
    const { code, io } = await cli(['seed', 't', '-k', 'chore']);
    expect(code).toBe(2);
    expect(io.err.join('')).toMatch(/invalid kind/);
  });

  test('seed -p files into another board, recording the bound board as requester', async () => {
    await createProject(store, { key: 'OTH', name: 'Other' });
    const { code, io } = await cli(['seed', 'cross', '-k', 'idea', '-p', 'OTH', '-f', 'json']);
    expect(code).toBe(0);
    const rec = parseJson<Record<string, unknown>>(io.out.join(''));
    expect(rec).toMatchObject({ id: 'OTH-s1', project: 'OTH', requester: 'MMR' });
  });

  test('seeds lists the live queue and reaches terminals via --status', async () => {
    await cli(['seed', 'a', '-k', 'idea']);
    await cli(['seed', 'b', '-k', 'bug']);
    await cli(['reject', 'MMR-s2', 'nope']);
    const live = await cli(['seeds', '-f', 'json']);
    const liveRec = parseJson<{ seeds: { id: string }[] }>(live.io.out.join(''));
    expect(liveRec.seeds.map((s) => s.id)).toEqual(['MMR-s1']);
    const all = await cli(['seeds', '--status', 'all', '-f', 'json']);
    const allRec = parseJson<{ seeds: { id: string }[] }>(all.io.out.join(''));
    expect(allRec.seeds.map((s) => s.id).toSorted()).toEqual(['MMR-s1', 'MMR-s2']);
  });

  test('promote --parent creates a task and moves the seed to promoted', async () => {
    await cli(['seed', 's', '-k', 'feature']);
    const { code, io } = await cli(['promote', 'MMR-s1', '--parent', phaseRef, '-f', 'json']);
    expect(code).toBe(0);
    const rec = parseJson<{ lifecycle: string; spawned: string[] }>(io.out.join(''));
    expect(rec.lifecycle).toBe('promoted');
    expect(rec.spawned).toHaveLength(1);
  });

  test('update KEY-sN routes to the seed patch; a node-only flag is refused', async () => {
    await cli(['seed', 's', '-k', 'idea']);
    const ok = await cli(['update', 'MMR-s1', '--title', 'renamed', '-k', 'bug', '-f', 'json']);
    expect(ok.code).toBe(0);
    const rec = parseJson<{ title: string; kind: string }>(ok.io.out.join(''));
    expect(rec).toMatchObject({ kind: 'bug', title: 'renamed' });
    const bad = await cli(['update', 'MMR-s1', '--size', 'm']);
    expect(bad.code).toBe(1);
    expect(bad.io.err.join('')).toMatch(/doesn't apply to a seed/);
  });

  test('reject requires a reason (usage, exit 2)', async () => {
    await cli(['seed', 's', '-k', 'idea']);
    const { code, io } = await cli(['reject', 'MMR-s1']);
    expect(code).toBe(2);
    expect(io.err.join('')).toMatch(/requires a reason/);
  });

  test('promote takes only an s-id (a node id is a usage error)', async () => {
    const { code, io } = await cli(['promote', 'MMR-1', '--parent', phaseRef]);
    expect(code).toBe(2);
    expect(io.err.join('')).toMatch(/seed id \(KEY-sN\)/);
  });
});

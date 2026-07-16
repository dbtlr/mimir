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

/** Resolve a node's canonical stem by its KEY-seq ref. */
async function idOf(ref: string): Promise<string> {
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
    const rec = parseJson<{ created: string; lifecycle: string; spawned: string[] }>(
      io.out.join(''),
    );
    expect(rec.lifecycle).toBe('promoted');
    expect(rec.spawned).toHaveLength(1);
    // The echo carries the spawned task id as a sibling `created` field (MMR-245),
    // matching the MCP/HTTP promote echo (promoteToWire/formatPromoteJson).
    expect(rec.spawned).toEqual([rec.created]);
  });

  test('promote --parent -f ids echoes the spawned task id, not the seed (MMR-259)', async () => {
    await cli(['seed', 's', '-k', 'feature']);
    const { code, io } = await cli(['promote', 'MMR-s1', '--parent', phaseRef, '-f', 'ids']);
    expect(code).toBe(0);
    const spawnedId = io.out.join('').trim();
    expect(spawnedId).not.toBe('MMR-s1');
    expect(spawnedId).toMatch(/^MMR-\d+$/);
  });

  test('promote --link -f ids echoes the linked work id, not the seed (MMR-259)', async () => {
    const existing = await createTask(store, { parentId: await idOf(phaseRef), title: 'existing' });
    const existingRef = `MMR-${String(existing.seq)}`;
    await cli(['seed', 's', '-k', 'bug']);
    const { code, io } = await cli(['promote', 'MMR-s1', '--link', existingRef, '-f', 'ids']);
    expect(code).toBe(0);
    expect(io.out.join('').trim()).toBe(existingRef);
  });

  test('a repeated promote -f ids echoes the newly spawned id each time (MMR-259)', async () => {
    await cli(['seed', 's', '-k', 'feature']);
    const first = await cli(['promote', 'MMR-s1', '--parent', phaseRef, '-f', 'ids']);
    const second = await cli(['promote', 'MMR-s1', '--parent', phaseRef, '-f', 'ids']);
    const firstId = first.io.out.join('').trim();
    const secondId = second.io.out.join('').trim();
    expect(secondId).not.toBe(firstId);
    expect(secondId).not.toBe('MMR-s1');
  });

  test('update KEY-sN routes to the seed patch; a node-only flag is refused', async () => {
    await cli(['seed', 's', '-k', 'idea']);
    const ok = await cli(['update', 'MMR-s1', '--title', 'renamed', '-k', 'bug', '-f', 'json']);
    expect(ok.code).toBe(0);
    const rec = parseJson<{ title: string; kind: string }>(ok.io.out.join(''));
    expect(rec).toMatchObject({ kind: 'bug', title: 'renamed' });
    // A node-only flag is a bad invocation → usage/exit-2 (B5a), not a value fault.
    const bad = await cli(['update', 'MMR-s1', '--size', 'm']);
    expect(bad.code).toBe(2);
    expect(bad.io.err.join('')).toMatch(/doesn't apply to a seed/);
  });

  test('update KEY-sN --priority is a usage error (exit 2) — priority is inapplicable (B5a)', async () => {
    await cli(['seed', 's', '-k', 'idea']);
    const bad = await cli(['update', 'MMR-s1', '--priority', 'p1']);
    expect(bad.code).toBe(2);
    expect(bad.io.err.join('')).toMatch(/doesn't apply to a seed/);
  });

  test('get KEY-sN routes to the seed reader — records + json (B3)', async () => {
    await cli(['seed', 'a seed', '-k', 'bug', '--desc', 'the prose']);
    const recs = await cli(['get', 'MMR-s1']);
    expect(recs.code).toBe(0);
    expect(recs.io.out.join('')).toMatch(/MMR-s1/);
    expect(recs.io.out.join('')).toMatch(/the prose/);
    const asJson = await cli(['get', 'MMR-s1', '-f', 'json']);
    const rec = parseJson<Record<string, unknown>>(asJson.io.out.join(''));
    expect(rec).toMatchObject({ id: 'MMR-s1', kind: 'bug', lifecycle: 'new', project: 'MMR' });
  });

  test('node verbs reject a seed id as a kind-error, not a fake not_found (B4)', async () => {
    await cli(['seed', 's', '-k', 'idea']); // MMR-s1
    for (const argv of [
      ['done', 'MMR-s1'],
      ['start', 'MMR-s1'],
      ['status', 'MMR-s1'],
      ['tree', 'MMR-s1'],
      ['tag', 'MMR-s1', 'x'],
    ]) {
      const { code, io } = await cli(argv);
      expect(code).not.toBe(0);
      expect(io.err.join('')).toMatch(/is a seed/);
      expect(io.err.join('')).not.toMatch(/doesn't exist/);
    }
  });

  test('seeds -p all reads every active board (B5b)', async () => {
    await createProject(store, { key: 'OTH', name: 'Other' });
    await cli(['seed', 'here', '-k', 'idea']); // MMR-s1
    await cli(['seed', 'there', '-k', 'bug', '-p', 'OTH']); // OTH-s1
    const all = await cli(['seeds', '-p', 'all', '-f', 'json']);
    expect(all.code).toBe(0);
    const rec = parseJson<{ seeds: { id: string }[] }>(all.io.out.join(''));
    expect(rec.seeds.map((s) => s.id).toSorted()).toEqual(['MMR-s1', 'OTH-s1']);
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

  test('triage reconciles the bound board — json report + idempotent annotation', async () => {
    await cli(['seed', 'rough', '-k', 'idea']); // MMR-s1 (untriaged)
    await cli(['seed', 'the ask', '-k', 'bug']); // MMR-s2
    const task = await createTask(store, {
      parentId: await idOf(phaseRef),
      title: 'answers',
      upstream: 'MMR-s2',
    });
    await cli(['resolve', 'MMR-s2', 'shipped']);

    const first = await cli(['triage', '-f', 'json']);
    expect(first.code).toBe(0);
    const rep = parseJson<{
      board: string;
      dry_run: boolean;
      untriaged: { id: string }[];
      upstream_resolutions: { task: string; upstream: string; annotated: boolean }[];
    }>(first.io.out.join(''));
    expect(rep.board).toBe('MMR');
    expect(rep.untriaged.map((s) => s.id)).toEqual(['MMR-s1']);
    expect(rep.upstream_resolutions).toEqual([
      expect.objectContaining({
        annotated: true,
        task: `MMR-${String(task.seq)}`,
        upstream: 'MMR-s2',
      }),
    ]);

    // Re-run: recognized, no-op.
    const second = await cli(['triage', '-f', 'json']);
    const rep2 = parseJson<{ upstream_resolutions: { already_recorded: boolean }[] }>(
      second.io.out.join(''),
    );
    expect(rep2.upstream_resolutions[0]?.already_recorded).toBe(true);
  });

  test('triage --dry-run previews without writing, and renders a human report', async () => {
    await cli(['seed', 'the ask', '-k', 'bug']); // MMR-s1
    const task = await createTask(store, {
      parentId: await idOf(phaseRef),
      title: 'answers',
      upstream: 'MMR-s1',
    });
    await cli(['resolve', 'MMR-s1', 'done']);

    // `-f records` forces the human report (non-TTY report mode defaults to json).
    const dry = await cli(['triage', '--dry-run', '-f', 'records']);
    expect(dry.code).toBe(0);
    const out = dry.io.out.join('');
    expect(out).toMatch(/triage MMR/);
    expect(out).toMatch(/upstream resolutions \(1\)/);
    expect(out).toMatch(/would annotate/);

    // Nothing was written — a real run still annotates.
    const notes = await store.bodySections.readAnnotations(`MMR-${String(task.seq)}`);
    expect(notes).toHaveLength(0);
  });

  test('bare triage without a bound board is a usage error (exit 2)', async () => {
    const io = fakeIo();
    const code = await runCli(['triage'], () => store, io, {}); // unbound
    expect(code).toBe(2);
    expect(io.err.join('')).toMatch(/triage requires a board/);
  });
});

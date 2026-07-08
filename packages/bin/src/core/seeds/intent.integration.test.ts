import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bunExec } from '../../exec';
import { NornClient } from '../../norn/client';
import { createNornWriteStore } from '../../norn/writer';
import { converge } from '../../vault/converge';
import { deriveSet, findNodeInSet } from '../derive';
import {
  abandonTask,
  completeTask,
  createInitiative,
  createPhase,
  createProject,
  createTask,
} from '../index';
import { resolveProjectKeyInSet } from '../resolve-set';
import type { Store } from '../store';
import { readVaultGraph } from '../store-norn';
import { validate } from '../validate';
import { fileSeed, getSeed, listSeeds, promoteSeed, transitionSeed, updateSeed } from './intent';

/**
 * The seed verb surface (MMR-245) against a real converged vault — the intent
 * layer + the resolving read seam. Needs a `norn` binary; skipped when off PATH.
 */
const NORN = Bun.which('norn') !== null;

async function rejectMessage(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected a rejection, but the call resolved');
}

let root: string;
let client: NornClient;
let store: Store;

/**
 * A phase (KEY-seq) under a fresh initiative — a valid `--parent` for promote.
 * Over the Norn store, surrogate ids are provisional until applied, so each
 * child resolves its parent by the stable `KEY-seq` ref, not the returned id.
 */
async function seedbed(key = 'MMR'): Promise<{ phaseRef: string }> {
  await createProject(store, { key, name: key });
  const projectId = await pidOf(key);
  const init = await createInitiative(store, { projectId, title: 'init' });
  const initId = await idOf(`${key}-${String(init.seq)}`);
  const phase = await createPhase(store, { parentId: initId, title: 'phase' });
  return { phaseRef: `${key}-${String(phase.seq)}` };
}

/** Resolve a project's surrogate id by key over a fresh snapshot. */
async function pidOf(key: string): Promise<number> {
  return resolveProjectKeyInSet(deriveSet(await store.loadWorkingSet()), key);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mimir-seedverb-'));
  const vault = join(root, 'vault');
  await converge(vault, { allowCreate: true, exec: bunExec });
  client = new NornClient({ vaultPath: vault });
  store = createNornWriteStore(client, vault);
});

afterEach(async () => {
  await client.close();
  rmSync(root, { force: true, recursive: true });
});

describe.skipIf(!NORN)('seed verbs (intent)', () => {
  test('fileSeed creates a KEY-sN record; getSeed resolves it with its description', async () => {
    await seedbed();
    const seed = await fileSeed(store, {
      description: 'a rough idea',
      kind: 'bug',
      project: 'MMR',
      requester: null,
      title: 'flaky login',
    });
    expect(seed).toMatchObject({
      description: 'a rough idea',
      id: 'MMR-s1',
      kind: 'bug',
      lifecycle: 'new',
      project: 'MMR',
      readyToResolve: false,
      requester: null,
      spawned: [],
      title: 'flaky login',
    });
    const got = await getSeed(store, 'MMR-s1', { content: true });
    expect(got.title).toBe('flaky login');
    expect(got.description).toBe('a rough idea');
  });

  test('fileSeed refuses an unknown target project and an unknown requester', async () => {
    await seedbed();
    expect(
      await rejectMessage(() =>
        fileSeed(store, { kind: 'idea', project: 'NOPE', requester: null, title: 't' }),
      ),
    ).toMatch(/no project NOPE/);
    expect(
      await rejectMessage(() =>
        fileSeed(store, { kind: 'idea', project: 'MMR', requester: 'NOPE', title: 't' }),
      ),
    ).toMatch(/requester NOPE is not a known project/);
  });

  test('listSeeds defaults to live oldest-first; --status and --sort reach terminals', async () => {
    await seedbed();
    await fileSeed(store, { kind: 'idea', project: 'MMR', requester: null, title: 'first' });
    await fileSeed(store, { kind: 'bug', project: 'MMR', requester: null, title: 'second' });
    await fileSeed(store, { kind: 'feature', project: 'MMR', requester: null, title: 'third' });
    await transitionSeed(store, 'MMR-s3', 'rejected', 'nope');

    // Default: live only (s3 rejected is dropped), oldest-first.
    const live = await listSeeds(store, { project: 'MMR' });
    expect(live.map((s) => s.id)).toEqual(['MMR-s1', 'MMR-s2']);

    // Terminals reachable, newest-first.
    const all = await listSeeds(store, { project: 'MMR', sort: 'desc', status: 'all' });
    expect(all.map((s) => s.id)).toEqual(['MMR-s3', 'MMR-s2', 'MMR-s1']);
    const rejected = await listSeeds(store, { project: 'MMR', status: 'rejected' });
    expect(rejected.map((s) => s.id)).toEqual(['MMR-s3']);
  });

  test('promote (create) spawns a task, links it, and moves new → promoted; repeatable', async () => {
    const { phaseRef: parent } = await seedbed();
    await fileSeed(store, { kind: 'feature', project: 'MMR', requester: null, title: 's' });

    const first = await promoteSeed(store, 'MMR-s1', { parent, priority: 'p1' });
    const created1 = first.created ?? '';
    expect(created1).not.toBe('');
    expect(first.seed.lifecycle).toBe('promoted');
    expect(first.seed.spawned).toEqual([created1]);

    // Repeatable while promoted — a second germination appends a second link.
    const second = await promoteSeed(store, 'MMR-s1', { parent });
    const created2 = second.created ?? '';
    expect(second.seed.spawned).toEqual([created1, created2]);
    expect(second.seed.lifecycle).toBe('promoted');
  });

  test('promote --link records existing work without creating; --parent + --link conflict', async () => {
    const { phaseRef: parent } = await seedbed();
    const existing = await createTask(store, {
      parentId: await idOf(parent),
      title: 'existing',
    });
    const existingRef = `MMR-${String(existing.seq)}`;
    await fileSeed(store, { kind: 'bug', project: 'MMR', requester: null, title: 's' });

    const linked = await promoteSeed(store, 'MMR-s1', { link: existingRef });
    expect(linked.created).toBeUndefined();
    expect(linked.seed.spawned).toEqual([existingRef]);
    expect(linked.seed.lifecycle).toBe('promoted');

    expect(
      await rejectMessage(() => promoteSeed(store, 'MMR-s1', { link: existingRef, parent })),
    ).toMatch(/mutually exclusive|not both/);
  });

  test("ready-to-resolve: derived when a promoted seed's spawned work is all settled", async () => {
    const { phaseRef: parent } = await seedbed();
    await fileSeed(store, { kind: 'feature', project: 'MMR', requester: null, title: 's' });
    const first = await promoteSeed(store, 'MMR-s1', { parent });
    // Two spawned; one settled, one not → not yet ready.
    const second = await promoteSeed(store, 'MMR-s1', { parent });
    await completeTask(store, await idOf(first.created ?? ''));
    let seed = await getSeed(store, 'MMR-s1');
    expect(seed.readyToResolve).toBe(false);
    // Settle the second → all spawned settled → ready to resolve.
    await abandonTask(store, await idOf(second.created ?? ''), 'dropped');
    seed = await getSeed(store, 'MMR-s1');
    expect(seed.readyToResolve).toBe(true);
  });

  test('reject/resolve are terminal, reason required, and freeze the seed', async () => {
    await seedbed();
    await fileSeed(store, { kind: 'idea', project: 'MMR', requester: null, title: 's' });
    expect(await rejectMessage(() => transitionSeed(store, 'MMR-s1', 'resolved', '   '))).toMatch(
      /requires a reason/,
    );
    const resolved = await transitionSeed(store, 'MMR-s1', 'resolved', 'already fixed');
    expect(resolved.lifecycle).toBe('resolved');
    // Terminal → frozen: no further transition, no patch.
    expect(await rejectMessage(() => transitionSeed(store, 'MMR-s1', 'rejected', 'x'))).toMatch(
      /cannot move/,
    );
    expect(await rejectMessage(() => updateSeed(store, 'MMR-s1', { title: 'x' }))).toMatch(
      /frozen/,
    );
  });

  test('updateSeed patches a live seed title/kind/description', async () => {
    await seedbed();
    await fileSeed(store, {
      description: 'old',
      kind: 'idea',
      project: 'MMR',
      requester: null,
      title: 'x',
    });
    const patched = await updateSeed(store, 'MMR-s1', {
      description: 'new prose',
      kind: 'bug',
      title: 'renamed',
    });
    expect(patched).toMatchObject({ description: 'new prose', kind: 'bug', title: 'renamed' });
  });

  test('the resolving seam nulls an unknown requester and prunes a dangling spawned ref', async () => {
    // A hand-corrupt seed: requester names a missing project, spawned points at a
    // non-existent node. The verb read must null the requester and prune the ref —
    // exactly what the validator would drop.
    await seedbed();
    await client.newDoc({
      body: '## Seed Description\n\n\n## History\n## Annotations\n',
      confirm: true,
      field_json: [
        `type=${JSON.stringify('seed')}`,
        `title=${JSON.stringify('corrupt')}`,
        `project=${JSON.stringify('[[MMR]]')}`,
        `kind=${JSON.stringify('bug')}`,
        `lifecycle=${JSON.stringify('promoted')}`,
        `requester=${JSON.stringify('[[GHOST]]')}`,
        `spawned=${JSON.stringify(['[[MMR-999]]'])}`,
        `created=${JSON.stringify('2026-07-08T00:00:00.000Z')}`,
        `updated_at=${JSON.stringify('2026-07-08T00:00:00.000Z')}`,
      ],
      parents: true,
      path: 'MMR/seeds/MMR-s1.md',
    });
    const seed = await getSeed(store, 'MMR-s1');
    expect(seed.requester).toBeNull(); // unknown project → nulled on read
    expect(seed.spawned).toEqual([]); // dangling ref → pruned on read
    expect(seed.readyToResolve).toBe(false); // no surviving spawned work

    // The doctor validator still surfaces both for repair (one detector).
    const { dropped } = validate(await readVaultGraph(client));
    expect(dropped).toContainEqual({
      kind: 'field',
      rule: 'unknown-requester',
      stem: 'MMR-s1',
      value: 'GHOST',
    });
    expect(dropped).toContainEqual({
      kind: 'edge',
      ref: 'MMR-999',
      rule: 'dangling-spawned',
      stem: 'MMR-s1',
    });
  });
});

/** Resolve a node's surrogate id from its rendered `KEY-seq` over the module store. */
async function idOf(ref: string): Promise<number> {
  const node = findNodeInSet(deriveSet(await store.loadWorkingSet()), ref);
  if (node === undefined) {
    throw new Error(`no node ${ref}`);
  }
  return node.id;
}

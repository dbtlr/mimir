import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bunExec } from '../../exec';
import { converge } from '../../vault/converge';
import { deriveSet, findNodeInSet } from '../derive';
import {
  abandonTask,
  archiveProject,
  completeTask,
  createInitiative,
  createPhase,
  createProject,
  createTask,
  unarchiveProject,
} from '../index';
import { resolveProjectKeyInSet } from '../resolve-set';
import type { Store } from '../store';
import { readVaultGraph } from '../store-norn';
import { NornClient } from '../store-norn/client';
import { seedRawDoc } from '../store-norn/testing';
import { createNornWriteStore } from '../store-norn/writer';
import { validate } from '../validate';
import { fileSeed, getSeed, listSeeds, promoteSeed, transitionSeed, updateSeed } from './intent';
import { triage } from './triage';

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

async function rejectCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : 'missing-code';
  }
  throw new Error('expected a rejection, but the call resolved');
}

let root: string;
let vaultRoot: string;
let client: NornClient;
let store: Store;

/**
 * A phase (KEY-seq) under a fresh initiative — a valid `--parent` for promote.
 * Each child resolves its parent by the canonical `KEY-seq` stem.
 */
async function seedbed(key = 'MMR'): Promise<{ phaseRef: string }> {
  await createProject(store, { key, name: key });
  const projectId = await pidOf(key);
  const init = await createInitiative(store, { projectId, title: 'init' });
  const initId = await idOf(`${key}-${String(init.seq)}`);
  const phase = await createPhase(store, { parentId: initId, title: 'phase' });
  return { phaseRef: `${key}-${String(phase.seq)}` };
}

/** Resolve a project's canonical key over a fresh snapshot. */
async function pidOf(key: string): Promise<string> {
  return resolveProjectKeyInSet(deriveSet(await store.loadWorkingSet()), key);
}

type RpcCounts = { finds: number; wholeVaultFinds: number; gets: number };

/**
 * Instrument the norn client's read RPCs (MMR-251): total `vault.find`s, the
 * whole-vault subset (`type:project,task,phase,initiative` — the heavy load the
 * refactor scopes away), and `vault.get`s (point + section reads). Returns the
 * counts accumulated while `fn` runs, then restores the client.
 */
async function countRpcs(fn: () => Promise<unknown>): Promise<RpcCounts> {
  const counts: RpcCounts = { finds: 0, gets: 0, wholeVaultFinds: 0 };
  const find = client.find.bind(client);
  const get = client.get.bind(client);
  const sections = client.getSectionsResult.bind(client);
  client.find = (args) => {
    counts.finds += 1;
    if ((args.in ?? []).some((s) => s.includes('type:project,task,phase,initiative'))) {
      counts.wholeVaultFinds += 1;
    }
    return find(args);
  };
  client.get = (targets, col) => {
    counts.gets += 1;
    return get(targets, col);
  };
  client.getSectionsResult = (targets, secs, col) => {
    counts.gets += 1;
    return sections(targets, secs, col);
  };
  try {
    await fn();
  } finally {
    client.find = find;
    client.get = get;
    client.getSectionsResult = sections;
  }
  return counts;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mimir-seedverb-'));
  vaultRoot = join(root, 'vault');
  await converge(vaultRoot, { allowCreate: true, exec: bunExec });
  client = new NornClient({ vaultPath: vaultRoot });
  store = createNornWriteStore(client, vaultRoot);
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
    ).toMatch(/NOPE doesn't exist/);
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

  test('duplicate physical seed identities are absent from reads and refuse update', async () => {
    await seedbed();
    await fileSeed(store, {
      kind: 'idea',
      project: 'MMR',
      requester: null,
      title: 'canonical',
    });
    await seedRawDoc(
      client,
      vaultRoot,
      'relocated/MMR-s1.md',
      {
        created: '2026-07-13T00:00:00.000Z',
        kind: 'idea',
        lifecycle: 'new',
        project: '[[MMR]]',
        title: 'relocated',
        type: 'seed',
        updated_at: '2026-07-13T00:00:00.000Z',
      },
      '## Seed Description\n\nrelocated\n\n## History\n## Annotations\n',
    );

    expect(await listSeeds(store, { project: 'MMR' })).toEqual([]);
    expect(await rejectMessage(() => getSeed(store, 'MMR-s1'))).toMatch(/MMR-s1 doesn't exist/);
    expect(await rejectMessage(() => updateSeed(store, 'MMR-s1', { title: 'mutated' }))).toMatch(
      /MMR-s1 doesn't exist/,
    );
    expect(await store.seeds.load('MMR', 1)).toBeUndefined();
  });

  test('foreign-type, untyped, and parse-failed seed colliders hide valid owners', async () => {
    await seedbed();
    for (const title of ['one', 'two', 'three']) {
      await fileSeed(store, { kind: 'idea', project: 'MMR', requester: null, title });
    }
    await seedRawDoc(
      client,
      vaultRoot,
      'relocated/MMR-s1.md',
      { title: 'foreign', type: 'note' },
      'foreign physical owner',
    );
    await seedRawDoc(
      client,
      vaultRoot,
      'relocated/MMR-s2.md',
      { title: 'untyped' },
      'untyped physical owner',
    );
    mkdirSync(join(vaultRoot, 'relocated'), { recursive: true });
    writeFileSync(join(vaultRoot, 'relocated/MMR-s3.md'), '---\ntype: [broken\n---\n');

    expect(await listSeeds(store, { project: 'MMR' })).toEqual([]);
    for (const id of ['MMR-s1', 'MMR-s2', 'MMR-s3']) {
      expect(await rejectCode(() => getSeed(store, id))).toBe('not_found');
      expect(await rejectCode(() => updateSeed(store, id, { title: 'mutated' }))).toBe('not_found');
    }
  });

  test('{{seq}} allocation skips a parse-failed seed-shaped sibling by filename (MMR-196)', async () => {
    // The `{{seq}}` token resolves next-free against the literal `KEY-s` prefix
    // within `KEY/seeds/`, by filename — so an unparseable sibling still occupies
    // its number and the create does not reuse it. (A misplaced doc in ANOTHER
    // directory does NOT contaminate — that cross-directory duplicate is the
    // tolerant reader/doctor's territory, not the per-directory allocator's.)
    await seedbed();
    mkdirSync(join(vaultRoot, 'MMR/seeds'), { recursive: true });
    writeFileSync(join(vaultRoot, 'MMR/seeds/MMR-s1.md'), '---\ntype: [broken\n---\n');

    const created = await fileSeed(store, {
      kind: 'idea',
      project: 'MMR',
      requester: null,
      title: 'next',
    });
    expect(created.id).toBe('MMR-s2');
  });

  test('hidden or missing seed mutations use the same not_found code as get', async () => {
    await seedbed();
    expect(await rejectCode(() => getSeed(store, 'MMR-s99'))).toBe('not_found');
    expect(await rejectCode(() => updateSeed(store, 'MMR-s99', { title: 'x' }))).toBe('not_found');
    expect(await rejectCode(() => transitionSeed(store, 'MMR-s99', 'rejected', 'x'))).toBe(
      'not_found',
    );
  });

  test('listSeeds derives a bounded lede for live seeds in ONE section read (MMR-263)', async () => {
    await seedbed();
    const body = 'first body line\n\nmore prose that forms the lede preview';
    await fileSeed(store, {
      description: body,
      kind: 'idea',
      project: 'MMR',
      requester: null,
      title: 'has body',
    });
    await fileSeed(store, { kind: 'bug', project: 'MMR', requester: null, title: 'no body' });
    await fileSeed(store, { kind: 'feature', project: 'MMR', requester: null, title: 'to settle' });
    await transitionSeed(store, 'MMR-s3', 'rejected', 'nope');

    // Instrument the native section read: the whole live queue's descriptions must
    // ride ONE batched `vault.get { section }`, not a per-seed read.
    const original = client.getSectionsResult.bind(client);
    let sectionReads = 0;
    client.getSectionsResult = async (targets: string[], sections: string[]) => {
      sectionReads += 1;
      return original(targets, sections);
    };

    const live = await listSeeds(store, { project: 'MMR' });
    expect(sectionReads).toBe(1);
    const byId = new Map(live.map((s) => [s.id, s] as const));
    // The multi-line body flows into one bounded lede (newlines collapsed).
    expect(byId.get('MMR-s1')?.lede).toBe('first body line more prose that forms the lede preview');
    // A live seed with no body carries a null lede (derived, present, empty).
    expect(byId.get('MMR-s2')?.lede).toBeNull();

    // Settled seeds are excluded from the batch — the settled row carries no lede,
    // and the full body stays the detail read.
    const all = await listSeeds(store, { project: 'MMR', status: 'all' });
    expect(all.find((s) => s.id === 'MMR-s3')?.lede).toBeUndefined();
    const detail = await getSeed(store, 'MMR-s1', { content: true });
    expect(detail.description).toBe(body);
  });

  test('a rejected lede batch read degrades to lede-less rows, never aborts (MMR-263)', async () => {
    await seedbed();
    await fileSeed(store, {
      description: 'a body that would lede',
      kind: 'bug',
      project: 'MMR',
      requester: null,
      title: 'survives',
    });

    // Force a TRANSPORT-level failure of the batch section read (per-doc corruption
    // already degrades inside the store) — the queue must not die for a preview.
    const originalLoad = store.seeds.loadDescriptions;
    const originalError = console.error;
    const notes: string[] = [];
    console.error = (...args: unknown[]) => notes.push(args.map(String).join(' '));
    try {
      store.seeds.loadDescriptions = () => Promise.reject(new Error('norn transport down'));

      const live = await listSeeds(store, { project: 'MMR' });
      expect(live.map((s) => s.id)).toEqual(['MMR-s1']);
      expect(live[0]?.lede).toBeNull(); // degraded: row survives, preview dropped

      // The degradation is not silent — one stderr note per failed batch.
      expect(notes.some((n) => /seed description read failed/.test(n))).toBe(true);

      // The triage pass (reads through listSeeds) completes on the degraded read.
      const report = await triage(store, { board: 'MMR', dryRun: true });
      expect(report.untriaged.map((s) => s.id)).toEqual(['MMR-s1']);
    } finally {
      store.seeds.loadDescriptions = originalLoad;
      console.error = originalError;
    }
  });

  test('fileSeed splits the capture blob; --desc wins; the title cap errors (MMR-263)', async () => {
    await seedbed();
    // One blob: first line title, rest body.
    const split = await fileSeed(store, {
      kind: 'bug',
      project: 'MMR',
      requester: null,
      title: 'redirect loop on expiry\nrepro: expire the cookie, hit any authed route',
    });
    expect(split.title).toBe('redirect loop on expiry');
    const got = await getSeed(store, split.id, { content: true });
    expect(got.description).toBe('repro: expire the cookie, hit any authed route');

    // An explicit description wins over the blob's split body.
    const explicit = await fileSeed(store, {
      description: 'explicit body wins',
      kind: 'idea',
      project: 'MMR',
      requester: null,
      title: 'title line\nsplit body loses',
    });
    expect((await getSeed(store, explicit.id, { content: true })).description).toBe(
      'explicit body wins',
    );

    // An over-cap first line errors with copy that teaches the split.
    expect(
      await rejectMessage(() =>
        fileSeed(store, {
          kind: 'idea',
          project: 'MMR',
          requester: null,
          title: 'x'.repeat(121),
        }),
      ),
    ).toMatch(/first line is the title/);
  });

  test('update --title inherits the seed title cap and single-line rule (MMR-263)', async () => {
    await seedbed();
    await fileSeed(store, { kind: 'idea', project: 'MMR', requester: null, title: 'short' });
    expect(
      await rejectMessage(() => updateSeed(store, 'MMR-s1', { title: 'y'.repeat(121) })),
    ).toMatch(/cap is 120/);
    // An embedded newline is refused — update takes the raw value (no blob split),
    // so a multi-line title would defeat the forcing function.
    expect(
      await rejectMessage(() => updateSeed(store, 'MMR-s1', { title: 'line one\nline two' })),
    ).toMatch(/one line/);
    // A title at the cap still patches.
    const ok = await updateSeed(store, 'MMR-s1', { title: 'z'.repeat(120) });
    expect(ok.title).toBe('z'.repeat(120));
  });

  test('promote (create) spawns a task, links it, and moves new → promoted; repeatable', async () => {
    const { phaseRef: parent } = await seedbed();
    await fileSeed(store, { kind: 'feature', project: 'MMR', requester: null, title: 's' });

    const first = await promoteSeed(store, 'MMR-s1', { parent, priority: 'p1' });
    const created1 = first.created ?? '';
    expect(created1).not.toBe('');
    expect(first.seed.lifecycle).toBe('promoted');
    expect(first.seed.spawned).toEqual([created1]);
    // spawnedId (MMR-259) is the composer-facing id — the spawned task, matching
    // `created` in create mode.
    expect(first.spawnedId).toBe(created1);

    // Repeatable while promoted — a second germination appends a second link.
    const second = await promoteSeed(store, 'MMR-s1', { parent });
    const created2 = second.created ?? '';
    expect(second.seed.spawned).toEqual([created1, created2]);
    expect(second.seed.lifecycle).toBe('promoted');
    expect(second.spawnedId).toBe(created2);
    expect(second.spawnedId).not.toBe(first.spawnedId);
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
    // spawnedId (MMR-259) is the linked id in link mode, even though `created`
    // (create-mode-only) stays undefined.
    expect(linked.spawnedId).toBe(existingRef);

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

  test('an archived board refuses seed mutations — nothing written, no task created (B1a)', async () => {
    const { phaseRef: parent } = await seedbed();
    await fileSeed(store, { kind: 'feature', project: 'MMR', requester: null, title: 's' });
    const before = deriveSet(await store.loadWorkingSet());
    const tasksBefore = before.ws.nodes.filter((n) => n.type === 'task').length;
    await archiveProject(store, await pidOf('MMR'), 'shelved');

    expect(await rejectMessage(() => transitionSeed(store, 'MMR-s1', 'rejected', 'x'))).toMatch(
      /archived/,
    );
    expect(await rejectMessage(() => updateSeed(store, 'MMR-s1', { title: 'x' }))).toMatch(
      /archived/,
    );
    expect(await rejectMessage(() => promoteSeed(store, 'MMR-s1', { parent }))).toMatch(/archived/);

    // Nothing written: the seed record is untouched, and no orphan task was created.
    const rec = await store.seeds.load('MMR', 1);
    expect(rec?.lifecycle).toBe('new');
    expect(rec?.spawned).toEqual([]);
    const after = deriveSet(await store.loadWorkingSet());
    expect(after.ws.nodes.filter((n) => n.type === 'task').length).toBe(tasksBefore);
  });

  test('spawned in a since-archived board is hidden but settled for readiness (B1b/c)', async () => {
    await seedbed('MMR');
    const { phaseRef: othParent } = await seedbed('OTH');
    await fileSeed(store, { kind: 'feature', project: 'MMR', requester: null, title: 's' });
    // Spawn the work into OTH — a DIFFERENT board than the seed's own (MMR).
    const promoted = await promoteSeed(store, 'MMR-s1', { parent: othParent });
    const spawnedId = promoted.created ?? '';
    expect(spawnedId).not.toBe('');
    let seed = await getSeed(store, 'MMR-s1');
    expect(seed.spawned).toEqual([spawnedId]);
    expect(seed.readyToResolve).toBe(false); // live spawned work → not ready

    // Archive OTH: the spawned ref reads as absent (hidden from the facet), but
    // counts settled — so readyToResolve flips true, the attention signal surviving.
    await archiveProject(store, await pidOf('OTH'), 'shelved');
    seed = await getSeed(store, 'MMR-s1');
    expect(seed.spawned).toEqual([]); // (c) archived-board ref hidden from display
    expect(seed.readyToResolve).toBe(true); // (b) archived spawned is settled

    // Reverts on unarchive.
    await unarchiveProject(store, await pidOf('OTH'));
    seed = await getSeed(store, 'MMR-s1');
    expect(seed.spawned).toEqual([spawnedId]);
    expect(seed.readyToResolve).toBe(false);
  });

  test('promote is idempotent — a repeated --link is a no-op (B2)', async () => {
    const { phaseRef: parent } = await seedbed();
    const existing = await createTask(store, { parentId: await idOf(parent), title: 'existing' });
    const existingRef = `MMR-${String(existing.seq)}`;
    await fileSeed(store, { kind: 'bug', project: 'MMR', requester: null, title: 's' });
    const first = await promoteSeed(store, 'MMR-s1', { link: existingRef });
    expect(first.seed.spawned).toEqual([existingRef]);
    expect(first.seed.lifecycle).toBe('promoted');
    // Re-run the same link: no duplicate ref, still one spawned, still promoted.
    const again = await promoteSeed(store, 'MMR-s1', { link: existingRef });
    expect(again.seed.spawned).toEqual([existingRef]);
    expect(again.seed.lifecycle).toBe('promoted');
  });

  test('queue tiebreak on equal created_at orders by numeric seq, not lexical id (B6)', async () => {
    await seedbed();
    const at = '2026-07-08T00:00:00.000Z';
    // Two same-timestamp seeds whose seqs sort differently lexically vs numerically.
    for (const seq of [2, 10]) {
      await seedRawDoc(
        client,
        vaultRoot,
        `MMR/seeds/MMR-s${String(seq)}.md`,
        {
          created: at,
          kind: 'idea',
          lifecycle: 'new',
          project: '[[MMR]]',
          title: `s${String(seq)}`,
          type: 'seed',
          updated_at: at,
        },
        '## Seed Description\n\n\n## History\n## Annotations\n',
      );
    }
    const live = await listSeeds(store, { project: 'MMR' });
    expect(live.map((s) => s.id)).toEqual(['MMR-s2', 'MMR-s10']);
  });

  test('an archived requester is nulled on read; doctor warns rather than under-reports (B1d)', async () => {
    await seedbed('MMR');
    await seedbed('REQ');
    await fileSeed(store, { kind: 'bug', project: 'MMR', requester: 'REQ', title: 's' });
    let seed = await getSeed(store, 'MMR-s1');
    expect(seed.requester).toBe('REQ');

    await archiveProject(store, await pidOf('REQ'), 'shelved');
    seed = await getSeed(store, 'MMR-s1');
    expect(seed.requester).toBeNull(); // active-only visibility: archived → nulled on read

    // Doctor must surface this as a distinct WARN — before B1d it read as a known
    // project and reported nothing, a silent under-report of a value the reader nulls.
    const { dropped } = validate(await readVaultGraph(client));
    expect(dropped).toContainEqual({
      kind: 'field',
      rule: 'archived-requester',
      stem: 'MMR-s1',
      value: 'REQ',
    });
    expect(dropped).not.toContainEqual(
      expect.objectContaining({ rule: 'unknown-requester', stem: 'MMR-s1' }),
    );
  });

  test('the resolving seam nulls an unknown requester and prunes a dangling spawned ref', async () => {
    // A hand-corrupt seed: requester names a missing project, spawned points at a
    // non-existent node. The verb read must null the requester and prune the ref —
    // exactly what the validator would drop.
    await seedbed();
    await seedRawDoc(
      client,
      vaultRoot,
      'MMR/seeds/MMR-s1.md',
      {
        created: '2026-07-08T00:00:00.000Z',
        kind: 'bug',
        lifecycle: 'promoted',
        project: '[[MMR]]',
        requester: '[[GHOST]]',
        spawned: ['[[MMR-999]]'],
        title: 'corrupt',
        type: 'seed',
        updated_at: '2026-07-08T00:00:00.000Z',
      },
      '## Seed Description\n\n\n## History\n## Annotations\n',
    );
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

  test('a spawned target whose project has no doc prunes identically in the scoped and whole-vault reads (MMR-251)', async () => {
    // Parity for the missing-project corruption class: a spawned WORK NODE whose owning
    // project has NO project document is dropped by the validator (missing-project) on
    // the whole-vault path — listSeeds prunes the ref. The scoped single-seed read
    // (getSeed/echo) must prune it identically, deriving presence from the VALIDATED
    // projects read rather than trusting the target's requested key.
    await seedbed();
    // Build a real project + a work node in it (so norn indexes the directory), then
    // delete the project document — leaving the node orphaned (its container is missing),
    // the exact missing-project corruption the whole-vault validator drops.
    await createProject(store, { key: 'ORPH', name: 'ORPH' });
    const orphanPid = await pidOf('ORPH');
    const orphanInit = await createInitiative(store, { projectId: orphanPid, title: 'orphan' });
    const orphanStem = `ORPH-${String(orphanInit.seq)}`;
    rmSync(join(vaultRoot, 'ORPH', 'ORPH.md'), { force: true });

    // A promoted MMR seed that spawned that now-orphaned node.
    await seedRawDoc(
      client,
      vaultRoot,
      'MMR/seeds/MMR-s1.md',
      {
        created: '2026-07-08T00:00:00.000Z',
        kind: 'bug',
        lifecycle: 'promoted',
        project: '[[MMR]]',
        spawned: [`[[${orphanStem}]]`],
        title: 'spawns orphan',
        type: 'seed',
        updated_at: '2026-07-08T00:00:00.000Z',
      },
      '## Seed Description\n\n\n## History\n## Annotations\n',
    );

    // Whole-vault path: the validator drops the orphan-project node, so listSeeds prunes.
    const listed = (await listSeeds(store, { project: 'MMR' })).find((v) => v.id === 'MMR-s1');
    expect(listed?.spawned).toEqual([]);

    // Scoped path: getSeed must prune the SAME ref (before the fix it survived, because
    // the scoped read trusted the target's project as present and loaded the node).
    const got = await getSeed(store, 'MMR-s1');
    expect(got.spawned).toEqual([]);
    expect(got.readyToResolve).toBe(false);

    // The doctor validator reports the orphan node (one detector) — the whole-vault
    // drop the scoped path now mirrors.
    const { dropped } = validate(await readVaultGraph(client));
    expect(dropped).toContainEqual({
      key: 'ORPH',
      kind: 'node',
      rule: 'missing-project',
      stem: orphanStem,
    });
  });

  test('a write against a seed whose board has no project doc refuses (MMR-251)', async () => {
    // The write-side half of missing-project parity: an orphan seed's FILE still
    // point-reads fine, so without the board-active guard rejecting an absent
    // project, a mutation would write into a board every read path treats as
    // unknown (and promotion could spawn work there).
    await seedbed();
    await createProject(store, { key: 'ORPH', name: 'ORPH' });
    await fileSeed(store, {
      description: null,
      kind: 'idea',
      project: 'ORPH',
      requester: null,
      title: 'orphan-board seed',
    });
    rmSync(join(vaultRoot, 'ORPH', 'ORPH.md'), { force: true });

    expect(
      await rejectMessage(() => transitionSeed(store, 'ORPH-s1', 'rejected', 'no board')),
    ).toMatch(/ORPH/);
    expect(
      await rejectMessage(() => updateSeed(store, 'ORPH-s1', { title: 'still orphaned' })),
    ).toMatch(/ORPH/);
  });

  test('the create echo normalizes description to the read-back semantics (MMR-251)', async () => {
    await seedbed();
    // A padded/blank-framed description: the echo must equal what a subsequent load
    // returns (parseDescriptionSection trims + blanks → null), not the raw input.
    const filed = await fileSeed(store, {
      description: '  padded \n',
      kind: 'idea',
      project: 'MMR',
      requester: null,
      title: 'has description',
    });
    const loaded = await getSeed(store, filed.id, { content: true });
    expect(filed.description).toBe('padded');
    expect(filed.description).toBe(loaded.description);

    // A blank-after-trim description normalizes to null on the echo, matching the load.
    const blank = await fileSeed(store, {
      description: '   \n',
      kind: 'idea',
      project: 'MMR',
      requester: null,
      title: 'blank description',
    });
    const blankLoaded = await getSeed(store, blank.id, { content: true });
    expect(blank.description).toBeNull();
    expect(blank.description).toBe(blankLoaded.description);
  });

  test('the single-seed echoes never pay a whole-vault load (MMR-251)', async () => {
    const { phaseRef: parent } = await seedbed();
    await fileSeed(store, { kind: 'idea', project: 'MMR', requester: null, title: 'newseed' });
    await fileSeed(store, { kind: 'feature', project: 'MMR', requester: null, title: 'topromote' });

    // fileSeed: ONE projects find, and NO read-back get of the seed it just wrote
    // (the held record echoes it) — down from a whole-vault find + a re-load get (D5).
    const fileC = await countRpcs(() =>
      fileSeed(store, { kind: 'bug', project: 'MMR', requester: null, title: 'held' }),
    );
    expect(fileC).toEqual({ finds: 1, gets: 0, wholeVaultFinds: 0 });

    // getSeed of a new (spawn-less) seed: ONE projects find (not whole-vault) + the
    // record get; the scoped read loads no nodes.
    const getC = await countRpcs(() => getSeed(store, 'MMR-s1', { content: true }));
    expect(getC).toEqual({ finds: 1, gets: 1, wholeVaultFinds: 0 });

    // reject of a spawn-less seed: 1 projects find + 2 gets (transition load-doc +
    // echo record) = 3 RPCs — beats the 4-RPC baseline; ZERO whole-vault finds
    // (was two: the guard's and the echo's).
    const rejectNew = await countRpcs(() => transitionSeed(store, 'MMR-s1', 'rejected', 'nope'));
    expect(rejectNew).toEqual({ finds: 1, gets: 2, wholeVaultFinds: 0 });

    // promote (create): the ECHO reuses the mid-promote load — it adds ZERO whole-vault
    // finds (D2). Exact per-category so a regression is diagnosable and an offsetting
    // swap (the echo regaining a whole-vault load while createTask sheds one) can't hide.
    //   wholeVaultFinds: 2 = the mid-promote resolve + createTask's transaction snapshot.
    //   finds: 3 = those 2 whole-vault finds + createTask's internal create-verify find.
    //   gets: 4 = the initial content load (rec) + createTask's verify body get +
    //             germinate's load-doc + the post-germinate echo re-read.
    const promoteC = await countRpcs(() => promoteSeed(store, 'MMR-s2', { parent }));
    expect(promoteC).toEqual({ finds: 3, gets: 4, wholeVaultFinds: 2 });

    // resolve of a PROMOTED seed (spawned work to settle/prune): ZERO whole-vault finds —
    // the echo loads only the spawned target's project (scoped). Exact per-category,
    // replacing the loose `<= 4` bound so an added whole-vault load or an extra read
    // can't slip under it.
    //   finds: 2 = the board-active/echo projects read + the one scoped node find.
    //   gets: 2 = the transition's load-doc + the echo's content load.
    const resolvePromoted = await countRpcs(() =>
      transitionSeed(store, 'MMR-s2', 'resolved', 'done'),
    );
    expect(resolvePromoted).toEqual({ finds: 2, gets: 2, wholeVaultFinds: 0 });
  });

  test('listSeeds + triage share ONE whole-vault load (MMR-251/D4)', async () => {
    await seedbed();
    await fileSeed(store, { kind: 'bug', project: 'MMR', requester: null, title: 'live1' });

    // GET /api/seeds?project=KEY shape: the whole-vault resolver + the type:seed
    // listing = 2 finds (the baseline), one of them whole-vault.
    const listC = await countRpcs(() => listSeeds(store, { project: 'MMR' }));
    expect(listC.finds).toBe(2);
    expect(listC.wholeVaultFinds).toBe(1);

    // triage reuses listSeeds' set for its own board-task check, so the pass derives
    // ONE whole-vault load (folded from two) — 2 finds total, down from three.
    const triageC = await countRpcs(() => triage(store, { board: 'MMR', dryRun: true }));
    expect(triageC.finds).toBe(2);
    expect(triageC.wholeVaultFinds).toBe(1);
  });
});

/** Resolve a node's canonical stem from its rendered `KEY-seq` over the module store. */
async function idOf(ref: string): Promise<string> {
  const node = findNodeInSet(deriveSet(await store.loadWorkingSet()), ref);
  if (node === undefined) {
    throw new Error(`no node ${ref}`);
  }
  return node.id;
}

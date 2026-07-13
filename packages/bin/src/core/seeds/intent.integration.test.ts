import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bunExec } from '../../exec';
import { NornClient } from '../../norn/client';
import { createNornWriteStore } from '../../norn/writer';
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

  test('duplicate physical seed identities are absent from reads and refuse update', async () => {
    await seedbed();
    await fileSeed(store, {
      kind: 'idea',
      project: 'MMR',
      requester: null,
      title: 'canonical',
    });
    await client.newDoc({
      body: '## Seed Description\n\nrelocated\n\n## History\n## Annotations\n',
      confirm: true,
      field_json: [
        `type=${JSON.stringify('seed')}`,
        `title=${JSON.stringify('relocated')}`,
        `project=${JSON.stringify('[[MMR]]')}`,
        `kind=${JSON.stringify('idea')}`,
        `lifecycle=${JSON.stringify('new')}`,
        `created=${JSON.stringify('2026-07-13T00:00:00.000Z')}`,
        `updated_at=${JSON.stringify('2026-07-13T00:00:00.000Z')}`,
      ],
      parents: true,
      path: 'relocated/MMR-s1.md',
    });

    expect(await listSeeds(store, { project: 'MMR' })).toEqual([]);
    expect(await rejectMessage(() => getSeed(store, 'MMR-s1'))).toMatch(/no seed MMR-s1/);
    expect(await rejectMessage(() => updateSeed(store, 'MMR-s1', { title: 'mutated' }))).toMatch(
      /no seed MMR-s1/,
    );
    expect(await store.seeds.load('MMR', 1)).toBeUndefined();
  });

  test('foreign-type, untyped, and parse-failed seed colliders hide valid owners', async () => {
    await seedbed();
    for (const title of ['one', 'two', 'three']) {
      await fileSeed(store, { kind: 'idea', project: 'MMR', requester: null, title });
    }
    await client.newDoc({
      body: 'foreign physical owner',
      confirm: true,
      field_json: [`type=${JSON.stringify('note')}`, `title=${JSON.stringify('foreign')}`],
      parents: true,
      path: 'relocated/MMR-s1.md',
    });
    await client.newDoc({
      body: 'untyped physical owner',
      confirm: true,
      field_json: [`title=${JSON.stringify('untyped')}`],
      parents: true,
      path: 'relocated/MMR-s2.md',
    });
    mkdirSync(join(vaultRoot, 'relocated'), { recursive: true });
    writeFileSync(join(vaultRoot, 'relocated/MMR-s3.md'), '---\ntype: [broken\n---\n');

    expect(await listSeeds(store, { project: 'MMR' })).toEqual([]);
    for (const id of ['MMR-s1', 'MMR-s2', 'MMR-s3']) {
      expect(await rejectCode(() => getSeed(store, id))).toBe('not_found');
      expect(await rejectCode(() => updateSeed(store, id, { title: 'mutated' }))).toBe('not_found');
    }
  });

  test('allocation counts parse-failed physical seed identities by stem', async () => {
    await seedbed();
    mkdirSync(join(vaultRoot, 'relocated'), { recursive: true });
    writeFileSync(join(vaultRoot, 'relocated/MMR-s1.md'), '---\ntype: [broken\n---\n');

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
      await client.newDoc({
        body: '## Seed Description\n\n\n## History\n## Annotations\n',
        confirm: true,
        field_json: [
          `type=${JSON.stringify('seed')}`,
          `title=${JSON.stringify(`s${String(seq)}`)}`,
          `project=${JSON.stringify('[[MMR]]')}`,
          `kind=${JSON.stringify('idea')}`,
          `lifecycle=${JSON.stringify('new')}`,
          `created=${JSON.stringify(at)}`,
          `updated_at=${JSON.stringify(at)}`,
        ],
        parents: true,
        path: `MMR/seeds/MMR-s${String(seq)}.md`,
      });
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

/** Resolve a node's canonical stem from its rendered `KEY-seq` over the module store. */
async function idOf(ref: string): Promise<string> {
  const node = findNodeInSet(deriveSet(await store.loadWorkingSet()), ref);
  if (node === undefined) {
    throw new Error(`no node ${ref}`);
  }
  return node.id;
}

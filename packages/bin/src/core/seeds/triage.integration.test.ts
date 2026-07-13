import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bunExec } from '../../exec';
import { NornClient } from '../../norn/client';
import { createNornWriteStore } from '../../norn/writer';
import { converge } from '../../vault/converge';
import { deriveSet, findNodeInSet } from '../derive';
import {
  blockTask,
  completeTask,
  createInitiative,
  createPhase,
  createProject,
  createTask,
} from '../index';
import { resolveProjectKeyInSet } from '../resolve-set';
import type { Store } from '../store';
import { fileSeed, promoteSeed, transitionSeed } from './intent';
import { triage } from './triage';

/**
 * The triage pass (MMR-246) against a real converged vault — the three checks,
 * idempotency, --dry-run, cross-board upstream resolution, and the blocked-task
 * unblock suggestion. Needs a `norn` binary; skipped when off PATH.
 */
const NORN = Bun.which('norn') !== null;

let root: string;
let client: NornClient;
let store: Store;

/** A phase (KEY-seq) under a fresh initiative — a valid `--parent` for promote,
 * and a container for the requester-side tasks that carry `upstream`. */
async function seedbed(key = 'MMR'): Promise<{ phaseRef: string }> {
  await createProject(store, { key, name: key });
  const projectId = await pidOf(key);
  const init = await createInitiative(store, { projectId, title: 'init' });
  const initId = await idOf(`${key}-${String(init.seq)}`);
  const phase = await createPhase(store, { parentId: initId, title: 'phase' });
  return { phaseRef: `${key}-${String(phase.seq)}` };
}

async function pidOf(key: string): Promise<string> {
  return resolveProjectKeyInSet(deriveSet(await store.loadWorkingSet()), key);
}

async function idOf(ref: string): Promise<string> {
  const node = findNodeInSet(deriveSet(await store.loadWorkingSet()), ref);
  if (node === undefined) {
    throw new Error(`no node ${ref}`);
  }
  return node.id;
}

/** Read a task's `## Annotations` note contents, over a fresh snapshot. */
async function annotationsOf(ref: string): Promise<string[]> {
  const notes = await store.bodySections.readAnnotations(ref);
  return notes.map((n) => n.content);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mimir-triage-'));
  const vault = join(root, 'vault');
  await converge(vault, { allowCreate: true, exec: bunExec });
  client = new NornClient({ vaultPath: vault });
  store = createNornWriteStore(client, vault);
});

afterEach(async () => {
  await client.close();
  rmSync(root, { force: true, recursive: true });
});

describe.skipIf(!NORN)('triage pass', () => {
  test('(a) surfaces new/untriaged seeds and (b) flags ready-to-resolve', async () => {
    const { phaseRef } = await seedbed();
    // Two untriaged (new) seeds.
    await fileSeed(store, { kind: 'idea', project: 'MMR', requester: null, title: 'rough idea' });
    await fileSeed(store, { kind: 'bug', project: 'MMR', requester: null, title: 'flaky test' });
    // A promoted seed whose only spawned task is settled → ready to resolve.
    await fileSeed(store, { kind: 'feature', project: 'MMR', requester: null, title: 'shipit' });
    const promoted = await promoteSeed(store, 'MMR-s3', { parent: phaseRef });
    await completeTask(store, await idOf(promoted.created ?? ''));
    // A promoted seed whose spawned task is NOT settled → neither untriaged nor ready.
    await fileSeed(store, { kind: 'feature', project: 'MMR', requester: null, title: 'inflight' });
    await promoteSeed(store, 'MMR-s4', { parent: phaseRef });

    const report = await triage(store, { board: 'MMR' });
    expect(report.untriaged.map((s) => s.id)).toEqual(['MMR-s1', 'MMR-s2']);
    expect(report.readyToResolve.map((s) => s.id)).toEqual(['MMR-s3']);
    // Triage NEVER auto-closes — the ready seed stays promoted.
    expect(report.readyToResolve[0]?.lifecycle).toBe('promoted');
  });

  test('(c) annotates a task whose upstream seed went terminal, pulling the reason', async () => {
    const { phaseRef } = await seedbed();
    await fileSeed(store, { kind: 'bug', project: 'MMR', requester: null, title: 'the ask' });
    // A requester-side task pointing at the seed.
    const task = await createTask(store, {
      parentId: await idOf(phaseRef),
      title: 'answers the ask',
      upstream: 'MMR-s1',
    });
    const taskRef = `MMR-${String(task.seq)}`;
    // The seed goes terminal with a reason.
    await transitionSeed(store, 'MMR-s1', 'resolved', 'shipped in MMR-9');

    const report = await triage(store, { board: 'MMR' });
    expect(report.upstreamResolutions).toHaveLength(1);
    expect(report.upstreamResolutions[0]).toMatchObject({
      alreadyRecorded: false,
      annotated: true,
      blocked: false,
      lifecycle: 'resolved',
      reason: 'shipped in MMR-9',
      task: taskRef,
      upstream: 'MMR-s1',
    });
    // The annotation landed on the task, pulling the reason from the seed's History.
    expect(await annotationsOf(taskRef)).toContain('upstream MMR-s1 resolved: shipped in MMR-9');
  });

  test('a live (non-terminal) upstream seed is not annotated', async () => {
    const { phaseRef } = await seedbed();
    await fileSeed(store, { kind: 'bug', project: 'MMR', requester: null, title: 'the ask' });
    const task = await createTask(store, {
      parentId: await idOf(phaseRef),
      title: 't',
      upstream: 'MMR-s1',
    });
    const report = await triage(store, { board: 'MMR' });
    expect(report.upstreamResolutions).toHaveLength(0);
    expect(await annotationsOf(`MMR-${String(task.seq)}`)).toHaveLength(0);
  });

  test('idempotent: a second run recognizes its own annotation and is a no-op', async () => {
    const { phaseRef } = await seedbed();
    await fileSeed(store, { kind: 'bug', project: 'MMR', requester: null, title: 'ask' });
    const task = await createTask(store, {
      parentId: await idOf(phaseRef),
      title: 't',
      upstream: 'MMR-s1',
    });
    const taskRef = `MMR-${String(task.seq)}`;
    await transitionSeed(store, 'MMR-s1', 'rejected', 'out of scope');

    const first = await triage(store, { board: 'MMR' });
    expect(first.upstreamResolutions[0]).toMatchObject({ alreadyRecorded: false, annotated: true });
    expect(first.failures).toHaveLength(0);
    expect(await annotationsOf(taskRef)).toHaveLength(1);

    const second = await triage(store, { board: 'MMR' });
    expect(second.upstreamResolutions[0]).toMatchObject({
      alreadyRecorded: true,
      annotated: false,
    });
    // A healthy re-run stays no-op-clean — no duplicate annotation, no failures.
    expect(second.failures).toHaveLength(0);
    expect(await annotationsOf(taskRef)).toHaveLength(1);
  });

  test('--dry-run reports what WOULD be annotated but writes nothing', async () => {
    const { phaseRef } = await seedbed();
    await fileSeed(store, { kind: 'bug', project: 'MMR', requester: null, title: 'ask' });
    const task = await createTask(store, {
      parentId: await idOf(phaseRef),
      title: 't',
      upstream: 'MMR-s1',
    });
    const taskRef = `MMR-${String(task.seq)}`;
    await transitionSeed(store, 'MMR-s1', 'resolved', 'done');

    const report = await triage(store, { board: 'MMR', dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.upstreamResolutions[0]).toMatchObject({
      alreadyRecorded: false,
      annotated: false,
    });
    // Nothing was written.
    expect(await annotationsOf(taskRef)).toHaveLength(0);
    // A subsequent real run still annotates (dry-run left no trace).
    await triage(store, { board: 'MMR' });
    expect(await annotationsOf(taskRef)).toContain('upstream MMR-s1 resolved: done');
  });

  test('cross-board: a task resolves an upstream seed on ANOTHER board', async () => {
    const { phaseRef } = await seedbed('MMR');
    await seedbed('NRN');
    // The seed lives on NRN; MMR requested it and now answers it.
    await fileSeed(store, {
      kind: 'feature',
      project: 'NRN',
      requester: 'MMR',
      title: 'capability',
    });
    const task = await createTask(store, {
      parentId: await idOf(phaseRef),
      title: 'MMR-side work',
      upstream: 'NRN-s1',
    });
    const taskRef = `MMR-${String(task.seq)}`;
    await transitionSeed(store, 'NRN-s1', 'resolved', 'landed');

    // Triaging MMR reconciles MMR's OWN tasks against the cross-board seed.
    const report = await triage(store, { board: 'MMR' });
    expect(report.upstreamResolutions[0]).toMatchObject({
      annotated: true,
      reason: 'landed',
      task: taskRef,
      upstream: 'NRN-s1',
    });
    expect(await annotationsOf(taskRef)).toContain('upstream NRN-s1 resolved: landed');
  });

  test('a blocked task is flagged for an unblock suggestion (never transitioned)', async () => {
    const { phaseRef } = await seedbed();
    await fileSeed(store, { kind: 'bug', project: 'MMR', requester: null, title: 'ask' });
    const task = await createTask(store, {
      parentId: await idOf(phaseRef),
      title: 't',
      upstream: 'MMR-s1',
    });
    const taskRef = `MMR-${String(task.seq)}`;
    await blockTask(store, await idOf(taskRef), 'waiting on the seed');
    await transitionSeed(store, 'MMR-s1', 'resolved', 'unblocked now');

    const report = await triage(store, { board: 'MMR' });
    expect(report.upstreamResolutions[0]).toMatchObject({ annotated: true, blocked: true });
    // Triage suggests, never transitions — the task is still blocked afterward.
    const stillBlocked = findNodeInSet(deriveSet(await store.loadWorkingSet()), taskRef);
    expect(stillBlocked?.hold).toBe('blocked');
  });

  test('a settled (done) requester task is left untouched — no re-activation', async () => {
    const { phaseRef } = await seedbed();
    await fileSeed(store, { kind: 'bug', project: 'MMR', requester: null, title: 'ask' });
    const task = await createTask(store, {
      parentId: await idOf(phaseRef),
      title: 't',
      upstream: 'MMR-s1',
    });
    const taskRef = `MMR-${String(task.seq)}`;
    // The requester task is already DONE; only then does the upstream go terminal.
    await completeTask(store, await idOf(taskRef));
    await transitionSeed(store, 'MMR-s1', 'resolved', 'shipped');
    const before = findNodeInSet(deriveSet(await store.loadWorkingSet()), taskRef);

    const report = await triage(store, { board: 'MMR' });

    // A settled task is out of check (c): no annotation, no `stamp()` bump that would
    // re-activate its lastActivity recency on settled work (attention rollups).
    expect(report.upstreamResolutions).toHaveLength(0);
    expect(await annotationsOf(taskRef)).toHaveLength(0);
    const after = findNodeInSet(deriveSet(await store.loadWorkingSet()), taskRef);
    expect(after?.updated_at).toBe(before?.updated_at);
  });

  test('an unknown board is refused (self-contained per active board)', async () => {
    await seedbed();
    let message = '';
    try {
      await triage(store, { board: 'NOPE' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/no project NOPE/);
  });

  test('a corrupt ## Annotations anchor is quarantined into failures[] — the pass never aborts', async () => {
    const { phaseRef } = await seedbed();
    await fileSeed(store, { kind: 'bug', project: 'MMR', requester: null, title: 'ask1' });
    await fileSeed(store, { kind: 'bug', project: 'MMR', requester: null, title: 'ask2' });
    const bad = await createTask(store, {
      parentId: await idOf(phaseRef),
      title: 'bad',
      upstream: 'MMR-s1',
    });
    const good = await createTask(store, {
      parentId: await idOf(phaseRef),
      title: 'good',
      upstream: 'MMR-s2',
    });
    const badRef = `MMR-${String(bad.seq)}`;
    const goodRef = `MMR-${String(good.seq)}`;
    await transitionSeed(store, 'MMR-s1', 'resolved', 'shipped');
    await transitionSeed(store, 'MMR-s2', 'resolved', 'shipped too');
    // Corrupt the bad task's anchor: a duplicate `## Annotations` heading → norn
    // can't resolve it (ambiguous), so an append would refuse (the old abort).
    const badPath = join(root, 'vault', 'MMR', `${badRef}.md`);
    appendFileSync(badPath, '\n## Annotations\n');

    const report = await triage(store, { board: 'MMR' });

    // The corrupt task is quarantined (→ doctor), not annotated; nothing was written.
    expect(report.failures.map((f) => f.task)).toContain(badRef);
    expect(report.failures.find((f) => f.task === badRef)?.message).toMatch(/doctor/);
    expect(readFileSync(badPath, 'utf8')).not.toContain('upstream MMR-s1 resolved');
    // The healthy task alongside it is still reconciled — one bad task never aborts.
    expect(report.upstreamResolutions.map((r) => r.task)).toEqual([goodRef]);
    expect(await annotationsOf(goodRef)).toContain('upstream MMR-s2 resolved: shipped too');
  });

  test('a corrupt anchor on a task with a LIVE (non-terminal) upstream is NOT quarantined — nothing to reconcile', async () => {
    const { phaseRef } = await seedbed();
    await fileSeed(store, { kind: 'bug', project: 'MMR', requester: null, title: 'ask1' });
    const task = await createTask(store, {
      parentId: await idOf(phaseRef),
      title: 'still waiting',
      upstream: 'MMR-s1',
    });
    const taskRef = `MMR-${String(task.seq)}`;
    // Corrupt the anchor, but the upstream seed never goes terminal — no annotation
    // would ever be written for this task, so the corruption is irrelevant to triage.
    const taskPath = join(root, 'vault', 'MMR', `${taskRef}.md`);
    appendFileSync(taskPath, '\n## Annotations\n');

    const report = await triage(store, { board: 'MMR' });

    // Nothing to reconcile here — the corrupt anchor must NOT surface as a failure.
    expect(report.failures).toHaveLength(0);
    expect(report.upstreamResolutions).toHaveLength(0);
  });

  test('a task with a dangling upstream ref is skipped gracefully', async () => {
    const { phaseRef } = await seedbed();
    const task = await createTask(store, {
      parentId: await idOf(phaseRef),
      title: 't',
      upstream: 'MMR-s99',
    });
    const report = await triage(store, { board: 'MMR' });
    expect(report.upstreamResolutions).toHaveLength(0);
    expect(await annotationsOf(`MMR-${String(task.seq)}`)).toHaveLength(0);
  });
});

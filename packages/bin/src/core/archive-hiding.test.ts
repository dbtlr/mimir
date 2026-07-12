import { afterEach, beforeEach, expect, test } from 'bun:test';

import { nodeIdOf, projectIdOf, createTestStore } from '../testing/store';
import { createInitiative, createPhase, createProject, createTask } from './create';
import {
  archiveProject,
  attachArtifact,
  depend,
  getArtifact,
  getNode,
  listNodes,
  listProjects,
  nextTasks,
  nodeTree,
  projectTree,
  statusOfNode,
  unarchiveProject,
} from './index';
import type { Store } from './store';
import { expectMimirError } from './testing';

/**
 * Read-side hiding (ADR 0015 Phase 1): an archived project + its whole subtree
 * + artifacts read as absent by default across every read path; a project-level
 * `--status archived` door is the sole opt-in. `unarchive` restores visibility.
 */

const NORN = Bun.which('norn') !== null;

let store: Store;
let closeStore: () => Promise<void>;
let gonTaskId: string;
let gonArtifactId: string;
beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
  // A project we keep, and one we'll archive.
  await createProject(store, { key: 'KEP', name: 'keep' });
  const kepId = await projectIdOf(store, 'KEP');
  const kInit = await createInitiative(store, { projectId: kepId, title: 'i' });
  const kInitId = await nodeIdOf(store, `KEP-${String(kInit.seq)}`);
  const kPhase = await createPhase(store, { parentId: kInitId, title: 'ph' });
  const kPhaseId = await nodeIdOf(store, `KEP-${String(kPhase.seq)}`);
  await createTask(store, { parentId: kPhaseId, title: 'kep task' });

  await createProject(store, { key: 'GON', name: 'gone' });
  const gonId = await projectIdOf(store, 'GON');
  const gInit = await createInitiative(store, { projectId: gonId, title: 'i' });
  const gInitId = await nodeIdOf(store, `GON-${String(gInit.seq)}`);
  const gPhase = await createPhase(store, { parentId: gInitId, title: 'ph' });
  const gPhaseId = await nodeIdOf(store, `GON-${String(gPhase.seq)}`);
  const gTask = await createTask(store, { parentId: gPhaseId, title: 'gon task' });
  gonTaskId = `GON-${String(gTask.seq)}`;
  const gTaskId = await nodeIdOf(store, gonTaskId);

  const art = await attachArtifact(store, {
    content: 'spec',
    linkNodeIds: [gTaskId],
    projectId: gonId,
    title: 'a',
  });
  gonArtifactId = art.renderedId;
});
afterEach(async () => {
  await closeStore();
});

test.skipIf(!NORN)('next and list exclude an archived project’s subtree', async () => {
  const before = await listNodes(store, { status: 'all' });
  expect(before.items.some((n) => n.id === gonTaskId)).toBe(true);

  await archiveProject(store, await projectIdOf(store, 'GON'));

  const list = await listNodes(store, { status: 'all' });
  expect(list.items.some((n) => n.id === gonTaskId)).toBe(false);
  expect(list.items.some((n) => n.id.startsWith('KEP-'))).toBe(true); // sibling still visible

  const next = await nextTasks(store, {});
  expect(next.items.some((n) => n.id.startsWith('GON-'))).toBe(false);
});

test.skipIf(!NORN)(
  'get / status / tree / getArtifact on an archived target read as not_found',
  async () => {
    await archiveProject(store, await projectIdOf(store, 'GON'));
    await expectMimirError('not_found', () => getNode(store, 'GON')); // the project
    await expectMimirError('not_found', () => getNode(store, gonTaskId)); // a node under it
    await expectMimirError('not_found', () => statusOfNode(store, 'GON'));
    await expectMimirError('not_found', () => statusOfNode(store, gonTaskId));
    await expectMimirError('not_found', () => nodeTree(store, gonTaskId));
    await expectMimirError('not_found', () => projectTree(store, 'GON'));
    await expectMimirError('not_found', () => getArtifact(store, gonArtifactId));
  },
);

test.skipIf(!NORN)(
  'listProjects hides archived by default; the door reveals only archived',
  async () => {
    await archiveProject(store, await projectIdOf(store, 'GON'));

    const active = await listProjects(store);
    expect(active.map((p) => p.id).toSorted()).toEqual(['KEP']);

    const archived = await listProjects(store, undefined, 'archived');
    expect(archived.map((p) => p.id)).toEqual(['GON']);

    const all = await listProjects(store, undefined, 'all');
    expect(all.map((p) => p.id).toSorted()).toEqual(['GON', 'KEP']);
  },
);

test.skipIf(!NORN)('the artifact feed excludes an archived project’s artifacts', async () => {
  const archivedKeys = async (): Promise<string[]> => {
    const ws = await store.loadWorkingSet();
    return ws.projects.filter((p) => p.archived_at !== null).map((p) => p.key);
  };
  const before = await store.artifacts.list({ excludeProjects: await archivedKeys() });
  expect(before.total).toBe(1);

  await archiveProject(store, await projectIdOf(store, 'GON'));
  const after = await store.artifacts.list({ excludeProjects: await archivedKeys() });
  expect(after.total).toBe(0);
});

test.skipIf(!NORN)(
  'the deps facet does not leak archived nodes across a cross-project edge',
  async () => {
    // Active AAA with two tasks + a cross-project edge each way into the GON task.
    await createProject(store, { key: 'AAA', name: 'a' });
    const aaaId = await projectIdOf(store, 'AAA');
    const aInit = await createInitiative(store, { projectId: aaaId, title: 'i' });
    const aInitId = await nodeIdOf(store, `AAA-${String(aInit.seq)}`);
    const aPhase = await createPhase(store, { parentId: aInitId, title: 'ph' });
    const aPhaseId = await nodeIdOf(store, `AAA-${String(aPhase.seq)}`);
    const a1 = await createTask(store, { parentId: aPhaseId, title: 'a1' });
    const a2 = await createTask(store, { parentId: aPhaseId, title: 'a2' });
    const a1Id = await nodeIdOf(store, `AAA-${String(a1.seq)}`);
    const a2Id = await nodeIdOf(store, `AAA-${String(a2.seq)}`);
    const gonTaskNumId = await nodeIdOf(store, gonTaskId);
    await depend(store, a1Id, [gonTaskNumId]); // a1 depends on the GON task (dependsOn/awaitingOn)
    await depend(store, gonTaskNumId, [a2Id]); // the GON task depends on a2 (a2 blocking)

    await archiveProject(store, await projectIdOf(store, 'GON'));

    const a1View = await getNode(store, `AAA-${String(a1.seq)}`, { facets: ['deps'] });
    const shown = [...(a1View.deps?.dependsOn ?? []), ...(a1View.deps?.awaitingOn ?? [])];
    expect(shown.some((r) => r.id.startsWith('GON-'))).toBe(false);

    const a2View = await getNode(store, `AAA-${String(a2.seq)}`, { facets: ['deps'] });
    expect((a2View.deps?.blocking ?? []).some((r) => r.id.startsWith('GON-'))).toBe(false);
  },
);

test.skipIf(!NORN)('unarchive restores full read visibility', async () => {
  await archiveProject(store, await projectIdOf(store, 'GON'));
  await unarchiveProject(store, await projectIdOf(store, 'GON'));

  const list = await listNodes(store, { status: 'all' });
  expect(list.items.some((n) => n.id === gonTaskId)).toBe(true);
  expect((await getNode(store, 'GON')).id).toBe('GON');
  expect((await listProjects(store)).map((p) => p.id).toSorted()).toEqual(['GON', 'KEP']);
});

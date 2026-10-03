import { afterEach, beforeEach, expect, test } from 'bun:test';

import { nodeIdOf, projectIdOf, createTestStore, rawPatchNode } from '../../testing/store';
import { createInitiative, createPhase, createProject, createTask } from '../create';
import { deriveSet } from '../derive';
import { resolveEntityTokenInSet } from '../resolve-set';
import type { Store } from '../store';
import { expectMimirError } from '../testing';
import { attachArtifact } from './data';
import { tagEntities, untagEntities } from './tags';

let store: Store;
let closeStore: (() => Promise<void>) | undefined;
let projectId: string;
let phaseId: string;
let taskId: string;
beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
  await createProject(store, { key: 'MMR', name: 'm' });
  projectId = await projectIdOf(store, 'MMR');
  const init = await createInitiative(store, { projectId, title: 'i' });
  const initId = await nodeIdOf(store, `MMR-${String(init.seq)}`);
  const phase = await createPhase(store, { parentId: initId, title: 'ph' });
  phaseId = await nodeIdOf(store, `MMR-${String(phase.seq)}`);
  const task = await createTask(store, { parentId: phaseId, title: 't' });
  taskId = await nodeIdOf(store, `MMR-${String(task.seq)}`);
});
afterEach(async () => {
  await closeStore?.();
  closeStore = undefined;
});

async function projectTagsOf(id: string): Promise<{ tag: string }[]> {
  const ws = await store.loadWorkingSet();
  return [...(ws.projectTags.get(id) ?? [])]
    .map((t) => ({ tag: t.tag }))
    .toSorted((a, b) => a.tag.localeCompare(b.tag));
}
async function nodeTagsOf(id: string): Promise<{ tag: string }[]> {
  const ws = await store.loadWorkingSet();
  return [...(ws.nodeTags.get(id) ?? [])]
    .map((t) => ({ tag: t.tag }))
    .toSorted((a, b) => a.tag.localeCompare(b.tag));
}

test('tag reaches all three entity types via the identity grammar', async () => {
  const { renderedId } = await attachArtifact(store, { content: 'x', projectId, title: 'x' });
  const set = deriveSet(await store.loadWorkingSet());
  const targets = ['MMR', 'MMR-3', renderedId].map((t) => resolveEntityTokenInSet(set, t));
  await tagEntities(store, targets, ['spec']);

  expect(await projectTagsOf(projectId)).toEqual([{ tag: 'spec' }]);
  expect(await nodeTagsOf(taskId)).toEqual([{ tag: 'spec' }]);

  // The artifact target carries its canonical (key, seq) identity, so
  // read its tags back through the artifact seam by that same identity.
  const artifactTarget = targets[2];
  if (artifactTarget === undefined || artifactTarget.entityType !== 'artifact') {
    throw new Error('expected an artifact target');
  }
  const record = await store.artifacts.load(artifactTarget.key, artifactTarget.seq);
  expect(record?.tags).toEqual(['spec']);
});

// A node/project tag is a plain frontmatter string set (ADR 0005) — a tag
// application carries no note on any entity (MMR-270). Re-tagging never
// duplicates a row.
test('re-tagging is idempotent', async () => {
  const target = resolveEntityTokenInSet(deriveSet(await store.loadWorkingSet()), 'MMR-3');
  await tagEntities(store, [target], ['spec']);
  await tagEntities(store, [target], ['spec']); // idempotent → row kept as-is
  expect(await nodeTagsOf(taskId)).toEqual([{ tag: 'spec' }]);
});

test('a real tag bumps updated_at; an idempotent re-tag leaves it alone (MMR-303)', async () => {
  const target = resolveEntityTokenInSet(deriveSet(await store.loadWorkingSet()), 'MMR-3');
  const updatedAtOf = async (): Promise<string> => {
    const ws = await store.loadWorkingSet();
    const node = ws.nodes.find((n) => n.id === taskId);
    if (node === undefined) {
      throw new Error('task vanished');
    }
    return node.updated_at;
  };
  // Backdate the stamp: an in-process store tags within the creating
  // millisecond, where a fresh stamp would equal the old one.
  await rawPatchNode(store, taskId, { updated_at: '2026-01-01T00:00:00.000Z' });
  const before = await updatedAtOf();
  await tagEntities(store, [target], ['spec']);
  const afterFirst = await updatedAtOf();
  expect(afterFirst).not.toBe(before); // set changed → the co-written guard stamp
  await tagEntities(store, [target], ['spec']);
  expect(await updatedAtOf()).toBe(afterFirst); // no-op → stale clock untouched
});

test('untag removes only the named tags and reports the count', async () => {
  const target = resolveEntityTokenInSet(deriveSet(await store.loadWorkingSet()), 'MMR-3');
  await tagEntities(store, [target], ['spec', 'v2', 'keep']);
  const removed = await untagEntities(store, [target], ['spec', 'v2', 'absent']);
  expect(removed).toBe(2);
  expect((await nodeTagsOf(taskId)).map((r) => r.tag)).toEqual(['keep']);
});

test('neither tag nor untag writes the transition log', async () => {
  const target = resolveEntityTokenInSet(deriveSet(await store.loadWorkingSet()), 'MMR-3');
  const before = (await store.transitions.list()).items.length;
  await tagEntities(store, [target], ['spec']);
  await untagEntities(store, [target], ['spec']);
  const after = (await store.transitions.list()).items.length;
  expect(after).toBe(before);
});

test('resolveEntityToken rejects unknown project/node and malformed tokens', async () => {
  // Pure resolver logic — an empty in-memory working set, no store needed.
  const set = deriveSet({
    edges: [],
    nodeTags: new Map(),
    nodes: [],
    projectTags: new Map(),
    projects: [],
  });
  await expectMimirError('not_found', async () => resolveEntityTokenInSet(set, 'ZZZ'));
  await expectMimirError('not_found', async () => resolveEntityTokenInSet(set, 'MMR-99'));
  await expectMimirError('not_found', async () => resolveEntityTokenInSet(set, 'not-an-id'));
});

test('an artifact token resolves by external identity, existence is the seam’s concern (MMR-143)', async () => {
  // Unlike node/project, an artifact token parses to (key, seq) without a
  // store read — the vault-backed artifact stem is already canonical, and tags
  // never validate existence (the seam applies to a missing artifact as a
  // silent no-op).
  const set = deriveSet(await store.loadWorkingSet());
  expect(resolveEntityTokenInSet(set, 'MMR-a9')).toEqual({
    entityType: 'artifact',
    key: 'MMR',
    seq: 9,
  });
});

test('create verbs apply creation-time tags', async () => {
  const t = await createTask(store, { parentId: phaseId, tags: ['spec', 'v2'], title: 'tt' });
  const tId = await nodeIdOf(store, `MMR-${String(t.seq)}`);
  expect((await nodeTagsOf(tId)).map((r) => r.tag)).toEqual(['spec', 'v2']);

  await createProject(store, { key: 'OTH', name: 'o', tags: ['ws'] });
  const pId = await projectIdOf(store, 'OTH');
  expect((await projectTagsOf(pId)).map((r) => r.tag)).toEqual(['ws']);
});

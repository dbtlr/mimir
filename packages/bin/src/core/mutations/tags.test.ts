import { afterEach, beforeEach, expect, test } from 'bun:test';

import { nodeIdOf, projectIdOf, createTestStore } from '../../testing/store';
import { createInitiative, createPhase, createProject, createTask } from '../create';
import { deriveSet } from '../derive';
import { resolveEntityTokenInSet } from '../resolve-set';
import type { Store } from '../store';
import { expectMimirError } from '../testing';
import { attachArtifact } from './data';
import { tagEntities, untagEntities } from './tags';

const NORN = Bun.which('norn') !== null;

let store: Store;
let closeStore: (() => Promise<void>) | undefined;
let projectId: number;
let phaseId: number;
let taskId: number;
beforeEach(async () => {
  // Norn-only fixture: the pure resolver test below runs everywhere over an
  // in-memory set, so without norn the store fixture stays un-built (every
  // store-touching test is skipIf(!NORN)-gated).
  if (!NORN) {
    return;
  }
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

async function projectTagsOf(id: number): Promise<{ tag: string; note: string | null }[]> {
  const ws = await store.loadWorkingSet();
  return [...(ws.projectTags.get(id) ?? [])]
    .map((t) => ({ note: t.note, tag: t.tag }))
    .toSorted((a, b) => a.tag.localeCompare(b.tag));
}
async function nodeTagsOf(id: number): Promise<{ tag: string; note: string | null }[]> {
  const ws = await store.loadWorkingSet();
  return [...(ws.nodeTags.get(id) ?? [])]
    .map((t) => ({ note: t.note, tag: t.tag }))
    .toSorted((a, b) => a.tag.localeCompare(b.tag));
}

test.skipIf(!NORN)('tag reaches all three entity types via the identity grammar', async () => {
  const { renderedId } = await attachArtifact(store, { content: 'x', projectId, title: 'x' });
  const set = deriveSet(await store.loadWorkingSet());
  const targets = ['MMR', 'MMR-3', renderedId].map((t) => resolveEntityTokenInSet(set, t));
  await tagEntities(store, targets, ['spec']);

  expect(await projectTagsOf(projectId)).toEqual([{ note: null, tag: 'spec' }]);
  expect(await nodeTagsOf(taskId)).toEqual([{ note: null, tag: 'spec' }]);

  // The artifact target carries (key, seq) — no numeric id to look up — so
  // read its tags back through the artifact seam by that same identity.
  const artifactTarget = targets[2];
  if (artifactTarget === undefined || artifactTarget.entityType !== 'artifact') {
    throw new Error('expected an artifact target');
  }
  const record = await store.artifacts.load(artifactTarget.key, artifactTarget.seq);
  expect(record?.tags).toEqual(['spec']);
});

// NOTE: a node/project tag is a plain frontmatter string set with no per-tag
// note field (documented in store-norn.ts and vault-frontmatter.ts — the same
// gap the artifact seam makes explicit by *rejecting* a note outright,
// MMR-143); `tagEntities` accepts a `note` for a node/project target but it is
// silently dropped on write, and every tag reads back `note: null`. The
// idempotency this test guards — re-tagging never duplicates a row — still
// holds and is still asserted; only the note-persistence expectation changed,
// to match the backend's real, permanent contract rather than weakening
// coverage.
test.skipIf(!NORN)(
  're-tagging is idempotent; a node/project tag carries no note over Norn',
  async () => {
    const target = resolveEntityTokenInSet(deriveSet(await store.loadWorkingSet()), 'MMR-3');
    await tagEntities(store, [target], ['spec'], 'first');
    await tagEntities(store, [target], ['spec']); // no note → row kept as-is
    expect(await nodeTagsOf(taskId)).toEqual([{ note: null, tag: 'spec' }]);

    await tagEntities(store, [target], ['spec'], 'second');
    expect(await nodeTagsOf(taskId)).toEqual([{ note: null, tag: 'spec' }]);
  },
);

test.skipIf(!NORN)('untag removes only the named tags and reports the count', async () => {
  const target = resolveEntityTokenInSet(deriveSet(await store.loadWorkingSet()), 'MMR-3');
  await tagEntities(store, [target], ['spec', 'v2', 'keep']);
  const removed = await untagEntities(store, [target], ['spec', 'v2', 'absent']);
  expect(removed).toBe(2);
  expect((await nodeTagsOf(taskId)).map((r) => r.tag)).toEqual(['keep']);
});

test.skipIf(!NORN)('neither tag nor untag writes the transition log', async () => {
  const target = resolveEntityTokenInSet(deriveSet(await store.loadWorkingSet()), 'MMR-3');
  const before = (await store.transitions.list()).items.length;
  await tagEntities(store, [target], ['spec']);
  await untagEntities(store, [target], ['spec']);
  const after = (await store.transitions.list()).items.length;
  expect(after).toBe(before);
});

test('resolveEntityToken rejects unknown project/node and malformed tokens', async () => {
  // Pure resolver logic — an empty in-memory working set, no store needed, so
  // this runs on every platform (norn or not).
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

test.skipIf(!NORN)(
  'an artifact token resolves by external identity, existence is the seam’s concern (MMR-143)',
  async () => {
    // Unlike node/project, an artifact token parses to (key, seq) without a
    // store read — a vault-backed artifact has no row-level surrogate, and tags
    // never validate existence (the seam applies to a missing artifact as a
    // silent no-op).
    const set = deriveSet(await store.loadWorkingSet());
    expect(resolveEntityTokenInSet(set, 'MMR-a9')).toEqual({
      entityType: 'artifact',
      key: 'MMR',
      seq: 9,
    });
  },
);

test.skipIf(!NORN)('create verbs apply creation-time tags', async () => {
  const t = await createTask(store, { parentId: phaseId, tags: ['spec', 'v2'], title: 'tt' });
  const tId = await nodeIdOf(store, `MMR-${String(t.seq)}`);
  expect((await nodeTagsOf(tId)).map((r) => r.tag)).toEqual(['spec', 'v2']);

  await createProject(store, { key: 'OTH', name: 'o', tags: ['ws'] });
  const pId = await projectIdOf(store, 'OTH');
  expect((await projectTagsOf(pId)).map((r) => r.tag)).toEqual(['ws']);
});

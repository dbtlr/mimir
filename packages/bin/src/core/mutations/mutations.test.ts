import { afterEach, beforeEach, expect, test } from 'bun:test';

import { nodeIdOf, projectIdOf, createTestStore, rawDep } from '../../testing/store';
import { createInitiative, createPhase, createProject, createTask } from '../create';
import { deriveSet } from '../derive';
import { parseIdentity } from '../ids';
import { getArtifact } from '../intent';
import { RANK_STEP } from '../rank';
import { resolveEntityTokenInSet } from '../resolve-set';
import type { Store } from '../store';
import { expectMimirError } from '../testing';
import {
  abandonTask,
  annotate,
  archiveProject,
  attachArtifact,
  blockTask,
  completeTask,
  depend,
  inapplicableUpdateFields,
  moveNode,
  parkTask,
  reorder,
  resolveAttachTargets,
  startTask,
  tagEntities,
  unblockTask,
  unparkTask,
  undepend,
  untagEntities,
  updateArtifact,
  updateNode,
  updateProject,
} from './index';

const NORN = Bun.which('norn') !== null;

let store: Store;
let closeStore: () => Promise<void>;
// Fixture identities are threaded as their canonical `KEY-seq` stems. The
// project/initiative/phase helpers resolve those stems at the point of use.
let mmrInitSeq: number;
let mmrPhaseSeq: number;
const projectId = () => projectIdOf(store, 'MMR');
const initId = () => nodeIdOf(store, `MMR-${String(mmrInitSeq)}`);
const phaseId = () => nodeIdOf(store, `MMR-${String(mmrPhaseSeq)}`);

beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
  await createProject(store, { key: 'MMR', name: 'm' });
  const init = await createInitiative(store, { projectId: await projectId(), title: 'i' });
  mmrInitSeq = init.seq;
  const phase = await createPhase(store, { parentId: await initId(), title: 'ph' });
  mmrPhaseSeq = phase.seq;
});
afterEach(async () => {
  await closeStore();
});

async function task(title = 't'): Promise<string> {
  const t = await createTask(store, { parentId: await phaseId(), title });
  return nodeIdOf(store, `MMR-${String(t.seq)}`);
}
async function reload(id: string) {
  const node = await store.transact((w) => w.loadNode(id));
  if (node === undefined) {
    throw new Error(`node ${id} vanished`);
  }
  return node;
}
/** The canonical `KEY-seq` stem used by the transitions feed and link assertions. */
async function stemOf(id: string): Promise<string> {
  const set = deriveSet(await store.loadWorkingSet());
  const node = set.nodeById.get(id);
  if (node === undefined) {
    throw new Error(`node ${id} vanished`);
  }
  return node.id;
}
async function logs(id: string) {
  const ref = await stemOf(id);
  const { items } = await store.transitions.list();
  return items
    .filter((entry) => entry.node === ref)
    .map((entry) => ({
      from_value: entry.from,
      kind: entry.kind,
      reason: entry.reason,
      to_value: entry.to,
    }));
}

test.skipIf(!NORN)('start keeps rank and logs a lifecycle transition', async () => {
  const id = await task();
  const before = await reload(id);
  expect(before.rank).toBe(RANK_STEP);
  const echoed = await startTask(store, id);
  expect(echoed.lifecycle).toBe('in_progress');
  expect(echoed.rank).toBe(RANK_STEP); // todo->in_progress stays in the rankable set
  expect(await logs(id)).toEqual([
    { from_value: 'todo', kind: 'lifecycle', reason: null, to_value: 'in_progress' },
  ]);
  await expectMimirError('validation', () => startTask(store, id)); // not a todo anymore
});

test.skipIf(!NORN)('complete is terminal: stamps completed_at and clears rank', async () => {
  const id = await task();
  await startTask(store, id);
  const done = await completeTask(store, id);
  expect(done.lifecycle).toBe('done');
  expect(done.completed_at).not.toBeNull();
  expect(done.rank).toBeNull();
  await expectMimirError('validation', () => completeTask(store, id)); // already terminal
});

test.skipIf(!NORN)('abandon clears rank and records its reason on the log row', async () => {
  const id = await task();
  const gone = await abandonTask(store, id, 'scope cut');
  expect(gone.lifecycle).toBe('abandoned');
  expect(gone.rank).toBeNull();
  expect(gone.completed_at).toBeNull(); // only complete stamps it
  expect((await logs(id)).at(-1)).toEqual({
    from_value: 'todo',
    kind: 'lifecycle',
    reason: 'scope cut',
    to_value: 'abandoned',
  });
});

test.skipIf(!NORN)(
  'park/unpark and block/unblock leave and re-enter the rankable set',
  async () => {
    const id = await task();
    const parked = await parkTask(store, id, 'later');
    expect(parked.hold).toBe('parked');
    expect(parked.hold_reason).toBe('later');
    expect(parked.rank).toBeNull();
    await expectMimirError('validation', () => parkTask(store, id)); // already held

    const unparked = await unparkTask(store, id);
    expect(unparked.hold).toBe('none');
    expect(unparked.hold_reason).toBeNull();
    expect(unparked.rank).toBe(RANK_STEP); // re-appended to bottom (only task)

    const blocked = await blockTask(store, id, 'waiting on API');
    expect(blocked.hold).toBe('blocked');
    expect(blocked.rank).toBeNull();
    const unblocked = await unblockTask(store, id);
    expect(unblocked.hold).toBe('none');
    expect(unblocked.rank).toBe(RANK_STEP);

    expect((await logs(id)).map((l) => `${String(l.from_value)}>${String(l.to_value)}`)).toEqual([
      'none>parked',
      'parked>none',
      'none>blocked',
      'blocked>none',
    ]);
  },
);

test.skipIf(!NORN)('depend builds acyclic edges and rejects cycles and self-deps', async () => {
  const a = await task('a');
  const b = await task('b');
  const c = await task('c');
  await depend(store, b, [a]); // b depends on a
  await depend(store, c, [b]); // c depends on b
  await expectMimirError('validation', () => depend(store, a, [c])); // a->c would close a->c->b->a
  await expectMimirError('validation', () => depend(store, a, [a])); // self

  const edges = (await store.loadWorkingSet()).edges.filter((e) => e.node_id === b);
  expect(edges).toHaveLength(1);
  expect((await logs(b)).at(-1)?.kind).toBe('dependency');

  await undepend(store, b, [a]);
  expect((await store.loadWorkingSet()).edges.filter((e) => e.node_id === b)).toHaveLength(0);
});

test.skipIf(!NORN)(
  'depend rejects same-lineage edges (ancestor/descendant) and allows cross-lineage',
  async () => {
    const t = await task('t'); // under phaseId → initId → project
    // depend on your own descendant: the phase would await a task it contains
    await expectMimirError('validation', async () => depend(store, await phaseId(), [t]));
    // depend on your own ancestor (parent phase, and grandparent initiative)
    await expectMimirError('validation', async () => depend(store, t, [await phaseId()]));
    await expectMimirError('validation', async () => depend(store, t, [await initId()]));

    // a sibling branch is fine — neither node contains the other
    const phase2 = await createPhase(store, { parentId: await initId(), title: 'ph2' });
    const phase2Id = await nodeIdOf(store, `MMR-${String(phase2.seq)}`);
    const t2 = await createTask(store, { parentId: phase2Id, title: 't2' });
    const t2Id = await nodeIdOf(store, `MMR-${String(t2.seq)}`);
    await depend(store, t, [t2Id]); // task → task in another phase
    await depend(store, await phaseId(), [phase2Id]); // sibling phase → sibling phase
    expect((await store.loadWorkingSet()).edges.filter((e) => e.node_id === t)).toHaveLength(1);
  },
);

test.skipIf(!NORN)(
  'depend rejects an edge that closes a derivation cycle through container rollups',
  async () => {
    // task b under initiative A (via phaseId); initiative C with task d
    const b = await task('b');
    const initC = await createInitiative(store, { projectId: await projectId(), title: 'C' });
    const initCId = await nodeIdOf(store, `MMR-${String(initC.seq)}`);
    const d = await createTask(store, { parentId: initCId, title: 'd' });
    const dId = await nodeIdOf(store, `MMR-${String(d.seq)}`);
    await depend(store, b, [initCId]); // b awaits C's rollup — fine on its own

    // d → A closes the loop: word(b) ← settled(C) ← word(d) ← settled(A) ← word(b)
    await expectMimirError('validation', async () => depend(store, dId, [await initId()]));
    expect((await store.loadWorkingSet()).edges.filter((e) => e.node_id === dId)).toHaveLength(0);
  },
);

test.skipIf(!NORN)(
  'depend rejects a multi-hop derivation cycle across three containers',
  async () => {
    const b = await task('b'); // under A (initId)
    const initC = await createInitiative(store, { projectId: await projectId(), title: 'C' });
    const initCId = await nodeIdOf(store, `MMR-${String(initC.seq)}`);
    const d = await createTask(store, { parentId: initCId, title: 'd' });
    const dId = await nodeIdOf(store, `MMR-${String(d.seq)}`);
    const initE = await createInitiative(store, { projectId: await projectId(), title: 'E' });
    const initEId = await nodeIdOf(store, `MMR-${String(initE.seq)}`);
    const f = await createTask(store, { parentId: initEId, title: 'f' });
    const fId = await nodeIdOf(store, `MMR-${String(f.seq)}`);
    await depend(store, b, [initCId]); // A's task awaits C
    await depend(store, dId, [initEId]); // C's task awaits E

    // E's task awaiting A closes the three-container loop
    await expectMimirError('validation', async () => depend(store, fId, [await initId()]));
  },
);

test.skipIf(!NORN)('move is rejected when re-parenting closes a derivation cycle', async () => {
  const b = await task('b'); // under A (initId)
  const initC = await createInitiative(store, { projectId: await projectId(), title: 'C' });
  const initCId = await nodeIdOf(store, `MMR-${String(initC.seq)}`);
  const initE = await createInitiative(store, { projectId: await projectId(), title: 'E' });
  const initEId = await nodeIdOf(store, `MMR-${String(initE.seq)}`);
  const d = await createTask(store, { parentId: initEId, title: 'd' });
  const dId = await nodeIdOf(store, `MMR-${String(d.seq)}`);
  await depend(store, b, [initCId]); // b awaits C
  await depend(store, dId, [await initId()]); // d awaits A — acyclic while d lives in E

  // moving d into C makes C's rollup depend on d → the loop closes
  await expectMimirError('validation', () => moveNode(store, dId, initCId));
  expect((await reload(dId)).parent_id).toBe(initEId);

  // a neutral destination still works
  const initN = await createInitiative(store, { projectId: await projectId(), title: 'N' });
  const initNId = await nodeIdOf(store, `MMR-${String(initN.seq)}`);
  const moved = await moveNode(store, dId, initNId);
  expect(moved.parent_id).toBe(initNId);
});

test.skipIf(!NORN)(
  'a pre-existing derivation cycle in legacy data does not reject unrelated writes',
  async () => {
    // raw-write a container cycle the guards would now refuse (pre-guard data):
    // bypass the `depend` verb entirely via the writer primitive, which — like
    // the old raw `insertInto('dependency')` — performs no cycle validation.
    const initX = await createInitiative(store, { projectId: await projectId(), title: 'X' });
    const initXId = await nodeIdOf(store, `MMR-${String(initX.seq)}`);
    const x = await createTask(store, { parentId: initXId, title: 'x' });
    const xId = await nodeIdOf(store, `MMR-${String(x.seq)}`);
    const initY = await createInitiative(store, { projectId: await projectId(), title: 'Y' });
    const initYId = await nodeIdOf(store, `MMR-${String(initY.seq)}`);
    const y = await createTask(store, { parentId: initYId, title: 'y' });
    const yId = await nodeIdOf(store, `MMR-${String(y.seq)}`);
    await rawDep(store, xId, initYId);
    await rawDep(store, yId, initXId);

    // an unrelated depend-on-container and an unrelated move both still work
    const initP = await createInitiative(store, { projectId: await projectId(), title: 'P' });
    const initPId = await nodeIdOf(store, `MMR-${String(initP.seq)}`);
    const p = await createTask(store, { parentId: initPId, title: 'p' });
    const pId = await nodeIdOf(store, `MMR-${String(p.seq)}`);
    const initQ = await createInitiative(store, { projectId: await projectId(), title: 'Q' });
    const initQId = await nodeIdOf(store, `MMR-${String(initQ.seq)}`);
    await depend(store, pId, [initQId]);
    const moved = await moveNode(store, pId, initXId);
    expect(moved.parent_id).toBe(initXId);
  },
);

test.skipIf(!NORN)(
  'move rejects a loop threaded through an archived project (dormant until unarchive)',
  async () => {
    // live shape, acyclic: b under N awaits C (project P2); d under C awaits A
    const initN = await createInitiative(store, { projectId: await projectId(), title: 'N' });
    const initNId = await nodeIdOf(store, `MMR-${String(initN.seq)}`);
    const b = await createTask(store, { parentId: initNId, title: 'b' });
    const bId = await nodeIdOf(store, `MMR-${String(b.seq)}`);
    await createProject(store, { key: 'PTW', name: 'p2' });
    const p2Id = await projectIdOf(store, 'PTW');
    const initC = await createInitiative(store, { projectId: p2Id, title: 'C' });
    const initCId = await nodeIdOf(store, `PTW-${String(initC.seq)}`);
    const d = await createTask(store, { parentId: initCId, title: 'd' });
    const dId = await nodeIdOf(store, `PTW-${String(d.seq)}`);
    await depend(store, bId, [initCId]);
    await depend(store, dId, [await initId()]);

    // archived, C reads as settled at runtime — but moving b under A would close
    // the loop the moment P2 is unarchived, so the guard counts it as real
    await archiveProject(store, p2Id);
    await expectMimirError('validation', async () => moveNode(store, bId, await initId()));
    expect((await reload(bId)).parent_id).toBe(initNId);
  },
);

test.skipIf(!NORN)(
  'move is rejected when it would create a same-lineage dependency edge',
  async () => {
    const phase2 = await createPhase(store, { parentId: await initId(), title: 'ph2' });
    const phase2Id = await nodeIdOf(store, `MMR-${String(phase2.seq)}`);
    const a = await task('a'); // under phaseId
    await depend(store, a, [phase2Id]); // cross-lineage at depend-time → allowed

    // moving a under phase2 would make a depend on its own (new) ancestor → reject
    await expectMimirError('validation', () => moveNode(store, a, phase2Id));
    // the edge and parent are untouched
    expect((await reload(a)).parent_id).toBe(await phaseId());

    // a benign move to a sibling with no conflicting edge still works
    const phase3 = await createPhase(store, { parentId: await initId(), title: 'ph3' });
    const phase3Id = await nodeIdOf(store, `MMR-${String(phase3.seq)}`);
    await moveNode(store, a, phase3Id);
    expect((await reload(a)).parent_id).toBe(phase3Id);
  },
);

test.skipIf(!NORN)(
  'move lineage guard covers the moved subtree, not just the moved node',
  async () => {
    const init2 = await createInitiative(store, { projectId: await projectId(), title: 'i2' });
    const init2Id = await nodeIdOf(store, `MMR-${String(init2.seq)}`);
    const child = await task('child'); // under phaseId, which is under initId
    await depend(store, child, [init2Id]); // child depends on init2 (cross-lineage)

    // moving phaseId under init2 makes child a descendant of init2 it depends on → reject
    await expectMimirError('validation', async () => moveNode(store, await phaseId(), init2Id));
  },
);

test.skipIf(!NORN)('move re-parents with type + cycle validation', async () => {
  const phase2 = await createPhase(store, { parentId: await initId(), title: 'ph2' });
  const phase2Id = await nodeIdOf(store, `MMR-${String(phase2.seq)}`);
  const t = await task('t');
  const moved = await moveNode(store, t, phase2Id);
  expect(moved.parent_id).toBe(phase2Id);
  expect((await logs(t)).at(-1)?.kind).toBe('move');

  // a task cannot parent to another task
  const other = await task('other');
  await expectMimirError('validation', () => moveNode(store, t, other));
  // a phase cannot move under its own descendant task... use node cycle: move init under its phase
  await expectMimirError('validation', async () =>
    moveNode(store, await initId(), await phaseId()),
  );
  // an initiative may go top-level
  const reparented = await moveNode(store, await initId(), null);
  expect(reparented.parent_id).toBeNull();
});

test.skipIf(!NORN)('update is a dumb scalar patch with type-applicability checks', async () => {
  const id = await task();
  const patched = await updateNode(store, id, { priority: 'p0', title: 'renamed' });
  expect(patched.title).toBe('renamed');
  expect(patched.priority).toBe('p0');

  // target is phase-only; priority is task-only
  await expectMimirError('validation', () => updateNode(store, id, { target: 'x' }));
  await expectMimirError('validation', async () =>
    updateNode(store, await phaseId(), { priority: 'p1' }),
  );

  // status is not reachable through update (lifecycle unchanged)
  expect((await reload(id)).lifecycle).toBe('todo');
});

test.skipIf(!NORN)(
  'update stores summary (all-node), strips newlines, and hard-rejects over 256 chars (MMR-162)',
  async () => {
    const id = await task();
    const patched = await updateNode(store, id, { summary: 'short lede' });
    expect(patched.summary).toBe('short lede');
    expect((await reload(id)).summary).toBe('short lede');

    const stripped = await updateNode(store, id, { summary: 'line one\nline two\r\nline three' });
    expect(stripped.summary).toBe('line one line two line three');

    const cleared = await updateNode(store, id, { summary: '   ' });
    expect(cleared.summary).toBeNull();

    await expectMimirError('validation', () => updateNode(store, id, { summary: 'x'.repeat(257) }));

    // all-node (unlike external_ref, which is task-only): an initiative accepts it too
    const initPatched = await updateNode(store, await initId(), { summary: 'initiative lede' });
    expect(initPatched.summary).toBe('initiative lede');
  },
);

test.skipIf(!NORN)('annotate and attachArtifact persist and link', async () => {
  const id = await task();
  await annotate(store, id, 'realized X');
  const stem = await stemOf(id);
  const notes = await store.bodySections.readAnnotations(stem);
  expect(notes.map((n) => n.content)).toEqual(['realized X']);

  const { renderedId } = await attachArtifact(store, {
    content: '# session log',
    linkNodeIds: [id],
    projectId: await projectId(),
    title: 'session log',
  });
  const detail = await getArtifact(store, renderedId);
  expect(detail.links).toEqual([stem]);
});

test.skipIf(!NORN)(
  'tag/untag an artifact route through the seam by external identity (MMR-143)',
  async () => {
    const { renderedId } = await attachArtifact(store, {
      content: 'x',
      projectId: await projectId(),
      title: 'doc',
    });
    // The verb path: resolve the token, then tag — an artifact target carries
    // (key, seq), so it needs no separate row-level identity.
    const target = resolveEntityTokenInSet(deriveSet(await store.loadWorkingSet()), renderedId);
    expect(target.entityType).toBe('artifact');
    await tagEntities(store, [target], ['urgent']);
    expect((await getArtifact(store, renderedId)).tags).toEqual(['urgent']);

    const removed = await untagEntities(store, [target], ['urgent', 'absent']);
    expect(removed).toBe(1);
    expect((await getArtifact(store, renderedId)).tags).toEqual([]);
  },
);

test.skipIf(!NORN)(
  'updateArtifact retitles; content frozen; blank title and unknown id refused (MMR-40)',
  async () => {
    const id = await task();
    const { renderedId } = await attachArtifact(store, {
      content: '# body',
      linkNodeIds: [id],
      projectId: await projectId(),
      title: 'first title',
    });
    const parsed = parseIdentity(renderedId);
    if (parsed?.kind !== 'artifact') {
      throw new Error('expected an artifact id');
    }
    const ref = { key: parsed.key, seq: parsed.seq };
    await updateArtifact(store, ref, { title: 'fixed title' });
    const record = await store.artifacts.load(ref.key, ref.seq, { content: true });
    expect(record?.title).toBe('fixed title');
    expect(record?.content).toBe('# body'); // content is never touched
    await expectMimirError('validation', () => updateArtifact(store, ref, { title: '  ' }));
    await expectMimirError('not_found', () =>
      updateArtifact(store, { key: 'MMR', seq: 9999 }, { title: 'x' }),
    );
  },
);

test.skipIf(!NORN)(
  'updateProject patches name and description; key is immutable (MMR-88)',
  async () => {
    const updated = await updateProject(store, await projectId(), {
      description: 'details',
      name: 'New Name',
    });
    expect(updated.name).toBe('New Name');
    expect(updated.description).toBe('details');

    // Patch only description — name untouched
    const again = await updateProject(store, await projectId(), { description: 'updated desc' });
    expect(again.name).toBe('New Name');
    expect(again.description).toBe('updated desc');

    // Clear description with explicit null
    const cleared = await updateProject(store, await projectId(), { description: null });
    expect(cleared.description).toBeNull();

    // Blank name is rejected
    await expectMimirError('validation', async () =>
      updateProject(store, await projectId(), { name: '  ' }),
    );

    // Missing project
    await expectMimirError('not_found', () => updateProject(store, 'ZZZ', { name: 'x' }));
  },
);

test.skipIf(!NORN)(
  'reorder moves within the rankable set and refuses terminal/held tasks',
  async () => {
    const a = await task('a');
    const b = await task('b');
    await reorder(store, b, 'top');
    const pid = await projectId();
    const ranked = (await store.loadWorkingSet()).nodes
      .filter((n) => n.project_id === pid && n.rank !== null)
      .toSorted((n1, n2) => (n1.rank ?? 0) - (n2.rank ?? 0))
      .map((n) => n.id);
    expect(ranked).toEqual([b, a]);

    await completeTask(store, a);
    await expectMimirError('validation', () => reorder(store, a, 'top')); // terminal -> no rank
  },
);

// ─── resolveAttachTargets: the shared attach link-resolution (MMR-305) ────────

/** Build a second project OTH with one task; return its `KEY-seq` ref. */
async function otherProjectTask(): Promise<string> {
  await createProject(store, { key: 'OTH', name: 'o' });
  const oi = await createInitiative(store, {
    projectId: await projectIdOf(store, 'OTH'),
    title: 'i',
  });
  const op = await createPhase(store, {
    parentId: await nodeIdOf(store, `OTH-${String(oi.seq)}`),
    title: 'p',
  });
  const ot = await createTask(store, {
    parentId: await nodeIdOf(store, `OTH-${String(op.seq)}`),
    title: 't',
  });
  return `OTH-${String(ot.seq)}`;
}

test.skipIf(!NORN)('resolveAttachTargets resolves links and infers the project', async () => {
  const a = await task('a');
  const b = await task('b');
  const pid = await projectId();
  const out = await resolveAttachTargets(store, [a, b]);
  expect(out.projectId).toBe(pid);
  expect(out.linkNodeIds).toEqual([a, b]);
});

test.skipIf(!NORN)(
  'resolveAttachTargets dedupes repeated tokens and a link equal to the anchor',
  async () => {
    const a = await task('a');
    const b = await task('b');
    // anchor a, then a again (link==anchor), then b, then b again (repeat)
    const out = await resolveAttachTargets(store, [a, a, b, b]);
    expect(out.linkNodeIds).toEqual([a, b]); // first-occurrence order, deduped
  },
);

test.skipIf(!NORN)('resolveAttachTargets rejects cross-project links', async () => {
  const a = await task('a');
  const other = await otherProjectTask();
  await expectMimirError('validation', () => resolveAttachTargets(store, [a, other]));
});

test.skipIf(!NORN)('resolveAttachTargets reports a missing token as not_found', async () => {
  await expectMimirError('not_found', () => resolveAttachTargets(store, ['MMR-9999']));
});

test.skipIf(!NORN)(
  'resolveAttachTargets names a wrong-kind token and carries the transport hint (MMR-304 parity)',
  async () => {
    const a = await task('a');
    // A project key where a link is expected — kind-aware, not a fake "doesn't exist".
    let wrongProject: unknown;
    try {
      await resolveAttachTargets(store, ['MMR']);
    } catch (error) {
      wrongProject = error;
    }
    expect(wrongProject).toMatchObject({
      code: 'validation',
      message: 'MMR is a project, not a task, phase, or initiative',
    });
    // An artifact id is likewise named by kind.
    const { renderedId } = await attachArtifact(store, {
      content: 'x',
      linkNodeIds: [a],
      projectId: await projectId(),
      title: 'doc',
    });
    let wrongArtifact: unknown;
    try {
      await resolveAttachTargets(store, [renderedId]);
    } catch (error) {
      wrongArtifact = error;
    }
    expect(wrongArtifact).toMatchObject({
      code: 'validation',
      message: `${renderedId} is an artifact, not a task, phase, or initiative`,
    });
    // A genuine node miss keeps "doesn't exist" and carries the notFound hint.
    let missing: unknown;
    try {
      await resolveAttachTargets(store, ['MMR-9999'], undefined, { notFound: 'try mimir list' });
    } catch (error) {
      missing = error;
    }
    expect(missing).toMatchObject({
      code: 'not_found',
      hint: 'try mimir list',
      message: "MMR-9999 doesn't exist",
    });
  },
);

test.skipIf(!NORN)('resolveAttachTargets honors an agreeing explicit project', async () => {
  const a = await task('a');
  const out = await resolveAttachTargets(store, [a], 'MMR');
  expect(out.projectId).toBe(await projectId());
  expect(out.linkNodeIds).toEqual([a]);
});

test.skipIf(!NORN)('resolveAttachTargets rejects a disagreeing explicit project', async () => {
  const a = await task('a');
  await otherProjectTask(); // makes OTH a real, resolvable key
  let disagree: unknown;
  try {
    await resolveAttachTargets(store, [a], 'OTH');
  } catch (error) {
    disagree = error;
  }
  expect(disagree).toMatchObject({
    code: 'validation',
    message: "the project disagrees with the links' project",
  });
});

test.skipIf(!NORN)(
  'resolveAttachTargets resolves an explicit project with no links, and rejects an unknown key',
  async () => {
    const out = await resolveAttachTargets(store, [], 'MMR');
    expect(out.projectId).toBe(await projectId());
    expect(out.linkNodeIds).toEqual([]);
    await expectMimirError('not_found', () => resolveAttachTargets(store, [], 'ZZZ'));
  },
);

// ---------------------------------------------------------------------------
// inapplicableUpdateFields (MMR-306) — the shared per-kind table the CLI and
// MCP transports both sweep over instead of hand-typing their own list. A
// pure lookup, no store needed.
// ---------------------------------------------------------------------------

test('inapplicableUpdateFields names every UpdateFields key a project rejects but description', () => {
  expect(inapplicableUpdateFields('project')).toEqual([
    'title',
    'summary',
    'priority',
    'size',
    'target',
    'externalRef',
    'upstream',
    'openEnded',
  ]);
});

test('inapplicableUpdateFields names every UpdateFields key an artifact rejects but title', () => {
  expect(inapplicableUpdateFields('artifact')).toEqual([
    'description',
    'summary',
    'priority',
    'size',
    'target',
    'externalRef',
    'upstream',
    'openEnded',
  ]);
});

test('inapplicableUpdateFields names every UpdateFields key a seed rejects but title/description', () => {
  expect(inapplicableUpdateFields('seed')).toEqual([
    'summary',
    'priority',
    'size',
    'target',
    'externalRef',
    'upstream',
    'openEnded',
  ]);
});

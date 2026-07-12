import { afterEach, beforeEach, expect, test } from 'bun:test';

import { createTestStore, nodeIdOf, projectIdOf } from '../../testing/store';
import { createInitiative, createPhase, createProject, createTask } from '../create';
import type { Node } from '../model';
import {
  abandonTask,
  attachArtifact,
  blockTask,
  completeTask,
  depend,
  startTask,
} from '../mutations';
import type { Store } from '../store';
import { getArtifact, getNode, listNodes, nextTasks, statusOfNode } from './index';

const NORN = Bun.which('norn') !== null;

/**
 * Assert that an async operation rejects. Replaces `expect(p).rejects.toThrow()`
 * — bun's types declare that chain non-thenable, which trips the type-aware
 * `await-thenable` lint under our zero-warning gate.
 */
async function expectReject(run: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await run();
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
}

let store: Store;
let closeStore: () => Promise<void>;
let phaseId: number;
let phaseSeq: number;
let initId: number;
let key: string;
beforeEach(async () => {
  ({ close: closeStore, store } = await createTestStore());
  const p = await createProject(store, { key: 'MMR', name: 'm' });
  key = p.key;
  const init = await createInitiative(store, {
    projectId: await projectIdOf(store, key),
    title: 'i',
  });
  initId = await nodeIdOf(store, `${key}-${String(init.seq)}`);
  const phase = await createPhase(store, { parentId: initId, title: 'ph' });
  phaseId = await nodeIdOf(store, `${key}-${String(phase.seq)}`);
  phaseSeq = phase.seq;
});
afterEach(async () => {
  await closeStore();
});

const idOf = (n: { seq: number }) => `${key}-${n.seq}`;

test.skipIf(!NORN)(
  'list orders within a project by numeric seq, not the lexical stem',
  async () => {
    // Enough tasks to reach a two-digit seq; abandon a low- and a high-seq one so
    // both share completed_at=null and fall to the seq tiebreak — the exact path a
    // lexical KEY-seq compare mis-ordered ("MMR-10" < "MMR-2").
    const tasks: Node[] = [];
    for (let i = 0; i < 10; i += 1) {
      tasks.push(await createTask(store, { parentId: phaseId, title: `t${String(i)}` }));
    }
    const bySeq = [...tasks].toSorted((a, b) => a.seq - b.seq);
    const low = bySeq[0];
    const high = bySeq[bySeq.length - 1];
    if (low === undefined || high === undefined) {
      throw new Error('expected created tasks');
    }
    expect(high.seq).toBeGreaterThanOrEqual(10); // ensure the lexical/numeric divergence is in play
    const lowId = await nodeIdOf(store, idOf(low));
    const highId = await nodeIdOf(store, idOf(high));
    await abandonTask(store, lowId);
    await abandonTask(store, highId);

    const res = await listNodes(store, { facets: [], scope: key, status: 'abandoned' });
    const ids = res.items.map((v) => v.id);
    expect(ids.indexOf(idOf(low))).toBeLessThan(ids.indexOf(idOf(high)));
  },
);

test.skipIf(!NORN)('next returns ready tasks in rank order, excluding awaiting/held', async () => {
  const a = await createTask(store, { parentId: phaseId, title: 'a' });
  const b = await createTask(store, { parentId: phaseId, title: 'b' });
  const c = await createTask(store, { parentId: phaseId, title: 'c' });
  const aId = await nodeIdOf(store, idOf(a));
  const bId = await nodeIdOf(store, idOf(b));
  const cId = await nodeIdOf(store, idOf(c));
  // b awaits a; c is blocked → only a and (later) others are ready
  await depend(store, bId, [aId]);
  await blockTask(store, cId, 'later');

  const res = await nextTasks(store, { scope: key });
  expect(res.items.map((n) => n.id)).toEqual([idOf(a)]);
  expect(res.total).toBe(1);
  expect(res.items[0]?.status).toBe('ready');

  // completing a unblocks b
  await completeTask(store, aId);
  const res2 = await nextTasks(store, { scope: key });
  expect(res2.items.map((n) => n.id)).toEqual([idOf(b)]);
});

test.skipIf(!NORN)('next respects priority filter and the limit', async () => {
  await createTask(store, { parentId: phaseId, priority: 'p2', title: 'p2' });
  const hi = await createTask(store, { parentId: phaseId, priority: 'p0', title: 'p0' });
  const onlyP0 = await nextTasks(store, { priority: 'p0', scope: key });
  expect(onlyP0.items.map((n) => n.id)).toEqual([idOf(hi)]);

  const limited = await nextTasks(store, { limit: 1, scope: key });
  expect(limited.returned).toBe(1);
  expect(limited.total).toBe(2); // total reflects the full ready set
});

test.skipIf(!NORN)(
  'a direct prerequisite surfaces in awaitingOn (no via) and clears when settled',
  async () => {
    const x = await createTask(store, { parentId: phaseId, title: 'x' });
    const y = await createTask(store, { parentId: phaseId, title: 'y' });
    const xId = await nodeIdOf(store, idOf(x));
    const yId = await nodeIdOf(store, idOf(y));
    await depend(store, yId, [xId]);

    const view = await getNode(store, idOf(y));
    expect(view.deps?.dependsOn.map((r) => r.id)).toEqual([idOf(x)]);
    expect(view.deps?.awaitingOn.map((r) => ({ id: r.id, via: r.via }))).toEqual([
      { id: idOf(x), via: undefined },
    ]);

    await completeTask(store, xId); // prerequisite terminal → gate clears
    expect((await getNode(store, idOf(y))).deps?.awaitingOn).toEqual([]);
  },
);

test.skipIf(!NORN)(
  'an inherited prerequisite surfaces in awaitingOn, tagged via the ancestor',
  async () => {
    const phase1 = await createPhase(store, { parentId: initId, title: 'phase 1' });
    const phase2 = await createPhase(store, { parentId: initId, title: 'phase 2' });
    const phase1Id = await nodeIdOf(store, idOf(phase1));
    const phase2Id = await nodeIdOf(store, idOf(phase2));
    await depend(store, phase2Id, [phase1Id]); // edge on the ancestor phase
    const t = await createTask(store, { parentId: phase2Id, title: 't' });

    const view = await getNode(store, idOf(t));
    expect(view.deps?.dependsOn).toEqual([]); // t declares nothing of its own
    expect(view.deps?.awaitingOn.map((r) => ({ id: r.id, via: r.via }))).toEqual([
      { id: idOf(phase1), via: idOf(phase2) }, // inherited from phase 2
    ]);
  },
);

test.skipIf(!NORN)(
  'awaitingOn lists a prereq reachable both directly and via an ancestor only once',
  async () => {
    const prereq = await createPhase(store, { parentId: initId, title: 'prereq phase' }); // empty → unsettled
    const prereqId = await nodeIdOf(store, idOf(prereq));
    const t = await createTask(store, { parentId: phaseId, title: 't' });
    const tId = await nodeIdOf(store, idOf(t));
    await depend(store, tId, [prereqId]); // direct edge
    await depend(store, phaseId, [prereqId]); // same prereq, now also inherited via the phase

    const awaitingOn = (await getNode(store, idOf(t))).deps?.awaitingOn ?? [];
    expect(awaitingOn.map((r) => ({ id: r.id, via: r.via }))).toEqual([
      { id: idOf(prereq), via: undefined }, // listed once, the direct entry wins
    ]);
  },
);

test.skipIf(!NORN)('get returns a full record with cheap facets and resolves KEY-seq', async () => {
  const a = await createTask(store, { parentId: phaseId, title: 'a' });
  const b = await createTask(store, { parentId: phaseId, title: 'b' });
  const aId = await nodeIdOf(store, idOf(a));
  const bId = await nodeIdOf(store, idOf(b));
  await depend(store, bId, [aId]);

  const view = await getNode(store, idOf(b));
  expect(view.id).toBe(idOf(b));
  expect(view.title).toBe('b');
  expect(view.lifecycle).toBe('todo');
  expect(view.deps?.dependsOn.map((r) => r.id)).toEqual([idOf(a)]);
  expect(view.tags).toEqual([]); // cheap facet present, empty
  expect(view.history).toBeUndefined(); // heavy facet opt-in
});

test.skipIf(!NORN)('get throws on a missing or malformed id', async () => {
  await expectReject(() => getNode(store, 'MMR-999'));
  await expectReject(() => getNode(store, 'not-an-id'));
});

test.skipIf(!NORN)('status_of returns label + distribution for a non-leaf', async () => {
  const t1 = await createTask(store, { parentId: phaseId, title: 't1' });
  await createTask(store, { parentId: phaseId, title: 't2' });
  const t1Id = await nodeIdOf(store, idOf(t1));
  await startTask(store, t1Id);

  const status = await statusOfNode(store, `${key}-${String(phaseSeq)}`);
  expect(status.status).toBe('in_progress');
  expect(status.distribution).toEqual({ in_progress: 1, ready: 1 });
});

// addressability (MMR-32): the full grammar on get/status

test.skipIf(!NORN)('get on a bare KEY returns the whole-project view', async () => {
  const t = await createTask(store, { parentId: phaseId, title: 't' });
  const tId = await nodeIdOf(store, idOf(t));
  await startTask(store, tId);

  const view = await getNode(store, key);
  expect(view.id).toBe(key);
  expect(view.type).toBe('project');
  expect(view.title).toBe('m');
  expect(view.status).toBe('in_progress'); // interpret over the root initiative
  expect(view.children?.length).toBe(1); // the root initiative
  expect(view.distribution).toEqual({ in_progress: 1 });
});

test.skipIf(!NORN)("status_of on a bare KEY rolls up the project's roots", async () => {
  const t = await createTask(store, { parentId: phaseId, title: 't' });
  const tId = await nodeIdOf(store, idOf(t));
  await startTask(store, tId);

  const status = await statusOfNode(store, key);
  expect(status.id).toBe(key);
  expect(status.status).toBe('in_progress');
  expect(status.distribution).toEqual({ in_progress: 1 });
});

test.skipIf(!NORN)('get on KEY-aN returns the artifact detail with rendered links', async () => {
  const t = await createTask(store, { parentId: phaseId, title: 't' });
  const tId = await nodeIdOf(store, idOf(t));
  const projectId = await projectIdOf(store, key);
  const { renderedId } = await attachArtifact(store, {
    content: '# frozen\n',
    linkNodeIds: [tId],
    projectId,
    title: 'frozen plan',
  });
  expect(renderedId).toBe(`${key}-a1`);

  const detail = await getArtifact(store, renderedId);
  expect(detail.id).toBe(`${key}-a1`);
  expect(detail.project).toBe(key);
  expect(detail.links).toEqual([idOf(t)]);
});

test.skipIf(!NORN)('status_of rejects an artifact id as a behavioral error', async () => {
  await expectReject(() => statusOfNode(store, `${key}-a1`));
});

test.skipIf(!NORN)('the node artifacts facet speaks KEY-aN', async () => {
  const t = await createTask(store, { parentId: phaseId, title: 't' });
  const tId = await nodeIdOf(store, idOf(t));
  const projectId = await projectIdOf(store, key);
  await attachArtifact(store, {
    content: 'x',
    linkNodeIds: [tId],
    projectId,
    title: 'x',
  });

  const view = await getNode(store, idOf(t));
  expect(view.artifacts?.map((a) => a.id)).toEqual([`${key}-a1`]);

  const projectView = await getNode(store, key, { facets: ['artifacts'] });
  expect(projectView.artifacts?.map((a) => a.id)).toEqual([`${key}-a1`]);
});

test.skipIf(!NORN)('list selects by status universe (MMR-33)', async () => {
  const a = await createTask(store, { parentId: phaseId, title: 'a' });
  const b = await createTask(store, { parentId: phaseId, title: 'b' });
  const aId = await nodeIdOf(store, idOf(a));
  const bId = await nodeIdOf(store, idOf(b));
  await blockTask(store, bId, 'x');

  const blocked = await listNodes(store, { scope: key, status: 'blocked' });
  expect(blocked.items.map((n) => n.id)).toEqual([idOf(b)]);

  const ready = await listNodes(store, { scope: key, status: 'ready' });
  expect(ready.items.map((n) => n.id)).toEqual([idOf(a)]);

  const live = await listNodes(store, { scope: key });
  expect(live.total).toBe(2); // live is the default universe

  await completeTask(store, aId);
  const terminal = await listNodes(store, { scope: key, status: 'terminal' });
  expect(terminal.items.map((n) => n.id)).toEqual([idOf(a)]);
  const all = await listNodes(store, { scope: key, status: 'all' });
  expect(all.total).toBe(2);
});

test.skipIf(!NORN)(
  'list filters by q — case-insensitive substring over title (MMR-78)',
  async () => {
    const auth = await createTask(store, { parentId: phaseId, title: 'Wire up AUTH gate' });
    await createTask(store, { parentId: phaseId, title: 'Polish the board' });

    const hit = await listNodes(store, { q: 'auth', scope: key });
    expect(hit.items.map((n) => n.id)).toEqual([idOf(auth)]);

    expect((await listNodes(store, { q: 'zzz', scope: key })).total).toBe(0);
    // an empty q is a no-op, not a match-nothing
    expect((await listNodes(store, { q: '', scope: key })).total).toBe(2);

    // LIKE parity: %/_ inside q act as wildcards, and a regex special is literal
    expect((await listNodes(store, { q: 'a_th', scope: key })).total).toBe(1);
    expect((await listNodes(store, { q: 'wire%gate', scope: key })).total).toBe(1);
    expect((await listNodes(store, { q: 'auth.', scope: key })).total).toBe(0);
  },
);

test.skipIf(!NORN)(
  'deps facet lists prerequisites in ascending id order regardless of edge insertion order',
  async () => {
    const older = await createTask(store, { parentId: phaseId, title: 'older prereq' });
    const newer = await createTask(store, { parentId: phaseId, title: 'newer prereq' });
    const dependent = await createTask(store, { parentId: phaseId, title: 'dependent' });
    const olderId = await nodeIdOf(store, idOf(older));
    const newerId = await nodeIdOf(store, idOf(newer));
    const dependentId = await nodeIdOf(store, idOf(dependent));
    // insert edges newest-first — the read path re-derives them id-ascending
    await depend(store, dependentId, [newerId, olderId]);

    const view = await getNode(store, idOf(dependent), { facets: ['deps'] });
    expect(view.deps?.dependsOn.map((r) => r.id)).toEqual([idOf(older), idOf(newer)]);
    expect(view.deps?.awaitingOn.map((r) => r.id)).toEqual([idOf(older), idOf(newer)]);
  },
);

test.skipIf(!NORN)('list q lowercasing is ASCII-only (non-ASCII case left untouched)', async () => {
  await createTask(store, { parentId: phaseId, title: 'Über refactor' });
  await createTask(store, { parentId: phaseId, title: 'über cleanup' });

  // ASCII case folds both ways; non-ASCII stays case-sensitive — LIKE parity.
  expect((await listNodes(store, { q: 'über', scope: key })).total).toBe(1);
  expect((await listNodes(store, { q: 'ÜBER', scope: key })).total).toBe(1);
  expect((await listNodes(store, { q: 'REFACTOR', scope: key })).total).toBe(1);
});

test.skipIf(!NORN)(
  'list q: the _ wildcard consumes one full code point, astral included (LIKE parity)',
  async () => {
    await createTask(store, { parentId: phaseId, title: 'a😀b' });

    expect((await listNodes(store, { q: 'a_b', scope: key })).total).toBe(1);
    expect((await listNodes(store, { q: 'a__b', scope: key })).total).toBe(0);
  },
);

test.skipIf(!NORN)('list applies verdicts and field operators within the universe', async () => {
  const a = await createTask(store, { parentId: phaseId, priority: 'p1', title: 'a' });
  const b = await createTask(store, { parentId: phaseId, priority: 'p2', title: 'b' });
  const aId = await nodeIdOf(store, idOf(a));
  const bId = await nodeIdOf(store, idOf(b));
  await depend(store, bId, [aId]); // a blocks b

  const blocking = await listNodes(store, {
    scope: key,
    verdicts: [{ negate: false, verdict: 'blocking' }],
  });
  expect(blocking.items.map((n) => n.id)).toEqual([idOf(a)]);

  const notBlocking = await listNodes(store, {
    scope: key,
    verdicts: [{ negate: true, verdict: 'blocking' }],
  });
  expect(notBlocking.items.map((n) => n.id)).toEqual([idOf(b)]);

  const p2 = await listNodes(store, {
    filters: [{ field: 'priority', op: 'eq', value: 'p2' }],
    scope: key,
  });
  expect(p2.items.map((n) => n.id)).toEqual([idOf(b)]);
});

test.skipIf(!NORN)('a value fault returns an empty set with warnings, not an error', async () => {
  await createTask(store, { parentId: phaseId, priority: 'p1', title: 'a' });
  const res = await listNodes(store, {
    filters: [{ field: 'priority', op: 'eq', value: 'p9' }],
    scope: key,
  });
  expect(res.total).toBe(0);
  expect(res.items).toEqual([]);
  expect(res.warnings?.[0]?.code).toBe('no_match_value');
  expect(res.warnings?.[0]?.expected).toEqual(['p0', 'p1', 'p2', 'p3']);
});

test.skipIf(!NORN)('upstream filters at parity with external_ref (MMR-265)', async () => {
  const a = await createTask(store, { parentId: phaseId, title: 'a', upstream: 'MMR-s6' });
  await createTask(store, { parentId: phaseId, title: 'b' });

  const match = await listNodes(store, {
    filters: [{ field: 'upstream', op: 'eq', value: 'MMR-s6' }],
    scope: key,
  });
  expect(match.items.map((n) => n.id)).toEqual([idOf(a)]);

  const noMatch = await listNodes(store, {
    filters: [{ field: 'upstream', op: 'eq', value: 'MMR-s7' }],
    scope: key,
  });
  expect(noMatch.items).toEqual([]);
});

test.skipIf(!NORN)('a type filter widens list beyond tasks', async () => {
  await createTask(store, { parentId: phaseId, title: 'a' });
  const phases = await listNodes(store, {
    filters: [{ field: 'type', op: 'eq', value: 'phase' }],
    scope: key,
  });
  expect(phases.items.map((n) => n.type)).toEqual(['phase']);
});

test.skipIf(!NORN)('terminal universe orders by completed_at desc', async () => {
  const a = await createTask(store, { parentId: phaseId, title: 'a' });
  const b = await createTask(store, { parentId: phaseId, title: 'b' });
  const aId = await nodeIdOf(store, idOf(a));
  const bId = await nodeIdOf(store, idOf(b));
  await completeTask(store, aId);
  await completeTask(store, bId);
  // pin distinct completion instants (same-ms completions would tie)
  await store.transact(async (w) => {
    await w.updateNode(aId, { completed_at: '2026-06-01T00:00:00.000Z' });
    await w.updateNode(bId, { completed_at: '2026-06-02T00:00:00.000Z' });
  });
  const done = await listNodes(store, { scope: key, status: 'done' });
  expect(done.items.map((n) => n.id)).toEqual([idOf(b), idOf(a)]);
});

test.skipIf(!NORN)("the tag pseudo-field filters via the node's tag set", async () => {
  const a = await createTask(store, { parentId: phaseId, tags: ['spec'], title: 'a' });
  await createTask(store, { parentId: phaseId, title: 'b' });
  const tagged = await listNodes(store, {
    filters: [{ field: 'tag', op: 'eq', value: 'spec' }],
    scope: key,
  });
  expect(tagged.items.map((n) => n.id)).toEqual([idOf(a)]);
  const untagged = await listNodes(store, {
    filters: [{ field: 'tag', op: 'missing', value: null }],
    scope: key,
  });
  expect(untagged.items.map((n) => n.title)).toEqual(['b']);
});

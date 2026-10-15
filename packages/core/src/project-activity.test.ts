import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';

import { createInitiative, createProject, createTask } from './create';
import { annotate, archiveProject, startTask, updateNode } from './mutations';
import type { Store } from './store';
import type { Instance } from './testing/conformance';
import { backends, scratchpad } from './testing/conformance';

/**
 * `Store.loadProjectActivity` (MMR-494) on every backend: each project's newest
 * stamp across its own row, nodes, transitions, annotations, seeds, artifacts,
 * and scratchpads — and an event in one project never moves another's.
 */

setDefaultTimeout(60_000);

/** Far-future stamps, so a directly-written row is unambiguously the newest. */
const LATER = '2098-01-01T00:00:00.000Z';
const LATEST = '2099-01-01T00:00:00.000Z';

/** Step past the current millisecond so a re-stamp is observably later. */
async function nextTick(): Promise<void> {
  await Bun.sleep(2);
}

type World = { mmrTask: string; opsTask: string };

/** Two projects, each with one task; every row is stamped at about "now". */
async function world(store: Store): Promise<World> {
  await createProject(store, { description: null, key: 'MMR', name: 'Mimir' });
  await createProject(store, { description: null, key: 'OPS', name: 'Operations' });
  const mmrInitiative = await createInitiative(store, { projectId: 'MMR', title: 'Work' });
  const opsInitiative = await createInitiative(store, { projectId: 'OPS', title: 'Work' });
  const mmrTask = await createTask(store, { parentId: mmrInitiative.id, title: 'One' });
  const opsTask = await createTask(store, { parentId: opsInitiative.id, title: 'Two' });
  return { mmrTask: mmrTask.id, opsTask: opsTask.id };
}

async function activity(store: Store): Promise<{ MMR?: string; OPS?: string }> {
  const map = await store.loadProjectActivity();
  return { MMR: map.get('MMR'), OPS: map.get('OPS') };
}

// oxlint-disable-next-line vitest/prefer-each
for (const backend of backends) {
  const instances: Instance[] = [];
  const fresh = async (): Promise<Store> => {
    const instance = await backend.make();
    instances.push(instance);
    return instance.store;
  };
  afterEach(async () => {
    while (instances.length > 0) {
      await instances.pop()?.close();
    }
  });
  const it = (name: string, body: () => Promise<void>): void => {
    test(`${backend.name}: ${name}`, body);
  };

  it('a project with no children reports its own updated_at', async () => {
    const store = await fresh();
    const project = await createProject(store, { description: null, key: 'MMR', name: 'Mimir' });
    expect((await store.loadProjectActivity()).get('MMR')).toBe(project.updated_at);
  });

  it('reports every project, archived included', async () => {
    const store = await fresh();
    await world(store);
    await archiveProject(store, 'OPS');
    expect([...(await store.loadProjectActivity()).keys()].toSorted()).toEqual(['MMR', 'OPS']);
  });

  it('a task update moves its project and not another', async () => {
    const store = await fresh();
    const { mmrTask } = await world(store);
    const before = await activity(store);
    await nextTick();
    await updateNode(store, mmrTask, { title: 'Renamed' });
    const after = await activity(store);
    expect((after.MMR ?? '') > (before.MMR ?? '')).toBe(true);
    expect(after.OPS).toBe(before.OPS);
  });

  it('a task transition moves its project and not another', async () => {
    const store = await fresh();
    const { mmrTask } = await world(store);
    const before = await activity(store);
    await nextTick();
    await startTask(store, mmrTask);
    const after = await activity(store);
    expect((after.MMR ?? '') > (before.MMR ?? '')).toBe(true);
    expect(after.OPS).toBe(before.OPS);
  });

  it('a transition-log entry alone moves the node-owning project', async () => {
    const store = await fresh();
    const { mmrTask } = await world(store);
    const before = await activity(store);
    await store.transact((w) =>
      w.appendTransition({
        at: LATER,
        from_value: 'a',
        kind: 'lifecycle',
        node_id: mmrTask,
        to_value: 'b',
      }),
    );
    expect(await activity(store)).toEqual({ MMR: LATER, OPS: before.OPS });
  });

  it('a project-level transition-log entry moves that project', async () => {
    const store = await fresh();
    await world(store);
    const before = await activity(store);
    await store.transact((w) =>
      w.appendTransition({
        at: LATER,
        from_value: 'active',
        kind: 'archive',
        project_id: 'OPS',
        to_value: 'archived',
      }),
    );
    expect(await activity(store)).toEqual({ MMR: before.MMR, OPS: LATER });
  });

  it('an annotation alone moves the node-owning project', async () => {
    const store = await fresh();
    const { opsTask } = await world(store);
    const before = await activity(store);
    await store.transact((w) =>
      w.insertAnnotation({ content: 'note', created_at: LATER, node_id: opsTask }),
    );
    expect(await activity(store)).toEqual({ MMR: before.MMR, OPS: LATER });
  });

  it('annotating through the verb moves its project and not another', async () => {
    const store = await fresh();
    const { mmrTask } = await world(store);
    const before = await activity(store);
    await nextTick();
    await annotate(store, mmrTask, 'progress');
    const after = await activity(store);
    expect((after.MMR ?? '') > (before.MMR ?? '')).toBe(true);
    expect(after.OPS).toBe(before.OPS);
  });

  it('a seed moves its project and not another, on create and on transition', async () => {
    const store = await fresh();
    await world(store);
    const before = await activity(store);
    await nextTick();
    const seed = await store.seeds.create({
      description: null,
      key: 'OPS',
      kind: 'idea',
      requester: null,
      title: 'Cutover',
    });
    const created = await activity(store);
    expect(created).toEqual({ MMR: before.MMR, OPS: seed.updated_at });

    await nextTick();
    await store.seeds.transition(seed.key, seed.seq, 'resolved', 'already fixed');
    const resolved = await activity(store);
    expect((resolved.OPS ?? '') > (created.OPS ?? '')).toBe(true);
    expect(resolved.MMR).toBe(before.MMR);
  });

  it('an artifact moves its project and not another', async () => {
    const store = await fresh();
    await world(store);
    const before = await activity(store);
    await nextTick();
    const artifact = await store.artifacts.create({
      content: 'body',
      key: 'MMR',
      links: [],
      tags: [],
      title: 'Spec',
    });
    expect(await activity(store)).toEqual({ MMR: artifact.updated_at, OPS: before.OPS });
  });

  it('a scratchpad alone moves its project and not another', async () => {
    const store = await fresh();
    const { mmrTask } = await world(store);
    const before = await activity(store);
    await store.scratchpads.create(scratchpad(mmrTask, { updatedAt: LATER }));
    expect(await activity(store)).toEqual({ MMR: LATER, OPS: before.OPS });
  });

  it('filtered by project key, reports just those projects', async () => {
    const store = await fresh();
    await world(store);
    const all = await store.loadProjectActivity();
    const one = await store.loadProjectActivity(['OPS']);
    expect([...one.keys()]).toEqual(['OPS']);
    expect(one.get('OPS')).toBe(all.get('OPS'));
    expect((await store.loadProjectActivity([])).size).toBe(0);
    expect((await store.loadProjectActivity(['NOPE'])).size).toBe(0);
  });

  it('filtered reads still take the newest across sources', async () => {
    const store = await fresh();
    const { opsTask } = await world(store);
    await store.transact((w) =>
      w.insertAnnotation({ content: 'note', created_at: LATER, node_id: opsTask }),
    );
    expect([...(await store.loadProjectActivity(['OPS']))]).toEqual([['OPS', LATER]]);
  });

  it('is the newest across sources', async () => {
    const store = await fresh();
    const { mmrTask } = await world(store);
    await store.transact((w) =>
      w.insertAnnotation({ content: 'note', created_at: LATER, node_id: mmrTask }),
    );
    await store.transact((w) =>
      w.appendTransition({
        at: LATEST,
        from_value: 'a',
        kind: 'lifecycle',
        node_id: mmrTask,
        to_value: 'b',
      }),
    );
    expect((await store.loadProjectActivity()).get('MMR')).toBe(LATEST);
  });
}

import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';

import type { Instance } from '../testing/conformance';
import { backends, errorOf, scratchpad } from '../testing/conformance';
import { createInitiative, createPhase, createProject, createTask } from './create';
import type { Node, Project } from './model';
import {
  annotate,
  archiveProject,
  depend,
  reorder,
  startTask,
  submitTask,
  tagEntities,
  untagEntities,
  updateNode,
  updateProject,
} from './mutations';
import type { Store } from './store';
import { now } from './time';

/**
 * The `Store`-seam write-surface sweep (MMR-379, ADR 0030) — the second half of
 * the conformance oracle. The export/import suite proves a whole store survives
 * a round trip; this proves each individual write behaves the same on every
 * backend: what it allocates, what it stamps, what it echoes, and exactly which
 * refusal it raises.
 *
 * Each case states ONE intended behavior and drives it through the real verb
 * where a verb exists — that is the path that stamps and guards — falling back
 * to `store.transact` only for the primitives no verb reaches.
 *
 * The backend table lives in `testing/conformance.ts`: a new backend joins this
 * sweep by adding a row there. The Norn arm needs a real `norn` binary and is
 * skipped when it is off PATH.
 */

// Every case builds a whole temp vault over a `norn mcp` subprocess, which runs
// well past bun's 5s default on a loaded runner.
setDefaultTimeout(60_000);

/** A second UUIDv4 handle, for the scratchpad ordering cases. */
const PAD_ID_B = '223e4567-e89b-42d3-a456-426614174001';

type Base = { initiative: Node; phase: Node; first: Node; second: Node; project: Project };

/** The smallest hierarchy the write cases mutate: one project, one lineage, two tasks. */
async function base(store: Store): Promise<Base> {
  const project = await createProject(store, {
    description: 'the work-state tool',
    key: 'MMR',
    name: 'Mimir',
  });
  const initiative = await createInitiative(store, { projectId: 'MMR', title: 'Shared store' });
  const phase = await createPhase(store, { parentId: initiative.id, title: 'Phase A' });
  const first = await createTask(store, { parentId: phase.id, title: 'Export' });
  const second = await createTask(store, { parentId: phase.id, title: 'Import' });
  return { first, initiative, phase, project, second };
}

/** One node's row as the working set reads it back. */
async function reloadNode(store: Store, id: string): Promise<Node> {
  const node = (await store.loadWorkingSet()).nodes.find((n) => n.id === id);
  if (node === undefined) {
    throw new Error(`no node ${id}`);
  }
  return node;
}

/** One project's row as the working set reads it back. */
async function reloadProject(store: Store, key: string): Promise<Project> {
  const project = (await store.loadProjects()).find((p) => p.key === key);
  if (project === undefined) {
    throw new Error(`no project ${key}`);
  }
  return project;
}

/** Step past the current millisecond so a store-stamped `updated_at` is
 * observably later than the record's `created_at`; the PGlite arm can create
 * and re-stamp within one tick. */
async function nextTick(): Promise<void> {
  await Bun.sleep(2);
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
    test.skipIf(backend.skip)(`${backend.name}: ${name}`, body);
  };

  // ── writer: projects and nodes ───────────────────────────────────────────

  it('insertProject stamps created_at and updated_at to the same instant', async () => {
    const store = await fresh();
    const project = await createProject(store, { description: 'd', key: 'MMR', name: 'Mimir' });
    expect(project).toMatchObject({ archived_at: null, description: 'd', key: 'MMR' });
    expect(project.created_at).toBe(project.updated_at);
    expect(await reloadProject(store, 'MMR')).toEqual(project);
  });

  it('a project key already taken is a conflict', async () => {
    const store = await fresh();
    await createProject(store, { description: null, key: 'MMR', name: 'Mimir' });
    const error = await errorOf(
      createProject(store, { description: null, key: 'MMR', name: 'Again' }),
    );
    expect(error.code).toBe('conflict');
    expect(error.message).toContain('MMR');
  });

  it('insertNode allocates a per-project seq and shapes the id as KEY-seq', async () => {
    const store = await fresh();
    const { first, initiative, phase, second } = await base(store);
    expect([initiative.seq, phase.seq, first.seq, second.seq]).toEqual([1, 2, 3, 4]);
    expect([initiative.id, phase.id, first.id, second.id]).toEqual([
      'MMR-1',
      'MMR-2',
      'MMR-3',
      'MMR-4',
    ]);

    // The counter is the PROJECT's, not the store's.
    await createProject(store, { description: null, key: 'OPS', name: 'Operations' });
    const other = await createInitiative(store, { projectId: 'OPS', title: 'Elsewhere' });
    expect(other.id).toBe('OPS-1');
  });

  it('insertNode stamps created_at and updated_at to the same instant', async () => {
    const store = await fresh();
    const { first } = await base(store);
    expect(first.created_at).toBe(first.updated_at);
  });

  it('insertNode dedupes the tags it writes', async () => {
    const store = await fresh();
    const { phase } = await base(store);
    const task = await createTask(store, {
      parentId: phase.id,
      tags: ['api', 'api', 'core'],
      title: 'Tagged',
    });
    const tags = (await store.loadWorkingSet()).nodeTags.get(task.id) ?? [];
    expect(tags.map((t) => t.tag).toSorted()).toEqual(['api', 'core']);
  });

  it('a node description is null in the working set and read through bodySections', async () => {
    const store = await fresh();
    const { phase } = await base(store);
    const task = await createTask(store, {
      description: 'export first',
      parentId: phase.id,
      title: 'Described',
    });
    expect(await reloadNode(store, task.id)).toMatchObject({ description: null });
    expect(await store.bodySections.readDescription(task.id)).toBe('export first');
  });

  it('updateNode lands the patch and refuses an unknown id', async () => {
    const store = await fresh();
    const { first } = await base(store);
    const updated = await updateNode(store, first.id, { summary: 'the export', title: 'Exported' });
    expect(updated).toMatchObject({ summary: 'the export', title: 'Exported' });
    expect(updated.updated_at > first.updated_at).toBe(true);

    const error = await errorOf(updateNode(store, 'MMR-99', { title: 'nope' }));
    expect(error.code).toBe('not_found');
    expect(error.message).toContain('MMR-99');
  });

  it('updateProject lands the patch and refuses an unknown key', async () => {
    const store = await fresh();
    await base(store);
    const updated = await updateProject(store, 'MMR', { description: null, name: 'Renamed' });
    expect(updated).toMatchObject({ description: null, name: 'Renamed' });

    const error = await errorOf(updateProject(store, 'XYZ', { name: 'nope' }));
    expect(error.code).toBe('not_found');
    expect(error.message).toContain('XYZ');
  });

  it('insertDependency is idempotent and deleteDependency reports what it removed', async () => {
    const store = await fresh();
    const { first, second } = await base(store);
    const edge = { depends_on_node_id: first.id, node_id: second.id };

    await store.transact(async (w) => {
      await w.insertDependency(edge);
      await w.insertDependency(edge);
      await w.updateNode(second.id, { updated_at: now() });
    });
    expect((await store.loadWorkingSet()).edges).toEqual([edge]);

    const removals = await store.transact(async (w) => {
      const gone = [await w.deleteDependency(edge), await w.deleteDependency(edge)];
      await w.updateNode(second.id, { updated_at: now() });
      return gone;
    });
    expect(removals).toEqual([true, false]);
    expect((await store.loadWorkingSet()).edges).toEqual([]);
  });

  it('insertAnnotation keeps insertion order', async () => {
    const store = await fresh();
    const { first } = await base(store);
    await annotate(store, first.id, 'first note');
    await annotate(store, first.id, 'second note');
    const annotations = await store.bodySections.readAnnotations(first.id);
    expect(annotations.map((a) => a.content)).toEqual(['first note', 'second note']);
    expect(annotations.every((a) => a.createdAt !== '')).toBe(true);
  });

  it('setNextSection writes the narrative and clears it', async () => {
    const store = await fresh();
    const { initiative } = await base(store);
    await updateNode(store, initiative.id, { next: 'land the export' });
    expect(await store.bodySections.readNext(initiative.id)).toEqual({
      ambiguous: false,
      insertAnchors: 1,
      present: true,
      text: 'land the export',
    });

    await updateNode(store, initiative.id, { next: null });
    expect(await store.bodySections.readNext(initiative.id)).toMatchObject({
      present: false,
      text: null,
    });
  });

  it('readNextSection sees a ## Next written earlier in the same transact', async () => {
    const store = await fresh();
    const { initiative } = await base(store);
    // The write-side probe reads the TRANSACTION's state, not the committed
    // store: `applyNextSection` takes it before every re-authoring, so a second
    // re-authoring inside one transact must see the first one's prose. The two
    // writes then coalesce into the one section the document ends up carrying.
    const seen = await store.transact(async (w) => {
      const before = await w.readNextSection('node', initiative.id);
      await w.setNextSection('node', initiative.id, { text: 'first' });
      const after = await w.readNextSection('node', initiative.id);
      await w.setNextSection('node', initiative.id, { text: 'second' });
      const last = await w.readNextSection('node', initiative.id);
      await w.updateNode(initiative.id, { updated_at: now() });
      return { after, before, last };
    });
    expect(seen.before).toMatchObject({ ambiguous: false, present: false, text: null });
    expect(seen.after).toMatchObject({ ambiguous: false, present: true, text: 'first' });
    expect(seen.last).toMatchObject({ ambiguous: false, present: true, text: 'second' });
    expect(await store.bodySections.readNext(initiative.id)).toMatchObject({
      present: true,
      text: 'second',
    });
  });

  it('a ## Next written then cleared in one transact leaves no section', async () => {
    const store = await fresh();
    const { initiative } = await base(store);
    await updateNode(store, initiative.id, { next: 'land the export' });
    // Both queued writes reduce to ONE op against the document as the transact
    // found it: it HAD the heading, so the clear deletes it — the intermediate
    // write is not a state the document ever reaches.
    const seen = await store.transact(async (w) => {
      const before = await w.readNextSection('node', initiative.id);
      await w.setNextSection('node', initiative.id, { text: 'redraft' });
      const after = await w.readNextSection('node', initiative.id);
      await w.setNextSection('node', initiative.id, { text: null });
      await w.updateNode(initiative.id, { updated_at: now() });
      return { after, before };
    });
    expect(seen.before).toMatchObject({ present: true, text: 'land the export' });
    expect(seen.after).toMatchObject({ present: true, text: 'redraft' });
    expect(await store.bodySections.readNext(initiative.id)).toMatchObject({
      present: false,
      text: null,
    });
  });

  it('a ## Next written then cleared leaves a section-less document untouched', async () => {
    const store = await fresh();
    const { phase } = await base(store);
    // The mirror of the case above: the document had NO heading, so the pair of
    // writes reduces to no op at all — not a delete against a heading that was
    // never there.
    const seen = await store.transact(async (w) => {
      const before = await w.readNextSection('node', phase.id);
      await w.setNextSection('node', phase.id, { text: 'redraft' });
      const after = await w.readNextSection('node', phase.id);
      await w.setNextSection('node', phase.id, { text: null });
      await w.updateNode(phase.id, { updated_at: now() });
      return { after, before };
    });
    expect(seen.before).toMatchObject({ present: false, text: null });
    expect(seen.after).toMatchObject({ present: true, text: 'redraft' });
    expect(await store.bodySections.readNext(phase.id)).toMatchObject({
      present: false,
      text: null,
    });
  });

  it('a ## Next write against an unknown record is an invariant breach', async () => {
    const store = await fresh();
    await base(store);
    const error = await errorOf(
      store.transact((w) => w.setNextSection('node', 'MMR-99', { text: 'x' })),
    );
    expect(error.code).toBe('invariant');
    expect(error.message).toContain('## Next');
  });

  it('insertTag reports whether the tag was newly applied', async () => {
    const store = await fresh();
    const { first } = await base(store);
    const applied = await store.transact(async (w) => {
      const results = [
        await w.insertTag({ entity_id: first.id, entity_type: 'node', tag: 'api' }),
        await w.insertTag({ entity_id: first.id, entity_type: 'node', tag: 'api' }),
      ];
      await w.updateNode(first.id, { updated_at: now() });
      return results;
    });
    expect(applied).toEqual([true, false]);
    expect(((await store.loadWorkingSet()).nodeTags.get(first.id) ?? []).map((t) => t.tag)).toEqual(
      ['api'],
    );
  });

  it('deleteTags returns how many tags it removed', async () => {
    const store = await fresh();
    const { first } = await base(store);
    await tagEntities(store, [{ entityId: first.id, entityType: 'node' }], ['api', 'urgent']);
    const removed = await store.transact(async (w) => {
      const count = await w.deleteTags('node', first.id, ['api', 'absent']);
      await w.updateNode(first.id, { updated_at: now() });
      return count;
    });
    expect(removed).toBe(1);
    expect(((await store.loadWorkingSet()).nodeTags.get(first.id) ?? []).map((t) => t.tag)).toEqual(
      ['urgent'],
    );
  });

  it('untagEntities leaves an untouched tag in place', async () => {
    const store = await fresh();
    const { first } = await base(store);
    await tagEntities(store, [{ entityId: first.id, entityType: 'node' }], ['api', 'urgent']);
    await untagEntities(store, [{ entityId: first.id, entityType: 'node' }], ['api']);
    expect(((await store.loadWorkingSet()).nodeTags.get(first.id) ?? []).map((t) => t.tag)).toEqual(
      ['urgent'],
    );
  });

  it('appendTransition echoes the resume handles onto the history row', async () => {
    const store = await fresh();
    const { first } = await base(store);
    await startTask(store, first.id, { branch: 'feat/export', host: 'workbench' });
    await submitTask(store, first.id);

    const history = await store.bodySections.readHistory(first.id);
    expect(history.map((e) => [e.kind, e.from, e.to])).toEqual([
      ['lifecycle', 'todo', 'in_progress'],
      ['lifecycle', 'in_progress', 'under_review'],
    ]);
    expect(history[0]?.handles).toEqual({ branch: 'feat/export', host: 'workbench' });
    expect(history[1]?.handles).toBeUndefined();
  });

  it('a transition against an unknown node is an invariant breach', async () => {
    const store = await fresh();
    await base(store);
    const error = await errorOf(
      store.transact((w) =>
        w.appendTransition({
          at: now(),
          from_value: 'todo',
          kind: 'lifecycle',
          node_id: 'MMR-99',
          to_value: 'in_progress',
        }),
      ),
    );
    expect(error.code).toBe('invariant');
  });

  // ── writer: point reads and ordering ─────────────────────────────────────

  it('listChildren yields the direct children only', async () => {
    const store = await fresh();
    const { first, initiative, phase, second } = await base(store);
    const seen = await store.transact(async (w) => ({
      initiative: await w.listChildren(initiative.id),
      phase: await w.listChildren(phase.id),
      task: await w.listChildren(first.id),
    }));
    expect(seen).toEqual({ initiative: [phase.id], phase: [first.id, second.id], task: [] });
  });

  it('listPrereqsOf yields the prerequisites of one node', async () => {
    const store = await fresh();
    const { first, phase, second } = await base(store);
    const third = await createTask(store, { parentId: phase.id, title: 'Third' });
    await depend(store, second.id, [first.id, third.id]);
    const prereqs = await store.transact((w) => w.listPrereqsOf(second.id));
    expect(prereqs.toSorted()).toEqual([first.id, third.id]);
    expect(await store.transact((w) => w.listPrereqsOf(first.id))).toEqual([]);
  });

  it('listRankedTasks orders by rank then seq', async () => {
    const store = await fresh();
    const { first, phase, second } = await base(store);
    const third = await createTask(store, { parentId: phase.id, title: 'Third' });
    // `reorder` puts the third task at the top; rank decides, seq only tiebreaks.
    await reorder(store, third.id, 'top');
    const ranked = await store.transact((w) => w.listRankedTasks('MMR'));
    expect(ranked.map((r) => r.id)).toEqual([third.id, first.id, second.id]);
    expect(ranked.map((r) => r.seq)).toEqual([third.seq, first.seq, second.seq]);
  });

  it('a throw inside transact persists nothing', async () => {
    const store = await fresh();
    const { phase } = await base(store);
    const before = await store.loadWorkingSet();
    let thrown: unknown;
    try {
      await store.transact(async (w) => {
        await w.insertNode({
          description: null,
          parent_id: phase.id,
          project_id: 'MMR',
          title: 'Rolled back',
          type: 'task',
        });
        throw new Error('deliberate');
      });
    } catch (error) {
      thrown = error;
    }
    // The verb's own error propagates unchanged — the store never rewraps it.
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('deliberate');
    const after = await store.loadWorkingSet();
    expect(after.nodes.map((n) => n.id)).toEqual(before.nodes.map((n) => n.id));
  });

  // ── store: bulk reads ────────────────────────────────────────────────────

  it('loadProjects yields every project in key order, archived included', async () => {
    const store = await fresh();
    await createProject(store, { description: null, key: 'OPS', name: 'Operations' });
    await createProject(store, { description: null, key: 'MMR', name: 'Mimir' });
    await archiveProject(store, 'OPS');
    const projects = await store.loadProjects();
    expect(projects.map((p) => p.key)).toEqual(['MMR', 'OPS']);
    expect(projects[1]?.archived_at).not.toBeNull();
  });

  it('loadNodesForProjects reads no nodes for an empty key list', async () => {
    const store = await fresh();
    await base(store);
    expect(await store.loadNodesForProjects([], new Set(['MMR']))).toEqual([]);
  });

  it('loadNodesForProjects drops a key absent from the valid set', async () => {
    const store = await fresh();
    await base(store);
    expect((await store.loadNodesForProjects(['MMR'], new Set(['MMR']))).length).toBe(4);
    expect(await store.loadNodesForProjects(['MMR'], new Set())).toEqual([]);
  });

  // ── artifacts ────────────────────────────────────────────────────────────

  it('artifacts.create allocates a per-project KEY-aN and stamps one instant', async () => {
    const store = await fresh();
    await base(store);
    const first = await store.artifacts.create({
      content: 'one',
      key: 'MMR',
      links: [],
      tags: [],
      title: 'First',
    });
    const second = await store.artifacts.create({
      content: 'two',
      key: 'MMR',
      links: [],
      tags: [],
      title: 'Second',
    });
    expect([first.seq, second.seq]).toEqual([1, 2]);
    expect(first.key).toBe('MMR');
    expect(first.created_at).toBe(first.updated_at);
  });

  it('artifacts.create strips exactly one trailing newline and sorts its links', async () => {
    const store = await fresh();
    const { first, second } = await base(store);
    const created = await store.artifacts.create({
      content: '# spec\n\nbody\n',
      key: 'MMR',
      links: [second.id, first.id],
      summary: 'the lede',
      tags: ['spec'],
      title: 'Spec',
    });
    expect(created.content).toBe('# spec\n\nbody');
    expect(created.links).toEqual([first.id, second.id]);
    const loaded = await store.artifacts.load('MMR', created.seq, { content: true });
    expect(loaded).toEqual(created);
  });

  it('artifacts.load yields undefined for an absent artifact', async () => {
    const store = await fresh();
    await base(store);
    expect(await store.artifacts.load('MMR', 7)).toBeUndefined();
  });

  it('artifacts.list pages newest-first and totals before the page', async () => {
    const store = await fresh();
    await base(store);
    for (const title of ['One', 'Two', 'Three']) {
      await store.artifacts.create({ content: title, key: 'MMR', links: [], tags: [], title });
    }
    const all = await store.artifacts.list({});
    expect(all.total).toBe(3);
    expect(all.items.map((a) => a.title)).toEqual(['Three', 'Two', 'One']);

    const page = await store.artifacts.list({ limit: 1, offset: 1 });
    expect(page.total).toBe(3);
    expect(page.items.map((a) => a.title)).toEqual(['Two']);
  });

  it('artifacts.list filters by project, tag, and excluded projects', async () => {
    const store = await fresh();
    await base(store);
    await createProject(store, { description: null, key: 'OPS', name: 'Operations' });
    await store.artifacts.create({
      content: 'a',
      key: 'MMR',
      links: [],
      tags: ['spec'],
      title: 'Tagged',
    });
    await store.artifacts.create({
      content: 'b',
      key: 'OPS',
      links: [],
      tags: [],
      title: 'Elsewhere',
    });
    expect((await store.artifacts.list({ project: 'MMR' })).items.map((a) => a.title)).toEqual([
      'Tagged',
    ]);
    expect((await store.artifacts.list({ tag: 'spec' })).items.map((a) => a.title)).toEqual([
      'Tagged',
    ]);
    expect(
      (await store.artifacts.list({ excludeProjects: ['OPS'] })).items.map((a) => a.title),
    ).toEqual(['Tagged']);
  });

  it('artifacts.list matches q against the title only, case-insensitively', async () => {
    const store = await fresh();
    await base(store);
    await store.artifacts.create({
      content: 'the needle lives in the body',
      key: 'MMR',
      links: [],
      tags: [],
      title: 'Transfer SPEC',
    });
    expect((await store.artifacts.list({ q: 'spec' })).items.map((a) => a.title)).toEqual([
      'Transfer SPEC',
    ]);
    expect((await store.artifacts.list({ q: 'needle' })).items).toEqual([]);
  });

  it('artifacts.listForNode and listForProject order by seq', async () => {
    const store = await fresh();
    const { first } = await base(store);
    for (const title of ['One', 'Two']) {
      await store.artifacts.create({
        content: title,
        key: 'MMR',
        links: [first.id],
        tags: [],
        title,
      });
    }
    expect((await store.artifacts.listForNode(first.id)).map((a) => a.seq)).toEqual([1, 2]);
    expect((await store.artifacts.listForProject('MMR')).map((a) => a.seq)).toEqual([1, 2]);
  });

  it('artifacts.applyTag stamps only when the tag set changes', async () => {
    const store = await fresh();
    await base(store);
    const created = await store.artifacts.create({
      content: 'a',
      key: 'MMR',
      links: [],
      tags: [],
      title: 'Taggable',
    });
    await nextTick();
    await store.artifacts.applyTag('MMR', created.seq, 'spec');
    const tagged = await store.artifacts.load('MMR', created.seq);
    expect(tagged?.tags).toEqual(['spec']);
    expect(tagged?.updated_at).not.toBe(created.updated_at);

    await store.artifacts.applyTag('MMR', created.seq, 'spec');
    expect((await store.artifacts.load('MMR', created.seq))?.updated_at).toBe(tagged?.updated_at);
  });

  it('artifacts.removeTags returns the count removed and stamps only on a change', async () => {
    const store = await fresh();
    await base(store);
    const created = await store.artifacts.create({
      content: 'a',
      key: 'MMR',
      links: [],
      tags: ['spec', 'draft'],
      title: 'Taggable',
    });
    await nextTick();
    expect(await store.artifacts.removeTags('MMR', created.seq, ['spec', 'absent'])).toBe(1);
    const after = await store.artifacts.load('MMR', created.seq);
    expect(after?.tags).toEqual(['draft']);
    expect(after?.updated_at).not.toBe(created.updated_at);

    expect(await store.artifacts.removeTags('MMR', created.seq, ['absent'])).toBe(0);
    expect((await store.artifacts.load('MMR', created.seq))?.updated_at).toBe(after?.updated_at);
  });

  it('artifacts.updateMetadata reports presence, and a null summary clears', async () => {
    const store = await fresh();
    await base(store);
    expect(await store.artifacts.updateMetadata('MMR', 9, { title: 'nope' })).toBe(false);

    const created = await store.artifacts.create({
      content: 'a',
      key: 'MMR',
      links: [],
      summary: 'the lede',
      tags: [],
      title: 'Patchable',
    });
    expect(await store.artifacts.updateMetadata('MMR', created.seq, { title: 'Patched' })).toBe(
      true,
    );
    expect((await store.artifacts.load('MMR', created.seq))?.title).toBe('Patched');

    expect(await store.artifacts.updateMetadata('MMR', created.seq, { summary: null })).toBe(true);
    const cleared = await store.artifacts.load('MMR', created.seq);
    expect(cleared?.summary).toBeNull();

    // A patch that changes nothing still reports presence, and writes nothing.
    expect(await store.artifacts.updateMetadata('MMR', created.seq, { summary: null })).toBe(true);
    expect((await store.artifacts.load('MMR', created.seq))?.updated_at).toBe(cleared?.updated_at);
  });

  it('artifacts.findBySourceScratch recovers the one artifact a freeze produced', async () => {
    const store = await fresh();
    await base(store);
    expect(await store.artifacts.findBySourceScratch(PAD_ID_B)).toBeUndefined();

    const created = await store.artifacts.create({
      content: 'frozen',
      key: 'MMR',
      links: [],
      sourceScratch: PAD_ID_B,
      tags: [],
      title: 'Frozen',
    });
    expect(await store.artifacts.findBySourceScratch(PAD_ID_B)).toEqual(created);
  });

  it('artifacts.findBySourceScratch refuses two artifacts from one scratchpad', async () => {
    const store = await fresh();
    await base(store);
    for (const title of ['One', 'Two']) {
      await store.artifacts.create({
        content: title,
        key: 'MMR',
        links: [],
        sourceScratch: PAD_ID_B,
        tags: [],
        title,
      });
    }
    const error = await errorOf(store.artifacts.findBySourceScratch(PAD_ID_B));
    expect(error.code).toBe('invariant');
    expect(error.message).toContain(PAD_ID_B);
  });

  // ── seeds ────────────────────────────────────────────────────────────────

  it('seeds.create allocates KEY-sN and defaults the lifecycle to new', async () => {
    const store = await fresh();
    await base(store);
    const seed = await store.seeds.create({
      description: '  someone should look at the cutover  ',
      key: 'MMR',
      kind: 'idea',
      requester: null,
      title: 'Cutover',
    });
    expect(seed).toMatchObject({
      description: 'someone should look at the cutover',
      key: 'MMR',
      lifecycle: 'new',
      requester: null,
      seq: 1,
      spawned: [],
    });
    expect(seed.created_at).toBe(seed.updated_at);
  });

  it('seeds.load yields undefined when absent, and loadHistory distinguishes empty from absent', async () => {
    const store = await fresh();
    await base(store);
    expect(await store.seeds.load('MMR', 1)).toBeUndefined();
    expect(await store.seeds.loadHistory('MMR', 1)).toBeUndefined();

    const seed = await store.seeds.create({
      description: null,
      key: 'MMR',
      kind: 'idea',
      requester: null,
      title: 'Fresh',
    });
    expect(await store.seeds.loadHistory('MMR', seed.seq)).toEqual([]);
  });

  it('seeds.transition records a legal edge and refuses an illegal one', async () => {
    const store = await fresh();
    await base(store);
    const seed = await store.seeds.create({
      description: null,
      key: 'MMR',
      kind: 'idea',
      requester: null,
      title: 'Cutover',
    });
    await store.seeds.transition(seed.key, seed.seq, 'resolved', 'already fixed');
    expect((await store.seeds.load(seed.key, seed.seq))?.lifecycle).toBe('resolved');
    const history = await store.seeds.loadHistory(seed.key, seed.seq);
    expect(history).toMatchObject([
      { from: 'new', kind: 'lifecycle', reason: 'already fixed', to: 'resolved' },
    ]);

    const illegal = await errorOf(
      store.seeds.transition(seed.key, seed.seq, 'promoted', 'reopen it'),
    );
    expect(illegal.code).toBe('validation');
    expect(illegal.message).toBe('a seed cannot move resolved → promoted');
    expect(illegal.hint).toContain('legal edges');
  });

  it('seeds.transition refuses an absent seed', async () => {
    const store = await fresh();
    await base(store);
    const error = await errorOf(store.seeds.transition('MMR', 9, 'resolved', 'gone'));
    expect(error.code).toBe('not_found');
    expect(error.message).toBe("MMR-s9 doesn't exist");
  });

  it('seeds.germinate promotes on the first spawn and is idempotent afterwards', async () => {
    const store = await fresh();
    const { second } = await base(store);
    const seed = await store.seeds.create({
      description: null,
      key: 'MMR',
      kind: 'idea',
      requester: null,
      title: 'Cutover',
    });
    await store.seeds.germinate(seed.key, seed.seq, second.id);
    const promoted = await store.seeds.load(seed.key, seed.seq);
    expect(promoted).toMatchObject({ lifecycle: 'promoted', spawned: [second.id] });
    expect(await store.seeds.loadHistory(seed.key, seed.seq)).toMatchObject([
      { from: 'new', kind: 'lifecycle', to: 'promoted' },
    ]);

    await store.seeds.germinate(seed.key, seed.seq, second.id);
    expect(await store.seeds.load(seed.key, seed.seq)).toEqual(promoted);
    expect((await store.seeds.loadHistory(seed.key, seed.seq))?.length).toBe(1);
  });

  it('a terminal seed refuses both germinate and patch', async () => {
    const store = await fresh();
    const { second } = await base(store);
    const seed = await store.seeds.create({
      description: null,
      key: 'MMR',
      kind: 'idea',
      requester: null,
      title: 'Cutover',
    });
    await store.seeds.transition(seed.key, seed.seq, 'rejected', 'out of scope');

    const germinated = await errorOf(store.seeds.germinate(seed.key, seed.seq, second.id));
    expect(germinated.code).toBe('validation');
    expect(germinated.message).toBe('seed MMR-s1 is rejected — a terminal seed is frozen');
    expect(germinated.hint).toBe('promote applies only to a new or promoted seed');

    const patched = await errorOf(store.seeds.patch(seed.key, seed.seq, { title: 'Renamed' }));
    expect(patched.message).toBe('seed MMR-s1 is rejected — a terminal seed is frozen');
    expect(patched.hint).toBe(
      'patches (title/kind/description) apply only to a new or promoted seed',
    );
  });

  it('seeds.patch writes nothing for an empty patch', async () => {
    const store = await fresh();
    await base(store);
    const seed = await store.seeds.create({
      description: null,
      key: 'MMR',
      kind: 'idea',
      requester: null,
      title: 'Cutover',
    });
    await store.seeds.patch(seed.key, seed.seq, {});
    expect((await store.seeds.load(seed.key, seed.seq))?.updated_at).toBe(seed.updated_at);

    await nextTick();
    await store.seeds.patch(seed.key, seed.seq, { title: 'Renamed' });
    const renamed = await store.seeds.load(seed.key, seed.seq);
    expect(renamed?.title).toBe('Renamed');
    expect(renamed?.updated_at).not.toBe(seed.updated_at);
  });

  it('seeds.listAll orders by key then seq, and listForProject by seq', async () => {
    const store = await fresh();
    await base(store);
    await createProject(store, { description: null, key: 'OPS', name: 'Operations' });
    for (const key of ['OPS', 'MMR', 'MMR']) {
      await store.seeds.create({
        description: null,
        key,
        kind: 'idea',
        requester: null,
        title: `${key} seed`,
      });
    }
    expect((await store.seeds.listAll()).map((s) => `${s.key}-s${String(s.seq)}`)).toEqual([
      'MMR-s1',
      'MMR-s2',
      'OPS-s1',
    ]);
    expect((await store.seeds.listForProject('MMR')).map((s) => s.seq)).toEqual([1, 2]);
  });

  it('seeds.loadDescriptions keys descriptions by stem and omits an absent seed', async () => {
    const store = await fresh();
    await base(store);
    const described = await store.seeds.create({
      description: 'the cutover',
      key: 'MMR',
      kind: 'idea',
      requester: null,
      title: 'Cutover',
    });
    const bare = await store.seeds.create({
      description: null,
      key: 'MMR',
      kind: 'idea',
      requester: null,
      title: 'Bare',
    });
    const found = await store.seeds.loadDescriptions([
      { key: described.key, seq: described.seq },
      { key: bare.key, seq: bare.seq },
      { key: 'MMR', seq: 99 },
    ]);
    expect([...found].toSorted(([a], [b]) => a.localeCompare(b))).toEqual([
      ['MMR-s1', 'the cutover'],
      ['MMR-s2', null],
    ]);
  });

  // ── scratchpads ──────────────────────────────────────────────────────────

  it('scratchpads.create round-trips through load, and an absent id reads undefined', async () => {
    const store = await fresh();
    const { first } = await base(store);
    const pad = scratchpad(first.id);
    await store.scratchpads.create(pad);
    expect(await store.scratchpads.load(pad.id)).toEqual(pad);
    expect(await store.scratchpads.load(PAD_ID_B)).toBeUndefined();
  });

  it('scratchpads.list orders by updatedAt descending', async () => {
    const store = await fresh();
    const { first } = await base(store);
    const older = scratchpad(first.id);
    const newer = scratchpad(first.id, {
      id: PAD_ID_B,
      title: 'Later notes',
      updatedAt: '2026-09-03T12:00:00.000Z',
    });
    await store.scratchpads.create(older);
    await store.scratchpads.create(newer);
    expect((await store.scratchpads.list()).map((p) => p.id)).toEqual([newer.id, older.id]);
    expect((await store.scratchpads.list('MMR')).length).toBe(2);
  });

  it('scratchpads.replace writes the whole record', async () => {
    const store = await fresh();
    const { first } = await base(store);
    const pad = scratchpad(first.id);
    await store.scratchpads.create(pad);
    const next = { ...pad, title: 'Renamed', updatedAt: '2026-09-04T12:00:00.000Z' };
    await store.scratchpads.replace(next, pad.updatedAt);
    expect(await store.scratchpads.load(pad.id)).toEqual(next);
  });

  it('scratchpads.replace refuses an absent pad', async () => {
    const store = await fresh();
    const { first } = await base(store);
    const pad = scratchpad(first.id);
    const error = await errorOf(store.scratchpads.replace(pad, pad.updatedAt));
    expect(error.code).toBe('validation');
    expect(error.message).toBe(`${pad.id} does not name a readable scratchpad`);
  });

  it('scratchpads.replace refuses a stale expectation', async () => {
    const store = await fresh();
    const { first } = await base(store);
    const pad = scratchpad(first.id);
    await store.scratchpads.create(pad);
    const error = await errorOf(
      store.scratchpads.replace(
        { ...pad, updatedAt: '2026-09-04T12:00:00.000Z' },
        '2026-08-01T12:00:00.000Z',
      ),
    );
    expect(error.message).toBe('the scratchpad changed concurrently');
    expect(error.hint).toBe('reload it and retry the mutation');
  });

  it('scratchpads.replace refuses a non-advancing updatedAt', async () => {
    const store = await fresh();
    const { first } = await base(store);
    const pad = scratchpad(first.id);
    await store.scratchpads.create(pad);
    const error = await errorOf(store.scratchpads.replace(pad, pad.updatedAt));
    expect(error.message).toBe('the scratchpad updatedAt must advance on replacement');
  });

  it('scratchpads.replace refuses a changed project or createdAt', async () => {
    const store = await fresh();
    const { first } = await base(store);
    const pad = scratchpad(first.id);
    await store.scratchpads.create(pad);
    const moved = await errorOf(
      store.scratchpads.replace(
        { ...pad, project: 'OPS', updatedAt: '2026-09-04T12:00:00.000Z' },
        pad.updatedAt,
      ),
    );
    expect(moved.message).toBe('scratchpad project and createdAt are immutable');

    const reborn = await errorOf(
      store.scratchpads.replace(
        { ...pad, createdAt: '2026-01-01T12:00:00.000Z', updatedAt: '2026-09-04T12:00:00.000Z' },
        pad.updatedAt,
      ),
    );
    expect(reborn.message).toBe('scratchpad project and createdAt are immutable');
  });

  it('scratchpads.delete is silent on an absent pad and refuses a stale guard', async () => {
    const store = await fresh();
    const { first } = await base(store);
    await store.scratchpads.delete(PAD_ID_B, '2026-09-01T12:00:00.000Z');

    const pad = scratchpad(first.id);
    await store.scratchpads.create(pad);
    const error = await errorOf(store.scratchpads.delete(pad.id, '2026-08-01T12:00:00.000Z'));
    expect(error.message).toBe('the scratchpad changed concurrently');

    await store.scratchpads.delete(pad.id, pad.updatedAt);
    expect(await store.scratchpads.load(pad.id)).toBeUndefined();
  });

  // ── transitions ──────────────────────────────────────────────────────────

  it('transitions.list is ascending and its cursor is exclusive', async () => {
    const store = await fresh();
    const { first } = await base(store);
    await startTask(store, first.id, {});
    await submitTask(store, first.id);

    const all = await store.transitions.list();
    expect(all.items.map((t) => [t.node, t.from, t.to])).toEqual([
      [first.id, 'todo', 'in_progress'],
      [first.id, 'in_progress', 'under_review'],
    ]);
    expect(all.nextCursor).toBeDefined();

    const page = await store.transitions.list({ limit: 1 });
    expect(page.items.length).toBe(1);
    const rest = await store.transitions.list({ since: page.nextCursor });
    expect(rest.items.map((t) => t.to)).toEqual(['under_review']);

    const exhausted = await store.transitions.list({ since: all.nextCursor });
    expect(exhausted.items).toEqual([]);
    expect(exhausted.nextCursor).toBeUndefined();
  });

  it('transitions.list refuses a bad limit and a malformed cursor', async () => {
    const store = await fresh();
    await base(store);
    const limit = await errorOf(store.transitions.list({ limit: 0 }));
    expect(limit.code).toBe('validation');
    expect(limit.message).toBe('invalid limit 0');

    const cursor = await errorOf(store.transitions.list({ since: 'not-a-cursor' }));
    expect(cursor.code).toBe('validation');
    expect(cursor.message).toBe('invalid cursor not-a-cursor');
    expect(cursor.hint).toBe('pass back a next_cursor you were given');
  });

  it('a project-keyed archive transition carries the project key as its token', async () => {
    const store = await fresh();
    await createProject(store, { description: null, key: 'OPS', name: 'Operations' });
    await archiveProject(store, 'OPS');
    const { items } = await store.transitions.list();
    expect(items).toMatchObject([{ kind: 'archive', node: 'OPS', to: 'archived' }]);
  });

  // ── body sections ────────────────────────────────────────────────────────

  it('readSectionsMany returns every requested stem in one batch', async () => {
    const store = await fresh();
    const { first, initiative, phase, second } = await base(store);
    await annotate(store, first.id, 'a note');
    await updateNode(store, initiative.id, { next: 'land the export' });

    const stems = ['MMR', initiative.id, phase.id, first.id, second.id];
    const sections = await store.bodySections.readSectionsMany(stems, {
      annotations: true,
      description: true,
      history: true,
      next: true,
    });
    expect([...sections.keys()].toSorted()).toEqual(stems.toSorted());
    expect(sections.get(first.id)?.annotations).toMatchObject([{ content: 'a note' }]);
    expect(sections.get(initiative.id)?.next).toEqual({
      present: true,
      text: 'land the export',
    });
  });

  it('annotationSectionFailures is empty on a clean store', async () => {
    const store = await fresh();
    const { first, second } = await base(store);
    expect(await store.bodySections.annotationSectionFailures([first.id, second.id])).toEqual(
      new Set(),
    );
  });
}

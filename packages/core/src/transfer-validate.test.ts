import { beforeAll, expect, test } from 'bun:test';

import { MimirError } from './errors';
import type { StoreExport } from './export';
import { createSqliteTestStore } from './store-sqlite/testing';
import { seedWorkingSet } from './testing/conformance';
import { parseTransferDocument } from './transfer-validate';

/**
 * The import parse refuses a malformed transfer document before any store is
 * touched (`importSqlStore` parses before it opens a write), so each fault is
 * a row here, run against the parse alone. Every row corrupts one real
 * exported document and names the field its refusal must carry.
 * `store-conformance.transfer.test.ts` keeps one malformed document per
 * backend, to prove the store refuses it in each mode without a write.
 */

let exported: StoreExport;

beforeAll(async () => {
  const fixture = await createSqliteTestStore();
  try {
    await seedWorkingSet(fixture.store);
    exported = await fixture.store.export();
  } finally {
    await fixture.close();
  }
});

type InvalidCase = {
  name: string;
  change: (document: StoreExport) => unknown;
  field: string;
};

/** The fixture's blocked task closed as `done`, with the given fields patched over it. */
function closeBlockedTask(
  nodes: StoreExport['nodes'],
  patch: Record<string, unknown>,
): StoreExport['nodes'] {
  return nodes.map((node) =>
    node.type === 'task' && node.hold === 'blocked'
      ? Object.assign(structuredClone(node), {
          completed_at: '2026-09-03T00:00:00.000Z',
          lifecycle: 'done',
          rank: null,
          ...patch,
        })
      : node,
  );
}

/** The fixture's first task with the given worker and session fields patched over it. */
function patchFirstTask(
  nodes: StoreExport['nodes'],
  patch: Record<string, unknown>,
): StoreExport['nodes'] {
  const first = nodes.find((node) => node.type === 'task');
  return nodes.map((node) => (node === first ? { ...node, ...patch } : node));
}

const invalidCases: InvalidCase[] = [
  {
    change: (d) => ({
      ...d,
      nodes: d.nodes.map((n) => (n.type === 'task' ? { ...n, hold: null } : n)),
    }),
    field: 'hold',
    name: 'missing task hold',
  },
  {
    change: (d) => ({
      ...d,
      nodes: d.nodes.map((n) => (n.type === 'task' ? { ...n, upstream: 'malformed' } : n)),
    }),
    field: 'upstream',
    name: 'malformed upstream identity',
  },
  {
    change: (d) => ({
      ...d,
      scratchpads: d.scratchpads.map((p) => ({
        ...p,
        agenda: patchFirst(p.agenda, { content: 'one\n2. [ ] injected' }),
      })),
    }),
    field: 'body',
    name: 'agenda item injection',
  },
  {
    change: (d) => ({
      ...d,
      scratchpads: d.scratchpads.map((p) => ({
        ...p,
        agenda: patchFirst(p.agenda, { reason: 'one — reason: two', state: 'superseded' }),
      })),
    }),
    field: 'body',
    name: 'ambiguous supersession reason',
  },

  {
    change: (d) => ({ ...d, nodes: patchFirst(d.nodes, { parent_id: 'MMR-2' }) }),
    field: 'cycle-parent',
    name: 'parent cycle',
  },
  {
    change: (d) => ({
      ...d,
      edges: [...d.edges, { depends_on_node_id: 'MMR-4', node_id: 'MMR-3' }],
    }),
    field: 'cycle-depends-on',
    name: 'dependency cycle',
  },

  {
    change: (d) => ({
      ...d,
      nodes: d.nodes.map((n) => (n.type === 'task' ? { ...n, lifecycle: null } : n)),
    }),
    field: 'lifecycle',
    name: 'missing task lifecycle',
  },
  {
    change: (d) => ({ ...d, nodes: closeBlockedTask(d.nodes, { hold: null }) }),
    field: 'hold',
    name: 'missing hold on a done task',
  },
  {
    change: (d) => ({
      ...d,
      nodes: closeBlockedTask(d.nodes, { block_owner: 'you', hold: 'none', hold_reason: null }),
    }),
    field: 'block_owner',
    name: 'block owner on an unheld done task',
  },
  {
    change: (d) => ({
      ...d,
      nodes: d.nodes.map((n) =>
        n.type === 'task' &&
        n.hold === 'none' &&
        n.lifecycle !== 'done' &&
        n.lifecycle !== 'abandoned'
          ? { ...n, hold_reason: 'stray' }
          : n,
      ),
    }),
    field: 'hold_reason',
    name: 'hold reason on an unheld open task',
  },
  {
    change: (d) => ({ ...d, nodes: patchFirst(d.nodes, { grooming: 'groomed' }) }),
    field: 'grooming',
    name: 'grooming on container',
  },
  {
    change: (d) => ({
      ...d,
      nodes: d.nodes.map((n) => (n.type === 'task' ? { ...n, grooming: 'half_groomed' } : n)),
    }),
    field: 'grooming',
    name: 'off-enum grooming',
  },
  {
    change: (d) => ({ ...d, nodes: patchFirst(d.nodes, { block_owner: 'you' }) }),
    field: 'block_owner',
    name: 'block owner on container',
  },
  {
    change: (d) => ({
      ...d,
      nodes: d.nodes.map((n) =>
        n.type === 'task' && n.hold === 'none' ? { ...n, block_owner: 'you' } : n,
      ),
    }),
    field: 'block_owner',
    name: 'block owner on a task that is not blocked',
  },
  {
    change: (d) => ({
      ...d,
      nodes: d.nodes.map((n) =>
        n.type === 'task' && n.hold === 'blocked' ? { ...n, block_owner: 'everyone' } : n,
      ),
    }),
    field: 'block_owner',
    name: 'off-enum block owner',
  },
  {
    change: (d) => ({ ...d, nodes: patchFirst(d.nodes, { lifecycle: 'done' }) }),
    field: 'lifecycle',
    name: 'task field on container',
  },
  {
    change: (d) => ({ ...d, nodes: patchFirst(d.nodes, { description: 'lost text' }) }),
    field: 'description',
    name: 'description in node metadata',
  },
  {
    change: (d) => ({
      ...d,
      bodySections: [
        { description: 'lost text', next: { present: false, text: null }, stem: 'MMR' },
      ],
    }),
    field: 'description',
    name: 'project body description',
  },
  {
    change: (d) => ({
      ...d,
      bodySections: [{ next: { present: false, text: 'lost text' }, stem: 'MMR' }],
    }),
    field: 'next',
    name: 'absent Next with text',
  },
  {
    change: (d) => ({
      ...d,
      scratchpads: d.scratchpads.map((p) => ({
        ...p,
        agenda: patchFirst(p.agenda, { reason: 'lost reason' }),
      })),
    }),
    field: 'agenda',
    name: 'agenda reason outside superseded state',
  },
  {
    change: (d) => ({
      ...d,
      scratchpads: d.scratchpads.map((p) => ({
        ...p,
        agenda: patchFirst(p.agenda, { number: 0 }),
      })),
    }),
    field: 'agenda',
    name: 'agenda sequence',
  },
  {
    change: (d) => ({ ...d, scratchpads: patchFirst(d.scratchpads, { createdAt: '' }) }),
    field: 'createdAt',
    name: 'scratchpad timestamp',
  },

  {
    change: (document) => Object.assign(document, { nodes: null }),
    field: 'nodes',
    name: 'missing collection',
  },
  {
    change: (document) => ({
      ...document,
      nodes: document.nodes.map((node) => ({ ...node, title: undefined })),
    }),
    field: 'title',
    name: 'missing required field',
  },
  {
    change: (document) => ({
      ...document,
      nodes: document.nodes.map((node) =>
        node.type === 'task' ? { ...node, priority: 'p9' } : node,
      ),
    }),
    field: 'priority',
    name: 'off-enum priority',
  },
  {
    change: (document) => ({
      ...document,
      nodes: document.nodes.map((node) =>
        node.type === 'task' ? { ...node, parent_id: 'MMR-999' } : node,
      ),
    }),
    field: 'parent_id',
    name: 'missing parent',
  },
  {
    change: (d) => ({ ...d, projects: patchFirst(d.projects, { key: '../bad' }) }),
    field: 'key',
    name: 'invalid project key',
  },
  {
    change: (d) => ({ ...d, nodes: patchFirst(d.nodes, { seq: 900 }) }),
    field: 'identity',
    name: 'inconsistent node identity',
  },
  {
    change: (d) => ({ ...d, nodes: patchFirst(d.nodes, { id: 'LOST-1', project_id: 'LOST' }) }),
    field: 'project_id',
    name: 'missing node owner',
  },
  {
    change: (d) => ({
      ...d,
      nodes: d.nodes.map((n) =>
        n.type === 'task' ? { ...n, id: `OPS-${n.seq}`, project_id: 'OPS' } : n,
      ),
    }),
    field: 'parent_id',
    name: 'cross-project parent',
  },
  {
    change: (d) => ({ ...d, edges: [{ depends_on_node_id: 'MMR-3', node_id: 'MMR-999' }] }),
    field: 'edge.node_id',
    name: 'missing edge source',
  },
  {
    change: (d) => ({ ...d, edges: [{ depends_on_node_id: 'MMR-999', node_id: 'MMR-3' }] }),
    field: 'depends_on_node_id',
    name: 'missing edge target',
  },
  {
    change: (d) => ({ ...d, edges: [{ depends_on_node_id: 'MMR-3', node_id: 'MMR-3' }] }),
    field: 'depends on itself',
    name: 'self dependency',
  },
  {
    change: (d) => ({ ...d, annotations: patchFirst(d.annotations, { node_id: 'MMR-999' }) }),
    field: 'annotation.node_id',
    name: 'missing annotation owner',
  },
  {
    change: (d) => ({ ...d, artifacts: patchFirst(d.artifacts, { key: 'LOST' }) }),
    field: '.key',
    name: 'missing artifact owner',
  },
  {
    change: (d) => ({ ...d, artifacts: patchFirst(d.artifacts, { links: ['MMR-999'] }) }),
    field: '.links',
    name: 'missing artifact link',
  },
  {
    change: (d) => ({ ...d, artifacts: patchFirst(d.artifacts, { key: 'OPS', links: ['MMR-3'] }) }),
    field: '.links',
    name: 'cross-project artifact link',
  },
  {
    change: (d) => ({ ...d, seeds: patchFirst(d.seeds, { key: 'LOST' }) }),
    field: '.key',
    name: 'missing seed owner',
  },
  {
    change: (d) => ({ ...d, seeds: patchFirst(d.seeds, { spawned: ['MMR-999'] }) }),
    field: '.spawned',
    name: 'missing spawned node',
  },
  {
    change: (d) => ({ ...d, scratchpads: patchFirst(d.scratchpads, { project: 'LOST' }) }),
    field: '.project',
    name: 'missing scratchpad owner',
  },
  {
    change: (d) => ({ ...d, scratchpads: patchFirst(d.scratchpads, { anchors: ['MMR-999'] }) }),
    field: '.anchors',
    name: 'missing scratchpad anchor',
  },
  {
    change: (d) => ({ ...d, tags: [{ entity_id: 'MMR-999', entity_type: 'node', tag: 'lost' }] }),
    field: 'tag.entity_id',
    name: 'missing node tag owner',
  },
  {
    change: (d) => ({ ...d, tags: [{ entity_id: 'LOST', entity_type: 'project', tag: 'lost' }] }),
    field: 'tag.entity_id',
    name: 'missing project tag owner',
  },
  {
    change: (d) => ({
      ...d,
      tags: [{ entity_id: 'MMR-a1', entity_type: 'artifact', tag: 'lost' }],
    }),
    field: 'entity_type',
    name: 'artifact tag in wrong collection',
  },
  {
    change: (d) => ({ ...d, bodySections: patchFirst(d.bodySections, { stem: 'MMR-999' }) }),
    field: 'bodySections.stem',
    name: 'missing body owner',
  },
  {
    change: (d) => ({ ...d, bodySections: [...d.bodySections, ...d.bodySections] }),
    field: 'bodySections claims',
    name: 'duplicate body owner',
  },
  {
    change: (d) => ({
      ...d,
      transitions: [
        { at: '', from_value: null, kind: 'lifecycle', node_id: 'MMR-999', to_value: 'todo' },
      ],
    }),
    field: 'transition.node_id',
    name: 'missing history owner',
  },
  {
    change: (d) => ({
      ...d,
      transitions: [
        {
          at: '',
          from_value: null,
          kind: 'lifecycle',
          node_id: 'MMR-3',
          project_id: 'MMR',
          to_value: 'todo',
        },
      ],
    }),
    field: 'exactly one',
    name: 'two history owners',
  },
  {
    change: (d) => ({
      ...d,
      transitions: [{ at: '', from_value: null, kind: 'lifecycle', to_value: 'todo' }],
    }),
    field: 'exactly one',
    name: 'no history owner',
  },
  ...['type', 'lifecycle', 'hold', 'size'].map((field): InvalidCase => ({
    change: (d) => ({ ...d, nodes: patchFirst(d.nodes, { [field]: 'invalid' }) }),
    field,
    name: `off-enum node ${field}`,
  })),
  ...['kind', 'lifecycle'].map((field): InvalidCase => ({
    change: (d) => ({ ...d, seeds: patchFirst(d.seeds, { [field]: 'invalid' }) }),
    field,
    name: `off-enum seed ${field}`,
  })),
  {
    change: (d) => ({ ...d, transitions: patchFirst(d.transitions, { kind: 'invalid' }) }),
    field: 'kind',
    name: 'off-enum history kind',
  },
  {
    change: (d) => ({
      ...d,
      seeds: d.seeds.map((s) => ({ ...s, history: patchFirst(s.history, { kind: 'invalid' }) })),
    }),
    field: 'kind',
    name: 'off-enum seed history kind',
  },
  {
    change: (d) => ({
      ...d,
      scratchpads: d.scratchpads.map((s) => ({
        ...s,
        agenda: patchFirst(s.agenda, { state: 'invalid' }),
      })),
    }),
    field: 'state',
    name: 'off-enum agenda state',
  },
  {
    change: (d) => ({ ...d, artifacts: patchFirst(d.artifacts, { seq: 2147483648 }) }),
    field: 'seq',
    name: 'integer overflow',
  },
];

// The main and worker rules (MMR-568): a worker needs its own nonblank session
// under a nonblank main one, and a worker that is the main agent again (one
// session, and no two known providers that differ) is refused, not collapsed.
const workerCases: InvalidCase[] = [
  {
    change: (d) => ({
      ...d,
      nodes: patchFirstTask(d.nodes, { worker_harness: null, worker_session: ' ' }),
    }),
    field: 'worker_session must be nonblank',
    name: 'blank worker session',
  },
  {
    change: (d) => ({
      ...d,
      nodes: patchFirstTask(d.nodes, { worker_harness: 'claude', worker_session: null }),
    }),
    field: 'worker_harness requires a nonblank worker_session',
    name: 'worker provider without a worker session',
  },
  {
    change: (d) => ({
      ...d,
      nodes: patchFirstTask(d.nodes, { session: null, worker_session: 'worker' }),
    }),
    field: 'worker_session requires a nonblank main session',
    name: 'worker session without a main session',
  },
  {
    change: (d) => ({
      ...d,
      nodes: patchFirstTask(d.nodes, {
        harness: 'codex',
        session: 'same',
        worker_harness: ' \t ',
        worker_session: 'same',
      }),
    }),
    field: 'duplicates the main session',
    name: 'worker on the main session with a blank provider',
  },
  {
    change: (d) => ({
      ...d,
      nodes: patchFirstTask(d.nodes, {
        harness: 'codex',
        session: 'same',
        worker_harness: null,
        worker_session: 'same',
      }),
    }),
    field: 'duplicates the main session',
    name: 'worker on the main session with no provider',
  },
  ...(['', '\t '] as const).map((harness): InvalidCase => ({
    change: (d) => ({
      ...d,
      nodes: patchFirstTask(d.nodes, {
        harness,
        session: 'same',
        worker_harness: 'codex',
        worker_session: 'same',
      }),
    }),
    field: 'duplicates the main session',
    name: `worker on the main session under the blank main provider ${JSON.stringify(harness)}`,
  })),
  {
    change: (d) => ({
      ...d,
      nodes: patchFirstTask(d.nodes, {
        harness: ' codex ',
        session: 'same',
        worker_harness: 'codex',
        worker_session: 'same',
      }),
    }),
    field: 'duplicates the main session',
    name: 'worker on the main session with the same provider, padded',
  },
];

/** The refusal text (summary plus hint) of a parse that must refuse. */
function parseRefusal(input: unknown): string {
  try {
    parseTransferDocument(input);
  } catch (error) {
    if (error instanceof MimirError) {
      return `${error.message} — ${error.hint ?? ''}`;
    }
    throw error;
  }
  throw new Error('expected the parse to refuse, but it accepted');
}

test('the unmodified fixture parses', () => {
  expect(() => parseTransferDocument(structuredClone(exported))).not.toThrow();
});

test.each([...invalidCases, ...workerCases])('$name is refused, naming $field', (scenario) => {
  const refusal = parseRefusal(scenario.change(structuredClone(exported)));
  expect(refusal).toContain(scenario.field);
  expect(refusal).toContain('invalid transfer document');
});

test('a worker on the main session parses when two known providers differ', () => {
  const input = structuredClone(exported);
  const nodes = patchFirstTask(input.nodes, {
    harness: 'codex',
    session: 'same',
    worker_harness: 'claude',
    worker_session: 'same',
  });
  const parsed = parseTransferDocument({ ...input, nodes });
  expect(parsed.nodes.find((node) => node.worker_session === 'same')).toMatchObject({
    harness: 'codex',
    worker_harness: 'claude',
  });
});

/** Corrupt a real exported record without claiming the result is a typed record. */
function patchFirst(rows: readonly object[], patch: Record<string, unknown>): unknown[] {
  if (rows.length === 0) {
    throw new Error('the fixture must contain a record to corrupt');
  }
  return rows.map((row, index) => (index === 0 ? { ...row, ...patch } : row));
}

import { describe, expect, setDefaultTimeout, test } from 'bun:test';

import { createProject } from './create';
import type { ExportedBodySections, StoreExport } from './export';
import { backends, refusalOf, seedWorkingSet, withoutStamp } from './testing/conformance';

setDefaultTimeout(60_000);

type InvalidCase = {
  name: string;
  change: (document: StoreExport) => unknown;
  field: string;
};

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

// Each backend receives the same faults in preview, apply, and resume.
/** A node as a version-2 document wrote it: no `block_owner` key, and optionally
 * an upstream on the blocked task (so the derivation rule has something to read). */
function legacyNode(node: StoreExport['nodes'][number], withUpstream: boolean) {
  const { block_owner: _owner, ...rest } = node;
  return withUpstream && rest.hold === 'blocked' ? { ...rest, upstream: 'OPS-s1' } : rest;
}

describe.each(backends)('$name', (backend) => {
  test('malformed transfer documents refuse without changing the target', async () => {
    const source = await backend.make();
    try {
      const target = await backend.make();
      try {
        await seedWorkingSet(source.store);
        const document = await source.store.export();
        await createProject(target.store, { description: null, key: 'KEEP', name: 'Untouched' });
        const before = withoutStamp(await target.store.export());
        for (const scenario of invalidCases) {
          const malformed = scenario.change(structuredClone(document));
          const refusal = await refusalOf(
            target.store.import(malformed, { dryRun: true, mode: 'fresh' }),
          );
          expect(refusal, scenario.name).toContain(scenario.field);
          expect(refusal, scenario.name).toContain('invalid transfer document');
          for (const mode of ['fresh', 'resume'] as const) {
            for (const dryRun of [true, false]) {
              expect(
                await refusalOf(target.store.import(malformed, { dryRun, mode })),
                scenario.name,
              ).toBe(refusal);
              expect(withoutStamp(await target.store.export()), scenario.name).toEqual(before);
            }
          }
        }
      } finally {
        await target.close();
      }
    } finally {
      await source.close();
    }
  });
  test('grooming round-trips through export and import, and a document without it defaults', async () => {
    const source = await backend.make();
    try {
      await seedWorkingSet(source.store);
      const document = await source.store.export();
      const target = await backend.make();
      try {
        const states = document.nodes.filter((n) => n.type === 'task').map((n) => n.grooming);
        // The default `not_groomed` is proven by the legacy import below.
        expect(new Set(states)).toEqual(new Set(['needs_answers', 'groomed']));
        expect(document.nodes.filter((n) => n.type !== 'task').map((n) => n.grooming)).toEqual([
          null,
          null,
        ]);

        await target.store.import(document, { dryRun: false, mode: 'fresh' });
        expect(withoutStamp(await target.store.export())).toEqual(withoutStamp(document));
      } finally {
        await target.close();
      }

      // A document written before the field existed carries no `grooming` key.
      const legacyTarget = await backend.make();
      try {
        const legacy = {
          ...document,
          nodes: document.nodes.map(({ grooming: _grooming, ...node }) => node),
          schema_version: 1,
        };
        await legacyTarget.store.import(legacy, { dryRun: false, mode: 'fresh' });
        const imported = await legacyTarget.store.export();
        for (const node of imported.nodes) {
          expect(node.grooming, node.id).toBe(node.type === 'task' ? 'not_groomed' : null);
        }
      } finally {
        await legacyTarget.close();
      }

      // A version this binary does not know is refused before any write, never
      // read lossily.
      const futureTarget = await backend.make();
      try {
        const refusal = await refusalOf(
          futureTarget.store.import(
            { ...document, schema_version: 8 },
            { dryRun: false, mode: 'fresh' },
          ),
        );
        expect(refusal).toContain('unsupported transfer document schema version 8');
        expect(refusal).toContain('this binary reads schema versions 1, 2, 3, 4, 5, 6');
      } finally {
        await futureTarget.close();
      }
    } finally {
      await source.close();
    }
  });
  test('block owner round-trips through export and import, and a pre-version-3 document derives it', async () => {
    const source = await backend.make();
    try {
      await seedWorkingSet(source.store);
      const document = await source.store.export();
      expect(document.schema_version).toBe(7);

      // Only the blocked task carries an owner; the fixture states `others`, which
      // the derivation rule (no upstream, so `you`) would not produce.
      const owners = document.nodes.map((n) => [n.hold, n.block_owner]);
      expect(owners.filter(([, owner]) => owner !== null)).toEqual([['blocked', 'others']]);

      const target = await backend.make();
      try {
        await target.store.import(document, { dryRun: false, mode: 'fresh' });
        expect(withoutStamp(await target.store.export())).toEqual(withoutStamp(document));
      } finally {
        await target.close();
      }

      // A version-2 document carries no `block_owner` key. A blocked task takes
      // the owner its upstream implies; every other task and container stays null.
      for (const [upstream, expected] of [
        [false, 'you'],
        [true, 'others'],
      ] as const) {
        const legacyTarget = await backend.make();
        try {
          const legacy = {
            ...document,
            nodes: document.nodes.map((node) => legacyNode(node, upstream)),
            schema_version: 2,
          };
          await legacyTarget.store.import(legacy, { dryRun: false, mode: 'fresh' });
          const imported = await legacyTarget.store.export();
          expect(imported.schema_version).toBe(7);
          for (const node of imported.nodes) {
            expect(node.block_owner, node.id).toBe(node.hold === 'blocked' ? expected : null);
          }
        } finally {
          await legacyTarget.close();
        }
      }
    } finally {
      await source.close();
    }
  });
  test('an import releases the hold an older binary left on a terminal task (MMR-616)', async () => {
    const source = await backend.make();
    try {
      await seedWorkingSet(source.store);
      const document = await source.store.export();
      // The fixture's blocked task, closed the way an older binary's `done` left
      // it: terminal, yet still blocked with its reason and owner.
      const residue = structuredClone(document);
      for (const node of residue.nodes) {
        if (node.type === 'task' && node.hold === 'blocked') {
          node.completed_at = '2026-09-03T00:00:00.000Z';
          node.lifecycle = 'done';
          node.rank = null;
        }
      }
      const closed = residue.nodes.filter((node) => node.lifecycle === 'done');
      expect(closed.map((node) => [node.hold, node.block_owner])).toEqual([['blocked', 'others']]);

      const target = await backend.make();
      try {
        await target.store.import(residue, { dryRun: false, mode: 'fresh' });
        const imported = await target.store.export();
        const ids = new Set(closed.map((node) => node.id));
        for (const node of imported.nodes.filter((n) => ids.has(n.id))) {
          expect(
            { block_owner: node.block_owner, hold: node.hold, hold_reason: node.hold_reason },
            node.id,
          ).toEqual({
            block_owner: null,
            hold: 'none',
            hold_reason: null,
          });
        }
      } finally {
        await target.close();
      }
    } finally {
      await source.close();
    }
  });
  test('the project pin round-trips through export and import, and a pre-version-4 document imports unpinned', async () => {
    const source = await backend.make();
    try {
      await seedWorkingSet(source.store);
      const document = await source.store.export();
      // The fixture pins one project and leaves the other, so a round trip that
      // defaulted or flipped the flag would show.
      expect(document.projects.map((project) => [project.key, project.pinned])).toEqual([
        ['MMR', true],
        ['OPS', false],
      ]);

      const target = await backend.make();
      try {
        await target.store.import(document, { dryRun: false, mode: 'fresh' });
        expect(withoutStamp(await target.store.export())).toEqual(withoutStamp(document));
      } finally {
        await target.close();
      }

      // A version-3 document carries no `pinned` key on its projects.
      const legacyTarget = await backend.make();
      try {
        const legacy = {
          ...document,
          projects: document.projects.map(({ pinned: _pinned, ...project }) => project),
          schema_version: 3,
        };
        await legacyTarget.store.import(legacy, { dryRun: false, mode: 'fresh' });
        const imported = await legacyTarget.store.export();
        expect(imported.schema_version).toBe(7);
        expect(imported.projects.map((project) => project.pinned)).toEqual([false, false]);
      } finally {
        await legacyTarget.close();
      }
    } finally {
      await source.close();
    }
  });
  test('the project remote round-trips through export and import, and a pre-version-5 document imports without one', async () => {
    const source = await backend.make();
    try {
      await seedWorkingSet(source.store);
      const document = await source.store.export();
      expect(document.projects.map((project) => [project.key, project.remote])).toEqual([
        ['MMR', 'github.com/dbtlr/mimir'],
        ['OPS', null],
      ]);

      const target = await backend.make();
      try {
        await target.store.import(document, { dryRun: false, mode: 'fresh' });
        expect(withoutStamp(await target.store.export())).toEqual(withoutStamp(document));
      } finally {
        await target.close();
      }

      // An imported remote is normalized like a written one, a blank is none,
      // and a value that is not a Git remote is refused.
      const raw = await backend.make();
      try {
        const spelled = {
          ...document,
          projects: document.projects.map((project) => ({
            ...project,
            remote: project.key === 'MMR' ? 'https://github.com/dbtlr/mimir.git' : '',
          })),
        };
        await raw.store.import(spelled, { dryRun: false, mode: 'fresh' });
        expect((await raw.store.export()).projects.map((project) => project.remote)).toEqual([
          'github.com/dbtlr/mimir',
          null,
        ]);
      } finally {
        await raw.close();
      }
      const refused = await backend.make();
      try {
        const bad = {
          ...document,
          projects: document.projects.map((project) => ({ ...project, remote: 'not a remote' })),
        };
        const failure = await refused.store.import(bad, { dryRun: false, mode: 'fresh' }).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(String(failure)).toContain('not a Git remote');
      } finally {
        await refused.close();
      }

      // A version-4 document carries no `remote` key on its projects.
      const legacyTarget = await backend.make();
      try {
        const legacy = {
          ...document,
          projects: document.projects.map(({ remote: _remote, ...project }) => project),
          schema_version: 4,
        };
        await legacyTarget.store.import(legacy, { dryRun: false, mode: 'fresh' });
        const imported = await legacyTarget.store.export();
        expect(imported.schema_version).toBe(7);
        expect(imported.projects.map((project) => project.remote)).toEqual([null, null]);
      } finally {
        await legacyTarget.close();
      }
    } finally {
      await source.close();
    }
  });
  // A project description reads trimmed, blank as none (MMR-607), and a remote
  // is stored normalized (MMR-609), so a resume must compare both by that same
  // read, or a document carrying them as written refuses its own fresh import.
  test('a resume accepts its own fresh import when a project description or remote is not in stored form', async () => {
    const source = await backend.make();
    try {
      await seedWorkingSet(source.store);
      const document = await source.store.export();
      const [first, second] = document.projects;
      if (first === undefined || second === undefined) {
        throw new Error('the fixture seeds two projects');
      }
      first.description = ' \n\t ';
      first.remote = '  git@github.com:dbtlr/mimir.git  ';
      second.description = '  The ops board.\n';
      second.remote = '   ';

      const target = await backend.make();
      try {
        await target.store.import(document, { dryRun: false, mode: 'fresh' });
        const resumed = await target.store.import(document, { dryRun: false, mode: 'resume' });
        expect(resumed.created).toBe(0);
        const projects = (await target.store.export()).projects;
        expect(projects.map((p) => p.description)).toEqual([null, 'The ops board.']);
        expect(projects.map((p) => p.remote)).toEqual(['github.com/dbtlr/mimir', null]);

        // A resume compares the target's remotes as stored, so whatever form a
        // write stored stays comparable, even on a project the document does not
        // carry: a path with a space. (A write can no longer store a host the
        // stored form refuses, MMR-612; store-sql/transfer.test.ts plants one.)
        await createProject(target.store, {
          description: null,
          key: 'OTH',
          name: 'Other',
          remote: 'https://github.com/org/my repo',
        });
        const again = await target.store.import(document, { dryRun: false, mode: 'resume' });
        expect(again.created).toBe(0);
      } finally {
        await target.close();
      }
    } finally {
      await source.close();
    }
  });

  // `## Next` text and a node description read trimmed, blank as none, too, so
  // a resume compares them by that read (MMR-609). Presence is its own stored
  // fact (ADR 0034): a present `## Next` whose text is blank stays present.
  test('a resume accepts its own fresh import when ## Next or a node description is blank or padded', async () => {
    const source = await backend.make();
    try {
      await seedWorkingSet(source.store);
      const exported = await source.store.export();
      const [project] = exported.projects;
      const [padded, blank, bare] = exported.nodes;
      if (
        project === undefined ||
        padded === undefined ||
        blank === undefined ||
        bare === undefined
      ) {
        throw new Error('the fixture seeds a project and three nodes');
      }
      // `bare` has a blank description and no `## Next`, so it reads as no
      // prose at all and its re-export omits the stem.
      const prose: ExportedBodySections[] = [
        { description: '  ', next: { present: false, text: null }, stem: bare.id },
        { description: ' \n\t ', next: { present: true, text: ' \n' }, stem: blank.id },
        {
          description: '  Fix the import.\n',
          next: { present: true, text: '\tThen ship.  ' },
          stem: padded.id,
        },
        { next: { present: true, text: 'Go.\n' }, stem: project.key },
      ];
      const replaced = new Set(prose.map((sections) => sections.stem));
      const document: StoreExport = {
        ...exported,
        bodySections: [
          ...exported.bodySections.filter((sections) => !replaced.has(sections.stem)),
          ...prose,
        ],
      };

      const target = await backend.make();
      try {
        await target.store.import(document, { dryRun: false, mode: 'fresh' });
        const resumed = await target.store.import(document, { dryRun: false, mode: 'resume' });
        expect(resumed.created).toBe(0);
        const read = new Map(
          (await target.store.export()).bodySections.map((sections) => [sections.stem, sections]),
        );
        expect(read.get(project.key)?.next).toEqual({ present: true, text: 'Go.' });
        expect(read.get(padded.id)).toMatchObject({
          description: 'Fix the import.',
          next: { present: true, text: 'Then ship.' },
        });
        expect(read.get(blank.id)).toMatchObject({
          description: null,
          next: { present: true, text: null },
        });
        expect(read.has(bare.id)).toBe(false);
      } finally {
        await target.close();
      }
    } finally {
      await source.close();
    }
  });

  // The other half of MMR-609: comparing prose as the target reads it must not
  // accept prose the target does not hold. A present `## Next` with blank text
  // is not an absent one (ADR 0034).
  test('a resume refuses a document whose ## Next or node description differs from the target', async () => {
    const source = await backend.make();
    try {
      await seedWorkingSet(source.store);
      const exported = await source.store.export();
      const [project] = exported.projects;
      const [described, headed] = exported.nodes;
      if (project === undefined || described === undefined || headed === undefined) {
        throw new Error('the fixture seeds a project and two nodes');
      }
      const prose: ExportedBodySections[] = [
        { description: 'A', next: { present: true, text: null }, stem: described.id },
        { next: { present: true, text: null }, stem: headed.id },
        { next: { present: true, text: null }, stem: project.key },
      ];
      const withProse = (sections: readonly ExportedBodySections[]): StoreExport => {
        const replaced = new Set(prose.map((row) => row.stem));
        return {
          ...exported,
          bodySections: [
            ...exported.bodySections.filter((row) => !replaced.has(row.stem)),
            ...sections,
          ],
        };
      };
      const without = (stem: string) => prose.filter((row) => row.stem !== stem);
      const variants: Record<string, ExportedBodySections[]> = {
        'a different node description': [
          { description: 'B', next: { present: true, text: null }, stem: described.id },
          ...without(described.id),
        ],
        'a node ## Next absent beside its description': [
          { description: 'A', next: { present: false, text: null }, stem: described.id },
          ...without(described.id),
        ],
        'a node ## Next absent with no other prose': without(headed.id),
        'a node ## Next with text': [
          { next: { present: true, text: 'Go.' }, stem: headed.id },
          ...without(headed.id),
        ],
        'a project ## Next absent': without(project.key),
        'a project ## Next with text': [
          { next: { present: true, text: 'Go.' }, stem: project.key },
          ...without(project.key),
        ],
      };

      const target = await backend.make();
      try {
        await target.store.import(withProse(prose), { dryRun: false, mode: 'fresh' });
        for (const [name, sections] of Object.entries(variants)) {
          const refusal = await refusalOf(
            target.store.import(withProse(sections), { dryRun: false, mode: 'resume' }),
          );
          expect(`${name}: ${refusal}`).toContain('already exists and differs');
        }
      } finally {
        await target.close();
      }
    } finally {
      await source.close();
    }
  });

  // A seed write stores its description as `storedProse` does; an import writes
  // it raw, so every read normalizes it, as for project and node prose (MMR-611).
  test('an imported seed description reads as a written one does, and resumes onto its own import', async () => {
    const source = await backend.make();
    try {
      await seedWorkingSet(source.store);
      const exported = await source.store.export();
      const [seed] = exported.seeds;
      if (seed === undefined) {
        throw new Error('the fixture seeds one seed');
      }
      const cases: [written: string, read: string | null][] = [
        ['  ', null],
        [' \t\n', null],
        ['  Look at the cutover. \n', 'Look at the cutover.'],
      ];
      for (const [written, read] of cases) {
        const document: StoreExport = {
          ...exported,
          seeds: [{ ...seed, description: written }],
        };
        const target = await backend.make();
        try {
          await target.store.import(document, { dryRun: false, mode: 'fresh' });
          const label = JSON.stringify(written);
          const loaded = await target.store.seeds.load(seed.key, seed.seq, { content: true });
          expect([label, loaded?.description]).toEqual([label, read]);
          const described = await target.store.seeds.loadDescriptions([seed]);
          expect([label, described.get(`${seed.key}-s${seed.seq}`)]).toEqual([label, read]);
          const reexported = (await target.store.export()).seeds.at(0)?.description;
          expect([label, reexported]).toEqual([label, read]);

          const resumed = await target.store.import(document, { dryRun: false, mode: 'resume' });
          expect([label, resumed.created]).toEqual([label, 0]);
          const different = { ...document, seeds: [{ ...seed, description: 'Something else.' }] };
          const refusal = await refusalOf(
            target.store.import(different, { dryRun: false, mode: 'resume' }),
          );
          expect(`${label}: ${refusal}`).toContain('already exists and differs');
        } finally {
          await target.close();
        }
      }
    } finally {
      await source.close();
    }
  });

  test('imports cross-project dependencies and preserves legacy facts', async () => {
    const source = await backend.make();
    try {
      const target = await backend.make();
      try {
        await seedWorkingSet(source.store);
        const document = await source.store.export();
        const task = document.nodes.find((node) => node.type === 'task');
        if (task === undefined) {
          throw new Error('fixture needs a task');
        }
        const compatible: StoreExport = {
          ...document,
          artifacts: document.artifacts.map((artifact) => ({
            ...artifact,
            source_scratch: '123e4567-e89b-42d3-a456-426614174099',
            updated_at: '',
          })),
          edges: [{ depends_on_node_id: 'OPS-1', node_id: 'MMR-3' }, ...document.edges],
          nodes: [
            ...document.nodes,
            {
              ...task,
              id: 'OPS-1',
              parent_id: null,
              project_id: 'OPS',
              seq: 1,
              upstream: 'OLD-s1',
            },
          ],
          projects: document.projects.map((project) =>
            project.key === 'OPS'
              ? { ...project, counters: { ...project.counters, node: 1 } }
              : project,
          ),
          seeds: document.seeds.map((seed) => Object.assign(seed, { requester: 'OLD' })),
        };
        await target.store.import(compatible, { dryRun: false, mode: 'fresh' });
        expect(withoutStamp(await target.store.export())).toEqual(withoutStamp(compatible));
        expect(
          (await target.store.import(compatible, { dryRun: false, mode: 'resume' })).created,
        ).toBe(0);
      } finally {
        await target.close();
      }
    } finally {
      await source.close();
    }
  });
});

/** Corrupt a real exported record without claiming the result is a typed record. */
function patchFirst(rows: readonly object[], patch: Record<string, unknown>): unknown[] {
  if (rows.length === 0) {
    throw new Error('the fixture must contain a record to corrupt');
  }
  return rows.map((row, index) => (index === 0 ? { ...row, ...patch } : row));
}

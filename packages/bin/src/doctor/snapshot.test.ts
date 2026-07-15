import { expect, test } from 'bun:test';

import type { NornClient, NornFindArgs } from '../norn/client';
import {
  doctorContextFromSnapshot,
  doctorPhysicalPathsByStem,
  readDoctorSnapshot,
} from './snapshot';

test('reads one whole-vault enumeration plus one artifact scan and derives every document diagnostic input (MMR-241, MMR-282)', async () => {
  let findCalls = 0;
  let validateCalls = 0;
  const findArgs: NornFindArgs[] = [];
  const sectionCalls: { paths: string[]; sections: string[] }[] = [];
  const client = {
    find: (args: NornFindArgs) => {
      findCalls += 1;
      findArgs.push(args);
      // The artifact scan is a distinct, doctor-only find keyed on `type:artifact`;
      // the work-state enumeration is everything else.
      if (args.in?.includes('type:artifact')) {
        return Promise.resolve([
          {
            frontmatter: { project: '[[MMR]]', type: 'artifact' },
            path: 'MMR/artifacts/MMR-a1.md',
          },
        ]);
      }
      return Promise.resolve([
        {
          body: '## History\n',
          document_hash: 'project-hash',
          frontmatter: { key: 'MMR', project: '[[MMR]]', type: 'project' },
          path: 'MMR/MMR.md',
        },
        {
          body: '## History\n## Annotations\n',
          document_hash: 'node-hash',
          frontmatter: {
            depends_on: [],
            hold: 'none',
            lifecycle: 'todo',
            parent: null,
            project: '[[OTH]]',
            type: 'task',
          },
          path: 'MMR/MMR-1.md',
        },
      ]);
    },
    sectionFailures: (paths: string[], sections: string[]) => {
      sectionCalls.push({ paths, sections });
      return Promise.resolve(sections[0] === 'Annotations' ? ['MMR/MMR-1.md'] : []);
    },
    validate: () => {
      validateCalls += 1;
      return Promise.resolve({
        findings: [{ code: 'required-frontmatter', field: 'title', path: 'MMR/MMR-1.md' }],
      });
    },
  } as unknown as NornClient;

  const snapshot = await readDoctorSnapshot(client);

  // Two finds: the work-state enumeration + the distinct artifact scan. Section reads
  // still derive from the work-state find; artifacts contribute only path + stem.
  expect(findCalls).toBe(2);
  expect(validateCalls).toBe(1);
  expect(findArgs).toContainEqual({
    col: ['.frontmatter', '.body', '.document_hash'],
    in: ['type:project,task,phase,initiative,seed'],
    no_limit: true,
  });
  expect(findArgs).toContainEqual({
    col: ['.frontmatter'],
    in: ['type:artifact'],
    no_limit: true,
  });
  expect(snapshot.artifacts).toEqual([{ path: 'MMR/artifacts/MMR-a1.md', stem: 'MMR-a1' }]);
  expect(sectionCalls).toEqual([
    { paths: ['MMR/MMR.md', 'MMR/MMR-1.md'], sections: ['History'] },
    { paths: ['MMR/MMR-1.md'], sections: ['Annotations'] },
  ]);
  expect(snapshot.documents).toEqual([
    {
      body: '## History\n',
      documentHash: 'project-hash',
      frontmatter: { key: 'MMR', project: '[[MMR]]', type: 'project' },
      path: 'MMR/MMR.md',
      stem: 'MMR',
    },
    {
      body: '## History\n## Annotations\n',
      documentHash: 'node-hash',
      frontmatter: {
        depends_on: [],
        hold: 'none',
        lifecycle: 'todo',
        parent: null,
        project: '[[OTH]]',
        type: 'task',
      },
      path: 'MMR/MMR-1.md',
      stem: 'MMR-1',
    },
  ]);
  expect(snapshot.graph.projectKeys).toEqual(['MMR']);
  expect(snapshot.graph.nodes.map((node) => node.stem)).toEqual(['MMR-1']);
  expect(snapshot.graph.declarations).toEqual([
    { kind: 'project', path: 'MMR/MMR.md', project: 'MMR', stem: 'MMR' },
    { kind: 'node', path: 'MMR/MMR-1.md', project: 'OTH', stem: 'MMR-1' },
  ]);
  expect(snapshot.sectionFailures).toEqual([
    { path: 'MMR/MMR-1.md', section: 'Annotations', stem: 'MMR-1' },
  ]);
  expect(snapshot.validateFindings).toEqual([
    { code: 'required-frontmatter', field: 'title', path: 'MMR/MMR-1.md' },
  ]);
});

test('merged physical duplicates fail node and seed references closed before diagnosis', async () => {
  const nodeCtx = doctorContextFromSnapshot(
    {
      documents: [
        {
          body: 'one',
          documentHash: 'hash',
          path: 'relocated/MMR-1.md',
          stem: 'MMR-1',
        },
      ],
      graph: {
        nodes: [
          { dependsOn: [], key: 'MMR', parent: null, stem: 'MMR-1' },
          { dependsOn: ['MMR-1'], key: 'MMR', parent: null, stem: 'MMR-2' },
        ],
        projectKeys: ['MMR'],
        sources: [{ kind: 'node', path: 'relocated/MMR-1.md', stem: 'MMR-1' }],
      },
      sectionFailures: [],
      validateFindings: [{ code: 'frontmatter-parse-failed', path: 'MMR/MMR-1.md' }],
    },
    undefined,
  );
  expect(nodeCtx.dropped).toContainEqual({
    kind: 'edge',
    ref: 'MMR-1',
    rule: 'dangling-depends-on',
    stem: 'MMR-2',
  });

  const seedCtx = doctorContextFromSnapshot(
    {
      documents: [
        {
          body: 'seed',
          documentHash: 'hash',
          path: 'relocated/MMR-s1.md',
          stem: 'MMR-s1',
        },
      ],
      graph: {
        nodes: [
          {
            dependsOn: [],
            key: 'MMR',
            parent: null,
            stem: 'MMR-2',
            type: 'task',
            upstream: 'MMR-s1',
          },
        ],
        projectKeys: ['MMR'],
        seeds: [
          {
            key: 'MMR',
            kind: 'feature',
            lifecycle: 'new',
            requester: null,
            spawned: [],
            stem: 'MMR-s1',
          },
        ],
        sources: [{ kind: 'seed', path: 'relocated/MMR-s1.md', stem: 'MMR-s1' }],
      },
      sectionFailures: [],
      validateFindings: [{ code: 'frontmatter-parse-failed', path: 'MMR/seeds/MMR-s1.md' }],
    },
    undefined,
  );
  expect(seedCtx.dropped).toContainEqual({
    kind: 'field',
    rule: 'dangling-upstream',
    stem: 'MMR-2',
    value: 'MMR-s1',
  });
});

test('native and validate-only duplicate drops share one complete owner set', () => {
  const ctx = doctorContextFromSnapshot(
    {
      documents: [],
      graph: {
        nodes: [],
        projectKeys: ['MMR'],
        sources: [
          { kind: 'node', path: 'first/MMR-1.md', stem: 'MMR-1' },
          { kind: 'node', path: 'second/MMR-1.md', stem: 'MMR-1' },
        ],
      },
      sectionFailures: [],
      validateFindings: [{ code: 'frontmatter-parse-failed', path: 'MMR/MMR-1.md' }],
    },
    undefined,
  );
  const duplicates = ctx.dropped.filter((drop) => drop.rule === 'duplicate-stem');
  expect(duplicates).toHaveLength(3);
  expect(duplicates.every((drop) => drop.kind === 'identity' && drop.paths.length === 3)).toBe(
    true,
  );
});

test('ownership rejects nested schema lookalikes and keys projects by logical key', () => {
  const snapshot = {
    documents: [
      {
        body: 'project',
        documentHash: 'hash',
        frontmatter: { key: 'MMR', type: 'project' },
        path: 'relocated/custom.md',
        stem: 'custom',
      },
      {
        body: 'node',
        documentHash: 'hash',
        path: 'relocated/MMR-9.md',
        stem: 'MMR-9',
      },
    ],
    graph: {
      nodes: [],
      projectKeys: ['MMR'],
      sources: [{ kind: 'project' as const, path: 'relocated/custom.md', stem: 'MMR' }],
    },
    sectionFailures: [],
    validateFindings: [
      { code: 'frontmatter-parse-failed', path: 'MMR/MMR.md' },
      { code: 'frontmatter-parse-failed', path: 'archive/MMR/MMR-9.md' },
    ],
  };
  const owners = doctorPhysicalPathsByStem(snapshot);
  expect([...(owners.get('MMR') ?? [])].toSorted()).toEqual(['MMR/MMR.md', 'relocated/custom.md']);
  expect([...(owners.get('MMR-9') ?? [])]).toEqual(['relocated/MMR-9.md']);
});

test('typed graph provenance wins over validate path inference for the same document', () => {
  const owners = doctorPhysicalPathsByStem({
    documents: [],
    graph: {
      nodes: [],
      projectKeys: ['MMR'],
      sources: [{ kind: 'seed', path: 'MMR/MMR-1.md', stem: 'MMR-s1' }],
    },
    sectionFailures: [],
    validateFindings: [{ code: 'frontmatter-parse-failed', path: 'MMR/MMR-1.md' }],
  });
  expect([...(owners.get('MMR-s1') ?? [])]).toEqual(['MMR/MMR-1.md']);
  expect(owners.has('MMR-1')).toBe(false);
});

test('snapshot context scopes document findings by canonical stem while retaining global graph drops', async () => {
  const ctx = doctorContextFromSnapshot(
    {
      documents: [
        { body: 'mmr', documentHash: null, path: 'MMR/MMR-1.md', stem: 'MMR-1' },
        { body: 'other', documentHash: null, path: 'OTH/OTH-2.md', stem: 'OTH-2' },
      ],
      graph: {
        nodes: [
          { dependsOn: [], key: 'OTH', parent: null, stem: 'OTH-2' },
          { dependsOn: [], key: 'BAD', parent: null, stem: 'BAD-3' },
        ],
        projectKeys: ['OTH'],
      },
      sectionFailures: [
        { path: 'MMR/MMR-1.md', section: 'History', stem: 'MMR-1' },
        { path: 'OTH/OTH-2.md', section: 'History', stem: 'OTH-2' },
      ],
      validateFindings: [
        { code: 'required-frontmatter', path: 'MMR/MMR-1.md' },
        { code: 'required-frontmatter', path: 'OTH/OTH-2.md' },
      ],
    },
    'MMR',
  );

  expect(await ctx.readNodeDocs()).toEqual([{ body: 'mmr', path: 'MMR/MMR-1.md', stem: 'MMR-1' }]);
  expect(ctx.sectionFailures).toEqual([
    { path: 'MMR/MMR-1.md', section: 'History', stem: 'MMR-1' },
  ]);
  expect(ctx.validateFindings).toEqual([{ code: 'required-frontmatter', path: 'MMR/MMR-1.md' }]);
  expect(ctx.dropped.some((drop) => drop.rule === 'missing-project' && drop.stem === 'BAD-3')).toBe(
    true,
  );
});

test('snapshot context scopes artifact docs by canonical stem (MMR-282)', async () => {
  const artifacts = [
    { path: 'MMR/artifacts/MMR-a1.md', stem: 'MMR-a1' },
    { path: 'MMR/MMR-a1.md', stem: 'MMR-a1' }, // a misplaced twin, still MMR-scoped
    { path: 'OTH/artifacts/OTH-a1.md', stem: 'OTH-a1' },
  ];
  const base = {
    documents: [],
    graph: { nodes: [], projectKeys: [] },
    sectionFailures: [],
    validateFindings: [],
  };
  const scoped = doctorContextFromSnapshot({ ...base, artifacts }, 'MMR');
  expect(await scoped.readArtifactDocs()).toEqual([
    { path: 'MMR/artifacts/MMR-a1.md', stem: 'MMR-a1' },
    { path: 'MMR/MMR-a1.md', stem: 'MMR-a1' },
  ]);
  // Whole-vault (no scope) sees every artifact; a snapshot without the field reads none.
  const all = doctorContextFromSnapshot({ ...base, artifacts }, undefined);
  expect(await all.readArtifactDocs()).toHaveLength(3);
  const none = doctorContextFromSnapshot(base, undefined);
  expect(await none.readArtifactDocs()).toEqual([]);
});

import { expect, test } from 'bun:test';

import type { NornClient, NornFindArgs } from '../norn/client';
import { doctorContextFromSnapshot, readDoctorSnapshot } from './snapshot';

test('reads one whole-vault enumeration and derives every document diagnostic input (MMR-241)', async () => {
  let findCalls = 0;
  let validateCalls = 0;
  let findArgs: NornFindArgs | undefined;
  const sectionCalls: { paths: string[]; sections: string[] }[] = [];
  const client = {
    find: (args: NornFindArgs) => {
      findCalls += 1;
      findArgs = args;
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

  expect(findCalls).toBe(1);
  expect(validateCalls).toBe(1);
  expect(findArgs).toEqual({
    col: ['.frontmatter', '.body', '.document_hash'],
    in: ['type:project,task,phase,initiative,seed'],
    no_limit: true,
  });
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
    { project: 'MMR', stem: 'MMR' },
    { project: 'OTH', stem: 'MMR-1' },
  ]);
  expect(snapshot.sectionFailures).toEqual([{ section: 'Annotations', stem: 'MMR-1' }]);
  expect(snapshot.validateFindings).toEqual([
    { code: 'required-frontmatter', field: 'title', path: 'MMR/MMR-1.md' },
  ]);
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
        { section: 'History', stem: 'MMR-1' },
        { section: 'History', stem: 'OTH-2' },
      ],
      validateFindings: [
        { code: 'required-frontmatter', path: 'MMR/MMR-1.md' },
        { code: 'required-frontmatter', path: 'OTH/OTH-2.md' },
      ],
    },
    'MMR',
  );

  expect(await ctx.readNodeDocs()).toEqual([{ body: 'mmr', path: 'MMR/MMR-1.md', stem: 'MMR-1' }]);
  expect(ctx.sectionFailures).toEqual([{ section: 'History', stem: 'MMR-1' }]);
  expect(ctx.validateFindings).toEqual([{ code: 'required-frontmatter', path: 'MMR/MMR-1.md' }]);
  expect(ctx.dropped.some((drop) => drop.rule === 'missing-project' && drop.stem === 'BAD-3')).toBe(
    true,
  );
});

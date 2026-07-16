import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bunExec } from '../exec';
import { NornClient } from '../norn/client';
import { seedRawDoc } from '../norn/testing';
import { createNornWriteStore } from '../norn/writer';
import { converge } from '../vault/converge';
import { readSectionFailures } from './body-sections';
import { createProject } from './create';
import { renderHistoryBody, renderNodeBody } from './history-codec';
import { renderId } from './ids';
import { undepend } from './mutations/dependency';
import { loadNornSnapshot, loadWorkingSetOverNorn, readVaultGraph } from './store-norn';
import { expectMimirError } from './testing';
import { validate } from './validate';

/**
 * The Norn node read path over a real `norn` subprocess (MMR-149). Skipped when
 * the binary isn't on PATH (CI); the derivation suite already covers the
 * WorkingSet consumers, so this proves the vault→WorkingSet projection itself.
 */
const NORN = Bun.which('norn') !== null;

let root: string;
let vaultRoot: string;
let client: NornClient;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mimir-norn-read-'));
  vaultRoot = join(root, 'vault');
  await converge(vaultRoot, { allowCreate: true, exec: bunExec });
  client = new NornClient({ vaultPath: vaultRoot });
});
afterEach(async () => {
  await client.close();
  rmSync(root, { force: true, recursive: true });
});

/** Test-local invariant: a lookup that must resolve (avoids non-null assertions). */
function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('expected the lookup to resolve');
  }
  return value;
}

const jsonField = (key: string, value: unknown): [string, unknown] => [key, value];
const wikilink = (stem: string): string => `[[${stem}]]`;
const aliasedWikilink = (stem: string, alias: string): string => `[[${stem}|${alias}]]`;

async function writeDoc(path: string, fields: [string, unknown][], body = ''): Promise<void> {
  await seedRawDoc(client, vaultRoot, path, Object.fromEntries(fields), body);
}

test.skipIf(!NORN)(
  'loadWorkingSetOverNorn projects nodes, edges, and tags from a vault',
  async () => {
    await writeDoc('MMR/MMR.md', [
      jsonField('type', 'project'),
      jsonField('key', 'MMR'),
      jsonField('name', 'Mimir'),
      jsonField('created', '2026-06-01T00:00:00.000Z'),
      jsonField('updated_at', '2026-06-02T00:00:00.000Z'),
      jsonField('tags', ['release:v1']),
    ]);
    await writeDoc('MMR/MMR-1.md', [
      jsonField('type', 'phase'),
      jsonField('title', 'Phase A'),
      jsonField('parent', wikilink('MMR')),
      jsonField('created', '2026-06-01T00:00:00.000Z'),
      jsonField('updated_at', '2026-06-02T00:00:00.000Z'),
    ]);
    await writeDoc('MMR/MMR-2.md', [
      jsonField('type', 'task'),
      jsonField('title', 'Prereq'),
      jsonField('parent', wikilink('MMR-1')),
      jsonField('lifecycle', 'todo'),
      jsonField('created', '2026-06-01T00:00:00.000Z'),
      jsonField('updated_at', '2026-06-02T00:00:00.000Z'),
    ]);
    await writeDoc('MMR/MMR-3.md', [
      jsonField('type', 'task'),
      jsonField('title', 'Dependent'),
      jsonField('parent', wikilink('MMR-1')),
      jsonField('lifecycle', 'todo'),
      jsonField('priority', 'p1'),
      jsonField('rank', 1),
      jsonField('depends_on', [wikilink('MMR-2')]),
      jsonField('tags', ['zebra', 'alpha']),
      jsonField('created', '2026-06-01T00:00:00.000Z'),
      jsonField('updated_at', '2026-06-02T00:00:00.000Z'),
    ]);

    const ws = await loadWorkingSetOverNorn(client);

    expect(ws.projects).toHaveLength(1);
    expect(ws.projects[0]).toMatchObject({ key: 'MMR', name: 'Mimir' });
    expect(ws.nodes).toHaveLength(3);

    const byStem = new Map(ws.nodes.map((n) => [renderId({ key: 'MMR', seq: n.seq }), n] as const));
    const phase = must(byStem.get('MMR-1'));
    const prereq = must(byStem.get('MMR-2'));
    const dependent = must(byStem.get('MMR-3'));

    // parent: project root → null; node parent → that node's canonical stem.
    expect(phase.parent_id).toBeNull();
    expect(prereq.parent_id).toBe(phase.id);
    expect(dependent.priority).toBe('p1');
    expect(dependent.rank).toBe(1);

    // the depends_on edge carries canonical stems at both endpoints.
    expect(ws.edges).toEqual([{ depends_on_node_id: prereq.id, node_id: dependent.id }]);

    // tags: sorted, note-less, project + node.
    expect(ws.nodeTags.get(dependent.id)).toEqual([
      { created_at: '2026-06-01T00:00:00.000Z', tag: 'alpha' },
      { created_at: '2026-06-01T00:00:00.000Z', tag: 'zebra' },
    ]);
    expect(ws.projectTags.get(must(ws.projects[0]).key)).toEqual([
      { created_at: '2026-06-01T00:00:00.000Z', tag: 'release:v1' },
    ]);
  },
);

test.skipIf(!NORN)(
  'duplicate node stems exclude every collider and preserve all paths for doctor',
  async () => {
    await writeDoc('MMR/MMR.md', [
      jsonField('type', 'project'),
      jsonField('key', 'MMR'),
      jsonField('name', 'Mimir'),
    ]);
    const taskFields = [
      jsonField('type', 'task'),
      jsonField('title', 'Duplicate'),
      jsonField('parent', wikilink('MMR')),
      jsonField('lifecycle', 'todo'),
    ];
    await writeDoc('MMR/MMR-1.md', taskFields);
    await writeDoc('relocated/MMR-1.md', taskFields);

    expect((await loadWorkingSetOverNorn(client)).nodes).toEqual([]);
    const drops = validate(await readVaultGraph(client)).dropped.filter(
      (drop) => drop.rule === 'duplicate-stem',
    );
    expect(drops).toHaveLength(2);
    expect(drops.map((drop) => (drop.kind === 'identity' ? drop.path : ''))).toEqual([
      'MMR/MMR-1.md',
      'relocated/MMR-1.md',
    ]);
  },
);

test.skipIf(!NORN)(
  'duplicate project identities withhold projects, nodes, and path locators',
  async () => {
    const projectFields = [
      jsonField('type', 'project'),
      jsonField('key', 'MMR'),
      jsonField('name', 'Mimir'),
    ];
    await writeDoc('MMR/MMR.md', projectFields);
    await writeDoc('relocated/MMR.md', projectFields);
    await writeDoc('MMR/MMR-1.md', [
      jsonField('type', 'task'),
      jsonField('title', 'Orphaned by collision'),
      jsonField('parent', wikilink('MMR')),
      jsonField('lifecycle', 'todo'),
    ]);

    const snapshot = await loadNornSnapshot(client);
    expect(snapshot.workingSet.projects).toEqual([]);
    expect(snapshot.workingSet.nodes).toEqual([]);
    expect(snapshot.pathByStem.has('MMR')).toBe(false);
    expect(snapshot.pathByStem.has('MMR-1')).toBe(false);

    const drops = validate(await readVaultGraph(client)).dropped;
    expect(drops.filter((drop) => drop.rule === 'duplicate-stem')).toHaveLength(2);
    expect(
      drops
        .filter((drop) => drop.kind === 'identity')
        .map((drop) => drop.path)
        .toSorted(),
    ).toEqual(['MMR/MMR.md', 'relocated/MMR.md']);
    expect(drops).toContainEqual({
      key: 'MMR',
      kind: 'node',
      rule: 'missing-project',
      stem: 'MMR-1',
    });
  },
);

test.skipIf(!NORN)(
  'createProject fails closed when relocated project documents collide on the requested key',
  async () => {
    const projectFields = [
      jsonField('type', 'project'),
      jsonField('key', 'MMR'),
      jsonField('name', 'Mimir'),
    ];
    await writeDoc('relocated-a/MMR.md', projectFields);
    await writeDoc('relocated-b/MMR.md', projectFields);

    const snapshot = await loadNornSnapshot(client);
    expect(snapshot.workingSet.projects).toEqual([]);

    const store = createNornWriteStore(client, join(root, 'vault'));
    await expectMimirError('conflict', () =>
      createProject(store, { key: 'MMR', name: 'Third collider' }),
    );
    expect(snapshot.collidingPathsByStem.get('MMR')).toEqual([
      'relocated-a/MMR.md',
      'relocated-b/MMR.md',
    ]);

    const projectDocs = (await client.find({ in: ['type:project'], no_limit: true })).filter(
      (doc) => doc.frontmatter?.key === 'MMR',
    );
    expect(projectDocs.map((doc) => doc.path).toSorted()).toEqual([
      'relocated-a/MMR.md',
      'relocated-b/MMR.md',
    ]);
  },
);

// ── Referential-integrity guards: a malformed vault fails loud, never silently
// projects a corrupt WorkingSet (the reader enforces the referential invariants). ──

const TS = '2026-06-01T00:00:00.000Z';

async function writeProjectDoc(key: string): Promise<void> {
  await writeDoc(`${key}/${key}.md`, [
    jsonField('type', 'project'),
    jsonField('key', key),
    jsonField('name', key),
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
}

// ADR 0017 / MMR-181: the reader is data-tolerant of referential corruption —
// it drops the invalid node/edge and emits a valid closed subgraph instead of
// throwing, so one bad record can't take the whole load down.
test.skipIf(!NORN)('drops a node whose owning project is absent (no throw)', async () => {
  await writeProjectDoc('MMR');
  await writeDoc('MMR/MMR-1.md', [
    jsonField('type', 'task'),
    jsonField('title', 'Kept'),
    jsonField('parent', wikilink('MMR')),
    jsonField('lifecycle', 'todo'),
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
  // ZZZ-1 has no ZZZ project document → hidden, and its siblings would be too.
  await writeDoc('ZZZ/ZZZ-1.md', [
    jsonField('type', 'task'),
    jsonField('title', 'Orphan'),
    jsonField('parent', wikilink('ZZZ')),
    jsonField('lifecycle', 'todo'),
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
  const ws = await loadWorkingSetOverNorn(client);
  // ZZZ-1 dropped (no ZZZ project); MMR-1 the lone survivor. Resolve each
  // survivor's REAL project key (not a hardcoded 'MMR') so an inverted regression
  // — keep ZZZ-1, drop MMR-1 — can't render as 'MMR-1' and pass green.
  expect(ws.nodes.map((n) => n.id)).toEqual(['MMR-1']);
});

test.skipIf(!NORN)('drops a dangling KEY-seq parent edge; the node floats to root', async () => {
  await writeProjectDoc('MMR');
  await writeDoc('MMR/MMR-1.md', [
    jsonField('type', 'task'),
    jsonField('title', 'Lost'),
    jsonField('parent', wikilink('MMR-99')), // no such node
    jsonField('lifecycle', 'todo'),
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
  const ws = await loadWorkingSetOverNorn(client);
  const node = must(ws.nodes.find((n) => n.seq === 1));
  expect(node.parent_id).toBeNull(); // dangling parent dropped → floats to project root
});

// MMR-190: a relational ref written as an ALIASED wikilink `[[STEM|display]]`.
// `collapse` must keep the STEM so the ref resolves through the normal
// valid/dangling path — a dangling aliased parent floats to root with a proper
// drop (not a silent float on the `|`-laden literal that used to slip parseId),
// and readVaultGraph surfaces the de-aliased stem for doctor's finding.
test.skipIf(!NORN)(
  'drops a dangling aliased parent; readVaultGraph de-aliases the ref',
  async () => {
    await writeProjectDoc('MMR');
    await writeDoc('MMR/MMR-1.md', [
      jsonField('type', 'task'),
      jsonField('title', 'Aliased orphan'),
      jsonField('parent', aliasedWikilink('MMR-99', 'Some Title')), // no such node
      jsonField('lifecycle', 'todo'),
      jsonField('created', TS),
      jsonField('updated_at', TS),
    ]);
    // The raw graph surfaces the STEM, not the `|`-laden literal.
    const graph = await readVaultGraph(client);
    const orphan = must(graph.nodes.find((n) => n.stem === 'MMR-1'));
    expect(orphan.parent).toBe('MMR-99');
    // The loader drops the dangling edge and floats the node to root — no silent skip.
    const ws = await loadWorkingSetOverNorn(client);
    const node = must(ws.nodes.find((n) => n.seq === 1));
    expect(node.parent_id).toBeNull();
  },
);

test.skipIf(!NORN)(
  'drops a dangling aliased depends_on; readVaultGraph de-aliases the ref',
  async () => {
    await writeProjectDoc('MMR');
    await writeDoc('MMR/MMR-1.md', [
      jsonField('type', 'task'),
      jsonField('title', 'Dependent'),
      jsonField('parent', wikilink('MMR')),
      jsonField('lifecycle', 'todo'),
      jsonField('depends_on', [aliasedWikilink('MMR-99', 'Some Title')]), // no such node
      jsonField('created', TS),
      jsonField('updated_at', TS),
    ]);
    // The raw graph surfaces the STEM, not the `|`-laden literal.
    const graph = await readVaultGraph(client);
    const dependent = must(graph.nodes.find((n) => n.stem === 'MMR-1'));
    expect(dependent.dependsOn).toEqual(['MMR-99']);
    // The loader keeps the node and drops only the dangling prerequisite edge.
    const ws = await loadWorkingSetOverNorn(client);
    expect(ws.nodes.map((n) => renderId({ key: 'MMR', seq: n.seq }))).toEqual(['MMR-1']);
    expect(ws.edges).toEqual([]);
  },
);

// MMR-231: readVaultGraph carries each parsed doc's declared `project` (collapsed
// from the wikilink) so doctor's stem-vs-project divergence check can compare it to
// the stem — a present-but-wrong project resolves fine and is invisible to norn's
// required-field validate, so this read is the only surface that sees it.
test.skipIf(!NORN)('readVaultGraph carries collapsed project declarations (MMR-231)', async () => {
  await writeProjectDoc('MMR');
  await writeProjectDoc('OTH');
  // A node whose stem says MMR but whose project frontmatter points at OTH (valid).
  await writeDoc('MMR/MMR-1.md', [
    jsonField('type', 'task'),
    jsonField('title', 'Misfiled'),
    jsonField('parent', wikilink('MMR')),
    jsonField('lifecycle', 'todo'),
    jsonField('project', wikilink('OTH')), // diverges from the stem's key
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
  const declarations = (await readVaultGraph(client)).declarations ?? [];
  // The node's project wikilink is collapsed to a bare key, paired with its stem —
  // the divergence input (stem key MMR ≠ declared OTH).
  expect(declarations).toContainEqual({
    kind: 'node',
    path: 'MMR/MMR-1.md',
    project: 'OTH',
    stem: 'MMR-1',
  });
  // Project docs produce a declaration entry too (this helper writes no `project`
  // field, so it collapses to null — the real self-referential value is MMR-170's).
  expect(declarations).toContainEqual({
    kind: 'project',
    path: 'MMR/MMR.md',
    project: null,
    stem: 'MMR',
  });
});

// MMR-239: readSectionFailures surfaces docs whose History/Annotations heading
// norn cannot resolve (a hand-edited duplicate → ambiguous → read empty).
test.skipIf(!NORN)(
  'readSectionFailures reports ambiguous History/Annotations headings',
  async () => {
    const fm = (title: string): [string, unknown][] => [
      jsonField('type', 'task'),
      jsonField('title', title),
      jsonField('parent', wikilink('MMR')),
      jsonField('lifecycle', 'todo'),
      jsonField('project', wikilink('MMR')),
      jsonField('created', TS),
      jsonField('updated_at', TS),
    ];
    // The project doc carries a real ## History (as production creates it), so it is
    // not itself a failure.
    await writeDoc(
      'MMR/MMR.md',
      [
        jsonField('type', 'project'),
        jsonField('key', 'MMR'),
        jsonField('name', 'MMR'),
        jsonField('created', TS),
        jsonField('updated_at', TS),
      ],
      renderHistoryBody(),
    );
    // Duplicate ## History → History unresolvable (Annotations is fine).
    await writeDoc(
      'MMR/MMR-1.md',
      fm('DupHistory'),
      '## Task Description\n\n## History\n### a\nx\n## History\n### b\ny\n## Annotations\n',
    );
    // Duplicate ## Annotations → Annotations unresolvable (History is fine).
    await writeDoc(
      'MMR/MMR-2.md',
      fm('DupAnnotations'),
      '## Task Description\n\n## History\n## Annotations\n### a\n## Annotations\n### b\n',
    );
    // A healthy node — neither section is ambiguous.
    await writeDoc('MMR/MMR-3.md', fm('Healthy'), renderNodeBody(null));

    const failures = await readSectionFailures(client);
    expect(failures).toContainEqual({
      path: 'MMR/MMR-1.md',
      section: 'History',
      stem: 'MMR-1',
    });
    expect(failures).toContainEqual({
      path: 'MMR/MMR-2.md',
      section: 'Annotations',
      stem: 'MMR-2',
    });
    // The healthy node and the project doc are reported for neither section.
    expect(failures.some((f) => f.stem === 'MMR-3' || f.stem === 'MMR')).toBe(false);
  },
);

/** MMR-186: does the validator report MMR-2's hand-injected dangling MMR-999 dep? */
const mmr2DanglerReported = (d: { rule: string; stem: string; ref?: string }): boolean =>
  d.rule === 'dangling-depends-on' && d.stem === 'MMR-2' && d.ref === 'MMR-999';

// MMR-186: the write path must PRESERVE a validator-pruned dangling depends_on
// rather than silently erasing it. The reader drops it and doctor reports it (ADR
// 0017); a later edit that rewrites depends_on regenerates the field from
// survivors, so without the re-merge the CAS write would match disk and quietly
// delete the corruption doctor is meant to surface. Repair stays doctor --fix
// (MMR-183). Proven end-to-end against a real `norn` apply.
test.skipIf(!NORN)(
  'preserves a validator-pruned dangling depends_on across a real edit; doctor still reports it',
  async () => {
    await writeProjectDoc('MMR');
    await writeDoc('MMR/MMR-1.md', [
      jsonField('type', 'task'),
      jsonField('title', 'Prereq'),
      jsonField('parent', wikilink('MMR')),
      jsonField('lifecycle', 'todo'),
      jsonField('created', TS),
      jsonField('updated_at', TS),
    ]);
    // A real node body (## History / ## Annotations) so the edit's transition
    // append lands — a hand-injected dangling depends_on on an otherwise valid doc.
    await writeDoc(
      'MMR/MMR-2.md',
      [
        jsonField('type', 'task'),
        jsonField('title', 'Dependent'),
        jsonField('parent', wikilink('MMR')),
        jsonField('lifecycle', 'todo'),
        jsonField('depends_on', [wikilink('MMR-1'), wikilink('MMR-999')]), // MMR-999 dangles
        jsonField('created', TS),
        jsonField('updated_at', TS),
      ],
      renderNodeBody(null),
    );

    // Baseline: the reader drops MMR-999 and doctor's validator reports it.
    expect(validate(await readVaultGraph(client)).dropped.some(mmr2DanglerReported)).toBe(true);

    // A real edit to depends_on (remove the one visible edge) applied by norn.
    const writeStore = createNornWriteStore(client, join(root, 'vault'));
    const ws = await writeStore.loadWorkingSet();
    const prereq = must(ws.nodes.find((n) => n.seq === 1));
    const dependent = must(ws.nodes.find((n) => n.seq === 2));
    await undepend(writeStore, dependent.id, [prereq.id]);

    // On disk after the apply: the visible edge is gone, the dangler survives.
    const graph = await readVaultGraph(client);
    const doc2 = must(graph.nodes.find((n) => n.stem === 'MMR-2'));
    expect(doc2.dependsOn).toContain('MMR-999');
    expect(doc2.dependsOn).not.toContain('MMR-1');
    // And doctor's validator still reports the corruption (it was not erased).
    expect(validate(graph).dropped.some(mmr2DanglerReported)).toBe(true);
  },
);

// ADR 0017 / MMR-177: field-level corruption is tolerated too. A load-bearing
// field — lifecycle (drives status) or hold (drives blocked/parked) — missing or
// foreign drops the NODE (no safe absent value); an optional field — priority or
// size — foreign nulls just the FIELD and the node loads. Was a loud throw.
test.skipIf(!NORN)(
  'drops a task with no lifecycle but keeps a healthy sibling (no throw)',
  async () => {
    await writeProjectDoc('MMR');
    await writeDoc('MMR/MMR-1.md', [
      jsonField('type', 'task'),
      jsonField('title', 'No lifecycle'),
      jsonField('parent', wikilink('MMR')),
      jsonField('created', TS),
      jsonField('updated_at', TS),
    ]);
    // A healthy sibling proves the drop is SURGICAL — only the corrupt node goes.
    await writeDoc('MMR/MMR-2.md', [
      jsonField('type', 'task'),
      jsonField('title', 'Healthy'),
      jsonField('parent', wikilink('MMR')),
      jsonField('lifecycle', 'todo'),
      jsonField('created', TS),
      jsonField('updated_at', TS),
    ]);
    const ws = await loadWorkingSetOverNorn(client);
    // MMR-1 dropped for the missing load-bearing field; MMR-2 survives.
    expect(ws.nodes.map((n) => renderId({ key: 'MMR', seq: n.seq }))).toEqual(['MMR-2']);
  },
);

test.skipIf(!NORN)('drops a dangling prerequisite edge; the node stays (no throw)', async () => {
  await writeProjectDoc('MMR');
  await writeDoc('MMR/MMR-1.md', [
    jsonField('type', 'task'),
    jsonField('title', 'Dependent'),
    jsonField('parent', wikilink('MMR')),
    jsonField('lifecycle', 'todo'),
    jsonField('depends_on', [wikilink('MMR-99')]), // no such node
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
  const ws = await loadWorkingSetOverNorn(client);
  expect(ws.nodes.map((n) => renderId({ key: 'MMR', seq: n.seq }))).toEqual(['MMR-1']); // kept
  expect(ws.edges).toEqual([]); // dangling prerequisite dropped
});

// ADR 0017 / MMR-174: a self-dependency is the degenerate cycle — the validator
// drops the self-edge and the node loads cleanly, no throw (was a loud throw).
test.skipIf(!NORN)(
  'drops a self-dependency; the node stays with no self-edge (no throw)',
  async () => {
    await writeProjectDoc('MMR');
    await writeDoc('MMR/MMR-1.md', [
      jsonField('type', 'task'),
      jsonField('title', 'Self'),
      jsonField('parent', wikilink('MMR')),
      jsonField('lifecycle', 'todo'),
      jsonField('depends_on', [wikilink('MMR-1')]),
      jsonField('created', TS),
      jsonField('updated_at', TS),
    ]);
    const ws = await loadWorkingSetOverNorn(client);
    expect(ws.nodes.map((n) => renderId({ key: 'MMR', seq: n.seq }))).toEqual(['MMR-1']); // kept
    expect(ws.edges).toEqual([]); // the self-dependency dropped — no edge
  },
);

// A longer depends_on cycle: both nodes load, only the cycle-closing back edge is
// dropped — the loader once silently accepted this and then derived wrongly.
test.skipIf(!NORN)('drops one edge of a 2-node depends_on cycle; both nodes load', async () => {
  await writeProjectDoc('MMR');
  await writeDoc('MMR/MMR-1.md', [
    jsonField('type', 'task'),
    jsonField('title', 'One'),
    jsonField('parent', wikilink('MMR')),
    jsonField('lifecycle', 'todo'),
    jsonField('depends_on', [wikilink('MMR-2')]),
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
  await writeDoc('MMR/MMR-2.md', [
    jsonField('type', 'task'),
    jsonField('title', 'Two'),
    jsonField('parent', wikilink('MMR')),
    jsonField('lifecycle', 'todo'),
    jsonField('depends_on', [wikilink('MMR-1')]), // closes the cycle
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
  const ws = await loadWorkingSetOverNorn(client);
  const byId = new Map(ws.nodes.map((n) => [n.id, n]));
  expect(ws.nodes.map((n) => renderId({ key: 'MMR', seq: n.seq })).toSorted()).toEqual([
    'MMR-1',
    'MMR-2',
  ]);
  // The canonical back edge MMR-2 → MMR-1 is dropped; the forward edge MMR-1 →
  // MMR-2 survives. Assert the one surviving edge resolves that way.
  expect(ws.edges).toHaveLength(1);
  const edge = must(ws.edges[0]);
  expect(must(byId.get(edge.node_id)).seq).toBe(1); // MMR-1 depends on...
  expect(must(byId.get(edge.depends_on_node_id)).seq).toBe(2); // ...MMR-2
});

test.skipIf(!NORN)('drops a task with a foreign hold value (no throw)', async () => {
  await writeProjectDoc('MMR');
  // hold drives blocked/parked, so a foreign value has no safe coercion (unlike an
  // absent hold, which legitimately reconstructs to the 'none' default) — the node
  // is dropped rather than silently coerced.
  await writeDoc('MMR/MMR-1.md', [
    jsonField('type', 'task'),
    jsonField('title', 'Bogus hold'),
    jsonField('parent', wikilink('MMR')),
    jsonField('lifecycle', 'todo'),
    jsonField('hold', 'bogus'),
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
  // A healthy sibling proves the drop is surgical — only the corrupt node goes.
  await writeDoc('MMR/MMR-2.md', [
    jsonField('type', 'task'),
    jsonField('title', 'Healthy'),
    jsonField('parent', wikilink('MMR')),
    jsonField('lifecycle', 'todo'),
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
  const ws = await loadWorkingSetOverNorn(client);
  // MMR-1 dropped for the foreign load-bearing field; MMR-2 survives.
  expect(ws.nodes.map((n) => renderId({ key: 'MMR', seq: n.seq }))).toEqual(['MMR-2']);
});

test.skipIf(!NORN)('loads a task with a foreign priority as null (no throw)', async () => {
  await writeProjectDoc('MMR');
  // priority is optional (null is a truthful "unset"), so a foreign value nulls the
  // field and the node survives — no throw, no drop.
  await writeDoc('MMR/MMR-1.md', [
    jsonField('type', 'task'),
    jsonField('title', 'Bogus priority'),
    jsonField('parent', wikilink('MMR')),
    jsonField('lifecycle', 'todo'),
    jsonField('priority', 'p9'),
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
  const ws = await loadWorkingSetOverNorn(client);
  const node = must(ws.nodes.find((n) => n.seq === 1));
  expect(node.priority).toBeNull();
});

test.skipIf(!NORN)('loads a task with a foreign size as null (no throw)', async () => {
  await writeProjectDoc('MMR');
  await writeDoc('MMR/MMR-1.md', [
    jsonField('type', 'task'),
    jsonField('title', 'Bogus size'),
    jsonField('parent', wikilink('MMR')),
    jsonField('lifecycle', 'todo'),
    jsonField('size', 'huge'),
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
  const ws = await loadWorkingSetOverNorn(client);
  const node = must(ws.nodes.find((n) => n.seq === 1));
  expect(node.size).toBeNull();
});

test.skipIf(!NORN)(
  'reads a task upstream: a wikilink KEY-sN collapses; a non-seed grammar nulls (MMR-244)',
  async () => {
    await writeProjectDoc('MMR');
    // A well-formed seed pointer (in wikilink form) collapses to its bare stem,
    // mirroring the validator's local view.
    await writeDoc('MMR/MMR-1.md', [
      jsonField('type', 'task'),
      jsonField('title', 'from a seed'),
      jsonField('parent', wikilink('MMR')),
      jsonField('lifecycle', 'todo'),
      jsonField('upstream', wikilink('MMR-s1')),
      jsonField('created', TS),
      jsonField('updated_at', TS),
    ]);
    // A value that is not a `KEY-sN` nulls the field (the grammar tier, like a
    // foreign priority/size). A DANGLING but well-formed ref would stay for the
    // resolving read seam (MMR-245) — the hot path loads no seeds.
    await writeDoc('MMR/MMR-2.md', [
      jsonField('type', 'task'),
      jsonField('title', 'bad upstream'),
      jsonField('parent', wikilink('MMR')),
      jsonField('lifecycle', 'todo'),
      jsonField('upstream', 'not-a-seed-id'),
      jsonField('created', TS),
      jsonField('updated_at', TS),
    ]);
    const ws = await loadWorkingSetOverNorn(client);
    expect(must(ws.nodes.find((n) => n.seq === 1)).upstream).toBe('MMR-s1');
    expect(must(ws.nodes.find((n) => n.seq === 2)).upstream).toBeNull();
  },
);

test.skipIf(!NORN)('deduplicates repeated depends_on wikilinks into one edge', async () => {
  await writeProjectDoc('MMR');
  await writeDoc('MMR/MMR-1.md', [
    jsonField('type', 'task'),
    jsonField('title', 'Prereq'),
    jsonField('parent', wikilink('MMR')),
    jsonField('lifecycle', 'todo'),
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
  await writeDoc('MMR/MMR-2.md', [
    jsonField('type', 'task'),
    jsonField('title', 'Dependent'),
    jsonField('parent', wikilink('MMR')),
    jsonField('lifecycle', 'todo'),
    jsonField('depends_on', [wikilink('MMR-1'), wikilink('MMR-1')]),
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
  const ws = await loadWorkingSetOverNorn(client);
  expect(ws.edges).toHaveLength(1);
});

test.skipIf(!NORN)('ignores task-only fields on a non-task document', async () => {
  await writeProjectDoc('MMR');
  await writeDoc('MMR/MMR-1.md', [
    jsonField('type', 'phase'),
    jsonField('title', 'Phase with stray fields'),
    jsonField('parent', wikilink('MMR')),
    jsonField('priority', 'p1'),
    jsonField('rank', 5),
    jsonField('created', TS),
    jsonField('updated_at', TS),
  ]);
  const ws = await loadWorkingSetOverNorn(client);
  const phase = must(ws.nodes[0]);
  expect(phase.type).toBe('phase');
  expect(phase.priority).toBeNull();
  expect(phase.rank).toBeNull();
});

// MMR-169: readVaultGraph reads raw parent/depends_on stems for doctor to
// enumerate; the tolerant loader (MMR-181) drops the same dangling edge and
// keeps loading. Both read the vault's referential truth — one raw, one dropped.
test.skipIf(!NORN)(
  'readVaultGraph reads raw refs; the loader tolerates a dangling parent',
  async () => {
    const at = '2026-07-05T00:00:00.000Z';
    await writeDoc('MMR/MMR.md', [
      jsonField('type', 'project'),
      jsonField('key', 'MMR'),
      jsonField('name', 'Mimir'),
      jsonField('created', at),
      jsonField('updated_at', at),
    ]);
    await writeDoc('MMR/MMR-1.md', [
      jsonField('type', 'initiative'),
      jsonField('title', 'Init'),
      jsonField('parent', wikilink('MMR')),
      jsonField('created', at),
      jsonField('updated_at', at),
    ]);
    // MMR-2's parent points at MMR-99, which does not exist — an orphan.
    await writeDoc('MMR/MMR-2.md', [
      jsonField('type', 'task'),
      jsonField('title', 'Orphan'),
      jsonField('parent', wikilink('MMR-99')),
      jsonField('lifecycle', 'todo'),
      jsonField('depends_on', [wikilink('MMR-1')]),
      jsonField('created', at),
      jsonField('updated_at', at),
    ]);

    // Reading the raw graph never throws and surfaces the dangling parent verbatim.
    const graph = await readVaultGraph(client);
    const orphan = must(graph.nodes.find((n) => n.stem === 'MMR-2'));
    expect(orphan.parent).toBe('MMR-99');
    expect(orphan.dependsOn).toEqual(['MMR-1']); // a resolvable prereq decodes too
    expect(graph.projectKeys).toEqual(['MMR']); // the project partition, by `key`

    // The tolerant loader (MMR-181) no longer throws: MMR-2 loads with its
    // dangling parent dropped (floated to root), its resolvable prereq intact.
    const ws = await loadWorkingSetOverNorn(client);
    const loaded = must(ws.nodes.find((n) => n.seq === 2));
    expect(loaded.parent_id).toBeNull(); // MMR-99 edge dropped
    expect(ws.edges).toHaveLength(1); // MMR-2 → MMR-1 survives
  },
);

// readVaultGraph.nodes must hold only the docs the loader actually resolves refs
// for — its `rawNodes` partition (task/phase/initiative with a KEY-seq stem). A
// project's stray ref and an invalid-stem node's ref are NEVER resolved by the
// loader, so surfacing them would make doctor false-positive a vault that loads.
test.skipIf(!NORN)(
  'readVaultGraph skips projects and invalid-stem docs from nodes (no false positives)',
  async () => {
    const at = '2026-07-05T00:00:00.000Z';
    // A project carrying a stray depends_on the loader never resolves...
    await writeDoc('MMR/MMR.md', [
      jsonField('type', 'project'),
      jsonField('key', 'MMR'),
      jsonField('name', 'Mimir'),
      jsonField('depends_on', [wikilink('MMR-99')]),
      jsonField('created', at),
      jsonField('updated_at', at),
    ]);
    // ...and a task at a non-KEY-seq stem the loader drops.
    await writeDoc('MMR/notes.md', [
      jsonField('type', 'task'),
      jsonField('title', 'Loose'),
      jsonField('parent', wikilink('MMR-99')),
      jsonField('created', at),
      jsonField('updated_at', at),
    ]);

    // Neither breaks the load: the project isn't a node, 'notes' is dropped.
    const ws = await loadWorkingSetOverNorn(client);
    expect(ws.nodes).toHaveLength(0);
    // So readVaultGraph.nodes must surface neither — else doctor flags a readable
    // vault. The project's `key` is still captured (its own partition).
    const graph = await readVaultGraph(client);
    expect(graph.nodes).toHaveLength(0);
    expect(graph.projectKeys).toEqual(['MMR']);
  },
);

// MMR-178: a node whose owning project has no document. readVaultGraph surfaces
// the node with an empty projectKeys set; the tolerant loader (MMR-181) hides
// it — the premise the missing-project check exists for.
test.skipIf(!NORN)(
  'readVaultGraph surfaces a node with no project; the loader hides it',
  async () => {
    const at = '2026-07-05T00:00:00.000Z';
    // A well-formed task MMR-2 (root under project MMR, with a lifecycle so a
    // failure to drop it would surface the node rather than throw on a missing
    // field — the drop is then the sole reason the load returns []) but NO
    // project MMR doc.
    await writeDoc('MMR/MMR-2.md', [
      jsonField('type', 'task'),
      jsonField('title', 'Homeless'),
      jsonField('parent', wikilink('MMR')),
      jsonField('lifecycle', 'todo'),
      jsonField('created', at),
      jsonField('updated_at', at),
    ]);

    const graph = await readVaultGraph(client);
    expect(graph.nodes.map((n) => n.stem)).toEqual(['MMR-2']);
    expect(graph.projectKeys).toEqual([]); // no project doc → the missing-project case

    // The tolerant loader (MMR-181) hides the node instead of throwing — a
    // missing container has no valid place for its nodes to live.
    const ws = await loadWorkingSetOverNorn(client);
    expect(ws.nodes).toEqual([]);
  },
);

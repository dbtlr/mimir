import { expect, test } from 'bun:test';

import { fakeIo } from '../cli/testing';
import { renderMigratedNodeBody, renderNodeBody } from '../core/history-codec';
import { parseId } from '../core/ids';
import type { NodeRefs } from '../core/store-norn';
import { decodeValidateFindings } from '../norn/decode';
import { cmdDoctor } from './commands';
import type { DoctorDeps } from './commands';

/**
 * A doctor deps whose vault holds exactly these `{ stem, body }` documents.
 * `nodes` drives the referential checks; it defaults to each doc as a root with
 * no prerequisites, so body-section tests see no relational findings.
 * `projectKeys` defaults to every key present among the nodes' stems, so the
 * missing-project check stays silent unless a test deliberately omits one.
 */
function vaultOf(
  docs: { stem: string; body: string }[],
  nodes?: Omit<NodeRefs, 'key'>[],
  projectKeys?: string[],
  validateFindings?: unknown,
  sectionFailures?: { stem: string; section: string }[],
): DoctorDeps {
  const raw = nodes ?? docs.map((d) => ({ dependsOn: [], parent: null, stem: d.stem }));
  // Mirror production readVaultGraph: only valid KEY-seq stems are nodes, each
  // carrying its parsed project key (a non-KEY-seq stem is not a node).
  const graphNodes: NodeRefs[] = raw.flatMap((n) => {
    const key = parseId(n.stem)?.key;
    // Spread so an optional `type`/`raw` (field validity, MMR-177) flows through
    // unchanged; a referential-only node carries neither and skips the field pass.
    return key === undefined ? [] : [{ ...n, key }];
  });
  return {
    readSnapshot: () =>
      Promise.resolve({
        documents: docs.map(({ body, stem }) => ({
          body,
          documentHash: null,
          path: `${stem.split('-')[0] ?? stem}/${stem}.md`,
          stem,
        })),
        graph: {
          nodes: graphNodes,
          projectKeys: projectKeys ?? [...new Set(graphNodes.map((n) => n.key))],
        },
        sectionFailures: sectionFailures ?? [],
        // Production decodes Norn's defensive payload while building the snapshot.
        validateFindings: decodeValidateFindings(validateFindings ?? { findings: [] }),
      }),
  };
}

const CLEAN_HISTORY = renderMigratedNodeBody(
  'a task',
  [
    {
      at: '2026-07-03T10:00:00.000Z',
      from: 'todo',
      kind: 'lifecycle',
      reason: null,
      to: 'in_progress',
    },
  ],
  [],
);

// An unknown transition kind: the reader reads it as text (not a transition), so
// it is a `warn` — surfaced, but it does not gate.
const WARN_DOC = `## History\n### 2026-07-03T10:00:00.000Z — frobnicate\nactive → done\n## Annotations\n`;

// A valid record heading with no edge line: the reader DROPS the record, losing
// the transition — a genuine `error`-severity finding (informational label;
// doctor stays non-gating and exits 0 per ADR 0017).
const ERROR_DOC = `## History\n### 2026-07-03T10:00:00.000Z — lifecycle\n## Annotations\n`;

// A hand edit leaving an unescaped `### ` line inside a valid record's reason:
// the MMR-161 reader keeps it as reason content (lossless), so doctor must NOT
// error on it — it is a `warn` at most.
const TOLERATED_HASH_DOC = `## History\n### 2026-07-03T10:00:00.000Z — lifecycle\nactive → done\n### a hand note\n## Annotations\n`;

test('reports no problems and exits 0 over a clean vault', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([
      { body: renderNodeBody('a task'), stem: 'MMR-1' },
      { body: CLEAN_HISTORY, stem: 'MMR-2' },
    ]),
    'table',
    undefined,
  );
  expect(code).toBe(0);
  expect(io.out.join('')).toContain('no problems found');
  expect(io.err.join('')).toBe('');
});

test('a dropped record (missing edge) is an error alert on stderr, exit 0 (non-gating)', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([{ body: ERROR_DOC, stem: 'MMR-9' }]),
    'table',
    undefined,
  );
  expect(code).toBe(0);
  expect(io.out.join('')).toBe(''); // errors are the loud channel: stderr only
  const err = io.err.join('');
  expect(err).toContain('[error]');
  expect(err).toContain('MMR-9');
  expect(err).toContain('dropped on read');
  expect(err).toContain('History · line 2');
});

test('an unknown kind is a non-gating warn (exit 0), not an error', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([{ body: WARN_DOC, stem: 'MMR-9' }]),
    'table',
    undefined,
  );
  expect(code).toBe(0); // a warn never gates a cutover
  expect(io.err.join('')).toContain('[warn]');
  expect(io.err.join('')).toContain('unknown transition kind');
});

test('an unescaped heading inside a valid reason is a warn, not an error (MMR-161 tolerance)', async () => {
  // The reader absorbs `### a hand note` as reason content losslessly, so doctor
  // must not error or gate on it — regression against flagging tolerated content.
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([{ body: TOLERATED_HASH_DOC, stem: 'MMR-9' }]),
    'json',
    undefined,
  );
  expect(code).toBe(0);
  const findings = JSON.parse(io.out.join('')) as { severity: string; where: string }[];
  expect(findings).toHaveLength(1);
  expect(findings[0]?.severity).toBe('warn');
});

test('json format emits a pretty findings array on stdout, exit 0 on an error', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([{ body: ERROR_DOC, stem: 'MMR-9' }]),
    'json',
    undefined,
  );
  expect(code).toBe(0);
  const out = io.out.join('');
  expect(out).toContain('\n  '); // 2-space pretty-printed, not compact
  const findings = JSON.parse(out) as { node: string; check: string; severity: string }[];
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ check: 'body-sections', node: 'MMR-9', severity: 'error' });
});

test('jsonl format emits one finding per line (NDJSON), not a single array', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([
      { body: ERROR_DOC, stem: 'MMR-9' },
      { body: WARN_DOC, stem: 'MMR-8' },
    ]),
    'jsonl',
    undefined,
  );
  expect(code).toBe(0); // one is error-severity, but doctor never gates
  const lines = io.out.join('').split('\n');
  expect(lines).toHaveLength(2);
  const parsed = lines.map((l) => JSON.parse(l) as { node: string });
  expect(parsed.map((p) => p.node).toSorted()).toEqual(['MMR-8', 'MMR-9']);
});

test('the -s scope keeps the project and its nodes, dropping other projects', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([
      { body: ERROR_DOC, stem: 'MMR-9' }, // in scope
      { body: ERROR_DOC, stem: 'MMR' }, // the project itself — in scope
      { body: ERROR_DOC, stem: 'OTH-3' }, // other project — filtered out
    ]),
    'json',
    'MMR',
  );
  expect(code).toBe(0);
  const findings = JSON.parse(io.out.join('')) as { node: string }[];
  expect(findings.map((f) => f.node).toSorted()).toEqual(['MMR', 'MMR-9']);
});

test('CLI reads one whole-vault snapshot, then filters per-document diagnostics by canonical stem (MMR-240, MMR-241)', async () => {
  let reads = 0;
  const deps: DoctorDeps = {
    readSnapshot: () => {
      reads += 1;
      return Promise.resolve({
        documents: [],
        graph: { nodes: [], projectKeys: [] },
        sectionFailures: [],
        validateFindings: [],
      });
    },
  };
  await cmdDoctor(fakeIo(), deps, 'json', 'MMR');
  await cmdDoctor(fakeIo(), deps, 'json', undefined);
  expect(reads).toBe(2);
});

test('corrupt project projections cannot hide per-document findings from canonical scope (MMR-240)', async () => {
  const docs = [
    {
      body: ERROR_DOC.replaceAll('\n', '\r\n'),
      projectedProject: 'OTH',
      stem: 'MMR-9',
    },
    {
      body: ERROR_DOC,
      projectedProject: 'MMR',
      stem: 'OTH-5',
    },
  ];
  const deps: DoctorDeps = {
    readSnapshot: () =>
      Promise.resolve({
        // Both projections are present in the one whole-vault snapshot. Scope
        // must ignore them and filter by the canonical stems instead.
        documents: docs.map(({ body, projectedProject, stem }) => ({
          body,
          documentHash: null,
          frontmatter: { project: projectedProject },
          path: `${stem.split('-')[0] ?? stem}/${stem}.md`,
          stem,
        })),
        graph: { nodes: [], projectKeys: [] },
        sectionFailures: docs.map(({ stem }) => ({ section: 'History', stem })),
        validateFindings: [],
      }),
  };

  const io = fakeIo();
  await cmdDoctor(io, deps, 'json', 'MMR');
  const findings = JSON.parse(io.out.join('')) as { check: string; node: string }[];

  expect(findings.map((finding) => finding.check).toSorted()).toEqual([
    'body-sections',
    'crlf',
    'section-resolution',
  ]);
  expect(findings.every((finding) => finding.node === 'MMR-9')).toBe(true);
});

test('a section-resolution failure is an error alert, exit 0 non-gating (MMR-239)', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    // A clean body, but norn could not resolve the History section (a duplicate or
    // missing heading) — the read degrades to empty, surfaced as an error.
    vaultOf([{ body: renderNodeBody('a task'), stem: 'MMR-9' }], undefined, undefined, undefined, [
      { section: 'History', stem: 'MMR-9' },
    ]),
    'json',
    undefined,
  );
  expect(code).toBe(0);
  const findings = JSON.parse(io.out.join('')) as {
    check: string;
    node: string;
    severity: string;
    where: string;
  }[];
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    check: 'section-resolution',
    node: 'MMR-9',
    severity: 'error',
    where: 'body · History',
  });
});

test('a section-failure whose stem is out of the -s scope is filtered out (MMR-239)', async () => {
  // The scoped section read selects on the corruptible `project` field, so a doc
  // whose field diverges into scope could carry an out-of-scope stem; the stem
  // backstop must exclude it, matching the body-section/frontmatter checks.
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([{ body: renderNodeBody('a task'), stem: 'MMR-9' }], undefined, undefined, undefined, [
      { section: 'History', stem: 'MMR-9' }, // in scope
      { section: 'Annotations', stem: 'OTH-5' }, // out of scope — its field says MMR, stem says OTH
    ]),
    'json',
    'MMR',
  );
  expect(code).toBe(0);
  const findings = JSON.parse(io.out.join('')) as { check: string; node: string }[];
  const sectionNodes = findings.filter((f) => f.check === 'section-resolution').map((f) => f.node);
  expect(sectionNodes).toEqual(['MMR-9']); // OTH-5 excluded by the stem backstop
});

// ── CRLF hygiene (MMR-176) ────────────────────────────────────────────────────

test('a body with CRLF line endings is a non-gating warn (exit 0) with a count', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([{ body: 'line one\r\nline two\r\n', stem: 'MMR-2' }]),
    'json',
    undefined,
  );
  expect(code).toBe(0); // CRLF is tolerated on read — a warn never gates
  const findings = JSON.parse(io.out.join('')) as {
    check: string;
    node: string;
    severity: string;
    where: string;
    message: string;
  }[];
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    check: 'crlf',
    node: 'MMR-2',
    severity: 'warn',
    where: 'body',
  });
  expect(findings[0]?.message).toContain('(2)'); // both lines counted
});

test('an all-LF body raises no CRLF finding', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([{ body: 'line one\nline two\n', stem: 'MMR-2' }]),
    'json',
    undefined,
  );
  expect(code).toBe(0);
  expect(JSON.parse(io.out.join('')) as unknown[]).toHaveLength(0);
});

// ── Dangling relational references (MMR-169) ──────────────────────────────────

test('a dangling parent is an error-severity finding (non-gating, exit 0)', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([], [{ dependsOn: [], parent: 'MMR-99', stem: 'MMR-2' }]),
    'json',
    undefined,
  );
  expect(code).toBe(0);
  const findings = JSON.parse(io.out.join('')) as {
    node: string;
    check: string;
    severity: string;
    where: string;
    message: string;
  }[];
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    check: 'dangling-refs',
    node: 'MMR-2',
    severity: 'error',
    where: 'frontmatter · parent',
  });
  expect(findings[0]?.message).toContain('MMR-99');
});

test('a dangling depends_on is an error-severity finding (non-gating, exit 0)', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([], [{ dependsOn: ['MMR-99'], parent: null, stem: 'MMR-2' }]),
    'json',
    undefined,
  );
  expect(code).toBe(0);
  const findings = JSON.parse(io.out.join('')) as { node: string; where: string }[];
  expect(findings).toHaveLength(1);
  expect(findings[0]?.where).toBe('frontmatter · depends_on');
});

test('resolved parent + depends_on and a bare-project-KEY root are all clean', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf(
      [],
      [
        { dependsOn: [], parent: 'MMR', stem: 'MMR-1' }, // root: bare project KEY, not a ref
        { dependsOn: ['MMR-1'], parent: 'MMR-1', stem: 'MMR-2' }, // both resolve
      ],
    ),
    'json',
    undefined,
  );
  expect(code).toBe(0);
  expect(JSON.parse(io.out.join('')) as unknown[]).toHaveLength(0);
});

test('a self-dependency is not a dangling ref (its target resolves) — an acyclicity finding', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([], [{ dependsOn: ['MMR-2'], parent: null, stem: 'MMR-2' }]),
    'json',
    undefined,
  );
  expect(code).toBe(0); // the degenerate cycle is an acyclicity error (non-gating)
  const findings = JSON.parse(io.out.join('')) as { check: string }[];
  expect(findings).toHaveLength(1);
  expect(findings[0]?.check).toBe('acyclicity'); // not dangling-refs
});

test('dangling refs report whole-vault, ignoring -s (a broken load is global)', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    // The dangler is under OTH, out of the MMR scope — but it breaks the whole
    // vault load, so doctor must still surface it.
    vaultOf([], [{ dependsOn: [], parent: 'OTH-99', stem: 'OTH-3' }], ['OTH']),
    'json',
    'MMR',
  );
  expect(code).toBe(0);
  const findings = JSON.parse(io.out.join('')) as { node: string }[];
  expect(findings.map((f) => f.node)).toEqual(['OTH-3']);
});

// ── Node → project references (MMR-178) ───────────────────────────────────────

test('a node whose project has no document is an error-severity finding (non-gating, exit 0)', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    // MMR-2 is a well-formed node with no dangling ref, but project MMR is absent.
    vaultOf([], [{ dependsOn: [], parent: null, stem: 'MMR-2' }], []),
    'json',
    undefined,
  );
  expect(code).toBe(0);
  const findings = JSON.parse(io.out.join('')) as {
    node: string;
    check: string;
    severity: string;
    where: string;
    message: string;
  }[];
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    check: 'missing-project',
    node: 'MMR-2',
    severity: 'error',
    where: 'project',
  });
  expect(findings[0]?.message).toContain('MMR');
});

test('a node whose project document is present is clean', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([], [{ dependsOn: [], parent: null, stem: 'MMR-2' }], ['MMR']),
    'json',
    undefined,
  );
  expect(code).toBe(0);
  expect(JSON.parse(io.out.join('')) as unknown[]).toHaveLength(0);
});

test('missing-project reports whole-vault, ignoring -s (a broken load is global)', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    // The orphaned node is under OTH, out of the MMR scope — still surfaced.
    vaultOf([], [{ dependsOn: [], parent: null, stem: 'OTH-3' }], []),
    'json',
    'MMR',
  );
  expect(code).toBe(0);
  const findings = JSON.parse(io.out.join('')) as { node: string; check: string }[];
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ check: 'missing-project', node: 'OTH-3' });
});

// ── Relational acyclicity (MMR-174) ───────────────────────────────────────────

test('a depends_on cycle is an acyclicity error-severity finding (non-gating, exit 0)', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf(
      [],
      [
        { dependsOn: ['MMR-2'], parent: null, stem: 'MMR-1' },
        { dependsOn: ['MMR-1'], parent: null, stem: 'MMR-2' }, // closes the cycle
      ],
    ),
    'json',
    undefined,
  );
  expect(code).toBe(0);
  const findings = JSON.parse(io.out.join('')) as {
    node: string;
    check: string;
    severity: string;
    where: string;
    message: string;
  }[];
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    check: 'acyclicity',
    node: 'MMR-2', // the canonical back edge is MMR-2 → MMR-1
    severity: 'error',
    where: 'frontmatter · depends_on',
  });
  expect(findings[0]?.message).toContain('MMR-1'); // names the cycle-closing ref
  expect(findings[0]?.message).toContain('closes a cycle');
});

test('a parent cycle is an acyclicity error anchored on the parent field', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf(
      [],
      [
        { dependsOn: [], parent: 'MMR-2', stem: 'MMR-1' },
        { dependsOn: [], parent: 'MMR-1', stem: 'MMR-2' }, // closes the cycle
      ],
    ),
    'json',
    undefined,
  );
  expect(code).toBe(0);
  const findings = JSON.parse(io.out.join('')) as { node: string; where: string }[];
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ node: 'MMR-2', where: 'frontmatter · parent' });
});

// ── Node field validity (MMR-177) ─────────────────────────────────────────────

test('a task missing lifecycle is a field-validity error naming the missing field', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf(
      [],
      [
        {
          dependsOn: [],
          parent: null,
          raw: { hold: undefined, lifecycle: undefined, priority: undefined, size: undefined },
          stem: 'MMR-1',
          type: 'task',
        },
      ],
    ),
    'json',
    undefined,
  );
  expect(code).toBe(0);
  const findings = JSON.parse(io.out.join('')) as {
    node: string;
    check: string;
    severity: string;
    where: string;
    message: string;
  }[];
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    check: 'field-validity',
    node: 'MMR-1',
    severity: 'error',
    where: 'frontmatter · lifecycle',
  });
  expect(findings[0]?.message).toContain('missing lifecycle');
});

test('a task with a foreign hold is a field-validity error naming the value', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf(
      [],
      [
        {
          dependsOn: [],
          parent: null,
          raw: { hold: 'bogus', lifecycle: 'todo', priority: undefined, size: undefined },
          stem: 'MMR-1',
          type: 'task',
        },
      ],
    ),
    'json',
    undefined,
  );
  expect(code).toBe(0);
  const findings = JSON.parse(io.out.join('')) as { where: string; message: string }[];
  expect(findings).toHaveLength(1);
  expect(findings[0]?.where).toBe('frontmatter · hold');
  expect(findings[0]?.message).toContain('invalid hold "bogus"');
});

test('a task with a foreign priority is a field-validity error (node kept, field nulled)', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf(
      [],
      [
        {
          dependsOn: [],
          parent: null,
          raw: { hold: undefined, lifecycle: 'todo', priority: 'p9', size: undefined },
          stem: 'MMR-1',
          type: 'task',
        },
      ],
    ),
    'json',
    undefined,
  );
  expect(code).toBe(0);
  const findings = JSON.parse(io.out.join('')) as {
    check: string;
    severity: string;
    where: string;
    message: string;
  }[];
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    check: 'field-validity',
    severity: 'error',
    where: 'frontmatter · priority',
  });
  expect(findings[0]?.message).toContain('invalid priority "p9"');
});

test('a task with a foreign size is a field-validity error naming the value', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf(
      [],
      [
        {
          dependsOn: [],
          parent: null,
          raw: { hold: undefined, lifecycle: 'todo', priority: undefined, size: 'huge' },
          stem: 'MMR-1',
          type: 'task',
        },
      ],
    ),
    'json',
    undefined,
  );
  expect(code).toBe(0);
  const findings = JSON.parse(io.out.join('')) as { where: string; message: string }[];
  expect(findings).toHaveLength(1);
  expect(findings[0]?.where).toBe('frontmatter · size');
  expect(findings[0]?.message).toContain('invalid size "huge"');
});

test('many nodes under one missing project collapse to a single finding with a count', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf(
      [],
      [
        { dependsOn: [], parent: null, stem: 'MMR-2' },
        { dependsOn: [], parent: null, stem: 'MMR-3' },
        { dependsOn: [], parent: null, stem: 'MMR-4' },
      ],
      [], // project MMR absent — one root cause shared by all three
    ),
    'json',
    undefined,
  );
  expect(code).toBe(0);
  const findings = JSON.parse(io.out.join('')) as { check: string; message: string }[];
  expect(findings).toHaveLength(1); // not one per node
  expect(findings[0]?.check).toBe('missing-project');
  expect(findings[0]?.message).toContain('3 nodes');
});

// ── Shared validator pass (MMR-182) ───────────────────────────────────────────

test('distinct corruption classes each surface from the one shared validator pass, exit 0', async () => {
  // A dangling edge (dangling-refs), a cycle (acyclicity), and a foreign field
  // (field-validity) — three different rules from a single validate() the runner
  // computes once and every referential check reads. All report; nothing gates.
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf(
      [],
      [
        { dependsOn: [], parent: 'MMR-404', stem: 'MMR-1' }, // dangling parent
        { dependsOn: ['MMR-3'], parent: null, stem: 'MMR-2' },
        { dependsOn: ['MMR-2'], parent: null, stem: 'MMR-3' }, // MMR-2 ↔ MMR-3 cycle
        {
          dependsOn: [],
          parent: null,
          raw: { hold: undefined, lifecycle: 'todo', priority: 'p9', size: undefined },
          stem: 'MMR-4',
          type: 'task',
        }, // foreign priority
      ],
      ['MMR'],
    ),
    'json',
    undefined,
  );
  expect(code).toBe(0); // three error-severity classes, still non-gating
  const findings = JSON.parse(io.out.join('')) as { check: string }[];
  expect(findings.map((f) => f.check).toSorted()).toEqual([
    'acyclicity',
    'dangling-refs',
    'field-validity',
  ]);
});

// ── Frontmatter parse-failed + untyped documents (MMR-191) ────────────────────

// A representative `vault.validate` payload: a broken-YAML doc (no field), a
// missing-`type` doc, a foreign-`type` doc, a missing non-`type` field (must be
// EXCLUDED — the doc is still visible), and a non-work-state path (must be
// EXCLUDED — the vault may hold other docs).
const FRONTMATTER_FINDINGS = {
  findings: [
    { code: 'frontmatter-parse-failed', message: 'broken YAML', path: 'MMR/MMR-1.md' },
    {
      code: 'frontmatter-required-field-missing',
      field: 'type',
      message: 'missing type',
      path: 'MMR/MMR-2.md',
    },
    {
      // norn 0.47 (NRN-235) foreign-value code; the old-code path is locked by the
      // artifact test below (dual-key tolerance).
      code: 'value-not-allowed',
      field: 'type',
      message: 'foreign type',
      path: 'MMR/MMR-3.md',
    },
    // Missing `title` on an otherwise-typed doc — same code, different field:
    // the reader still sees the doc, so this check must NOT surface it.
    {
      code: 'frontmatter-required-field-missing',
      field: 'title',
      message: 'missing title',
      path: 'MMR/MMR-4.md',
    },
    // A non-work-state path (a stray vault note) — excluded regardless of code.
    { code: 'frontmatter-parse-failed', message: 'broken YAML', path: 'Notes/scratch.md' },
  ],
};

test('surfaces parse-failed + untyped work-state docs, excluding non-type fields and non-work-state paths', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([], [], undefined, FRONTMATTER_FINDINGS),
    'json',
    undefined,
  );
  expect(code).toBe(0); // the doc is invisible on read, but doctor never gates
  const findings = JSON.parse(io.out.join('')) as {
    check: string;
    node: string;
    severity: string;
    where: string;
    message: string;
  }[];
  // Exactly the three work-state, type-scoped findings — MMR-4 (title) and the
  // Notes/ stray are excluded.
  expect(findings.map((f) => f.node).toSorted()).toEqual(['MMR-1', 'MMR-2', 'MMR-3']);
  expect(findings.every((f) => f.check === 'frontmatter')).toBe(true);
  expect(findings.every((f) => f.severity === 'error')).toBe(true);
  const byNode = new Map(findings.map((f) => [f.node, f]));
  expect(byNode.get('MMR-1')?.message).toContain('parse');
  expect(byNode.get('MMR-1')?.where).toBe('frontmatter');
  expect(byNode.get('MMR-2')?.message).toContain('type');
  expect(byNode.get('MMR-2')?.where).toBe('frontmatter · type');
  expect(byNode.get('MMR-3')?.where).toBe('frontmatter · type');
});

test('a project doc (KEY/KEY.md) with a parse failure is surfaced by its project stem', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([], [], undefined, {
      findings: [{ code: 'frontmatter-parse-failed', path: 'MMR/MMR.md' }],
    }),
    'json',
    undefined,
  );
  expect(code).toBe(0);
  const findings = JSON.parse(io.out.join('')) as { check: string; node: string }[];
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ check: 'frontmatter', node: 'MMR' });
});

test('a stray KEY.md not in KEY/KEY.md form is not treated as a work-state project doc', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([], [], undefined, {
      findings: [{ code: 'frontmatter-parse-failed', path: 'MMR.md' }],
    }),
    'json',
    undefined,
  );
  expect(code).toBe(0);
  expect(JSON.parse(io.out.join('')) as unknown[]).toHaveLength(0);
});

test('an artifact doc (KEY/artifacts/KEY-aN.md) with a foreign type is surfaced by its artifact stem', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([], [], undefined, {
      findings: [
        {
          // Old (norn <=0.46) foreign-value code — kept to lock the dual-key
          // tolerance (0.47 renamed it `value-not-allowed`, exercised above).
          code: 'frontmatter-disallowed-value',
          field: 'type',
          message: 'foreign type',
          path: 'MMR/artifacts/MMR-a1.md',
        },
      ],
    }),
    'json',
    undefined,
  );
  expect(code).toBe(0);
  const findings = JSON.parse(io.out.join('')) as { check: string; node: string; where: string }[];
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    check: 'frontmatter',
    node: 'MMR-a1',
    where: 'frontmatter · type',
  });
});

test('a KEY-seq stem in the wrong parent dir (loose refs/AB-1.md) is excluded (node anchoring)', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    // A well-formed node stem, but its parent dir is `refs`, not its key `AB` —
    // not the vault's `KEY/KEY-seq.md` layout, so it is a loose file, not a node.
    vaultOf([], [], undefined, {
      findings: [{ code: 'frontmatter-parse-failed', path: 'refs/AB-1.md' }],
    }),
    'json',
    undefined,
  );
  expect(code).toBe(0);
  expect(JSON.parse(io.out.join('')) as unknown[]).toHaveLength(0);
});

test('a doc emitting BOTH parse-failed and required-missing(type) dedups to one parse-failed finding', async () => {
  // norn 0.44 emits both for an unparseable doc — the missing type is a
  // *consequence*. The check must report the doc once, keeping the root cause.
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([], [], undefined, {
      findings: [
        {
          code: 'frontmatter-required-field-missing',
          field: 'type',
          message: 'missing type',
          path: 'MMR/MMR-1.md',
        },
        {
          code: 'frontmatter-parse-failed',
          message: 'mapping values not allowed at line 3',
          path: 'MMR/MMR-1.md',
        },
      ],
    }),
    'json',
    undefined,
  );
  expect(code).toBe(0);
  const findings = JSON.parse(io.out.join('')) as {
    node: string;
    where: string;
    message: string;
  }[];
  expect(findings).toHaveLength(1); // one per doc, not two
  expect(findings[0]?.where).toBe('frontmatter'); // the parse-failed, not the type consequence
  // norn's own detail is carried through so a human can pinpoint the failure.
  expect(findings[0]?.message).toContain('mapping values not allowed at line 3');
});

test('a parse-failed finding carrying a spurious field still surfaces (field gate is type-only)', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    // parse-failed has no `field` gate — even a stray `field` must not suppress it.
    vaultOf([], [], undefined, {
      findings: [{ code: 'frontmatter-parse-failed', field: 'title', path: 'MMR/MMR-1.md' }],
    }),
    'json',
    undefined,
  );
  expect(code).toBe(0);
  const findings = JSON.parse(io.out.join('')) as { node: string; where: string }[];
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ node: 'MMR-1', where: 'frontmatter' });
});

test('the -s scope drops another project’s frontmatter findings (a per-document check)', async () => {
  const io = fakeIo();
  const code = await cmdDoctor(
    io,
    vaultOf([], [], undefined, {
      findings: [
        { code: 'frontmatter-parse-failed', path: 'MMR/MMR-1.md' }, // in MMR scope
        { code: 'frontmatter-parse-failed', path: 'OTH/OTH-3.md' }, // other project — dropped
      ],
    }),
    'json',
    'MMR',
  );
  expect(code).toBe(0);
  const findings = JSON.parse(io.out.join('')) as { node: string }[];
  expect(findings.map((f) => f.node)).toEqual(['MMR-1']);
});

test('a malformed / empty validate payload does not crash doctor', async () => {
  for (const payload of [
    undefined,
    null,
    42,
    'oops',
    {},
    { findings: 'nope' },
    { findings: [7] },
  ]) {
    const io = fakeIo();
    const code = await cmdDoctor(io, vaultOf([], [], undefined, payload), 'json', undefined);
    expect(code).toBe(0);
    expect(JSON.parse(io.out.join('')) as unknown[]).toHaveLength(0);
  }
});

test('doctor ITSELF failing (the vault read throws) propagates, not a swallowed exit 0', async () => {
  // The reserved nonzero case (ADR 0017): a successful run always exits 0, but a
  // doctor failure — the vault being unreachable — must surface as a rejection the
  // CLI turns into a nonzero exit, never get swallowed to 0. Guards against a
  // future try/catch that would silently gate-off this half of the contract.
  const io = fakeIo();
  const unreachable: DoctorDeps = {
    readSnapshot: () => Promise.reject(new Error('vault unreachable')),
  };
  let threw = false;
  try {
    await cmdDoctor(io, unreachable, 'json', undefined);
  } catch (e) {
    threw = true;
    expect((e as Error).message).toContain('vault unreachable');
  }
  expect(threw).toBe(true); // propagated, not swallowed to a 0 exit
});

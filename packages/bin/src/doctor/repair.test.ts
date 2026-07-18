import { expect, test } from 'bun:test';

import type { DoctorFinding, DoctorIssueCode } from './checks';
import { planDoctorRepairs, repairIssueKey, REPAIR_POLICY } from './repair';
import type { DoctorSnapshot, DoctorSnapshotDocument } from './snapshot';

function issue(
  code: DoctorIssueCode,
  stem: string,
  evidence: Record<string, unknown> = {},
  locator = 'test',
): DoctorFinding {
  const scopeKey = stem.split('-')[0] ?? stem;
  return {
    check: 'test',
    code,
    evidence,
    locator,
    message: code,
    node: stem,
    scopeKey,
    severity: 'error',
    stem,
    where: 'test',
  };
}

function snapshot(documents: DoctorSnapshotDocument[]): DoctorSnapshot {
  return {
    documents,
    graph: { nodes: [], projectKeys: [] },
    sectionFailures: [],
    validateFindings: [],
  };
}

test('the total repair registry explicitly classifies every current issue code', () => {
  expect(Object.keys(REPAIR_POLICY).toSorted()).toEqual([
    'archived-requester',
    'crlf-body',
    'cycle-depends-on',
    'cycle-parent',
    'dangling-depends-on',
    'dangling-parent',
    'dangling-spawned',
    'dangling-upstream',
    'duplicate-artifact-stem',
    'duplicate-stem',
    'frontmatter-disallowed-value',
    'frontmatter-parse-failed',
    'frontmatter-required-field-missing',
    'interior-seq-gap',
    'invalid-hold',
    'invalid-lifecycle',
    'invalid-open-ended',
    'invalid-priority',
    'invalid-seed-kind',
    'invalid-seed-lifecycle',
    'invalid-size',
    'malformed-history-heading',
    'malformed-upstream',
    'missing-project',
    'missing-updated-at',
    'non-iso-annotation-heading',
    'orphaned-seed',
    'section-annotations-unreadable',
    'section-history-unreadable',
    'stem-project-divergence',
    'unknown-requester',
    'unknown-transition-kind',
    'unparseable-history-record',
    'value-not-allowed',
  ]);
});

test('one snapshot becomes one deterministic CAS plan for all four recipes', () => {
  const snap = snapshot([
    {
      body: '## Task Description\r\ntext\r\n',
      documentHash: 'hash-1',
      frontmatter: { project: '[[WRONG]]', type: 'task' },
      path: 'MMR/MMR-1.md',
      stem: 'MMR-1',
    },
  ]);
  const planned = planDoctorRepairs({
    issues: [
      issue('missing-project', 'NEW-1', { key: 'NEW' }),
      issue('crlf-body', 'MMR-1', { count: 2 }),
      issue('stem-project-divergence', 'MMR-1', {
        actualProject: 'WRONG',
        canonicalProject: 'MMR',
      }),
      issue('section-history-unreadable', 'MMR-1', { section: 'History' }),
      issue('section-annotations-unreadable', 'MMR-1', { section: 'Annotations' }),
      issue('dangling-parent', 'MMR-1', { ref: 'MMR-99' }),
    ],
    scope: undefined,
    snapshot: snap,
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });

  expect(planned.failures).toEqual([]);
  expect(planned.skipped.map((item) => [item.issue.code, item.reason])).toEqual([
    ['dangling-parent', 'semantic-reference'],
  ]);
  expect(planned.planned).toHaveLength(5);
  expect(planned.migration.operations).toEqual([
    {
      fields: {
        expected_old_value: '[[WRONG]]',
        field: 'project',
        new_value: '[[MMR]]',
        path: 'MMR/MMR-1.md',
      },
      kind: 'set_frontmatter',
    },
    {
      fields: {
        new_value: {
          body: '## History\n### 2026-07-13T12:00:00.000Z — archive\nactive → archived\nRecovered by mimir doctor --fix because project NEW was missing.\n',
          frontmatter: {
            archived_at: '2026-07-13T12:00:00.000Z',
            created: '2026-07-13T12:00:00.000Z',
            key: 'NEW',
            name: 'Recovered NEW',
            project: '[[NEW]]',
            type: 'project',
            updated_at: '2026-07-13T12:00:00.000Z',
          },
        },
        path: 'NEW/NEW.md',
      },
      kind: 'create_document',
    },
    {
      fields: {
        document_hash: 'hash-1',
        new_value: '## Task Description\ntext\n## History\n## Annotations\n',
        path: 'MMR/MMR-1.md',
      },
      kind: 'replace_body',
    },
  ]);
});

test('canonical scope filters every write and occupied or ambiguous targets are stable skips', () => {
  const snap = snapshot([
    {
      body: '## History\nfirst\n## History\nsecond\n',
      documentHash: 'hash-mmr',
      path: 'MMR/MMR-1.md',
      stem: 'MMR-1',
    },
    {
      body: 'bad',
      documentHash: 'hash-new',
      path: 'NEW/NEW.md',
      stem: 'NEW',
    },
    {
      body: 'a\r\n',
      documentHash: 'hash-oth',
      path: 'OTH/OTH-1.md',
      stem: 'OTH-1',
    },
  ]);
  const planned = planDoctorRepairs({
    issues: [
      issue('section-history-unreadable', 'MMR-1'),
      issue('missing-project', 'NEW-1', { key: 'NEW' }),
      issue('crlf-body', 'OTH-1'),
    ],
    scope: 'MMR',
    snapshot: snap,
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  expect(planned.migration.operations).toEqual([]);
  expect(planned.skipped.map((item) => item.reason)).toEqual([
    'ambiguous-section-heading',
    'out-of-scope',
    'out-of-scope',
  ]);

  const occupied = planDoctorRepairs({
    issues: [issue('missing-project', 'NEW-1', { key: 'NEW' })],
    scope: 'NEW',
    snapshot: snap,
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  expect(occupied.migration.operations).toEqual([]);
  expect(occupied.skipped[0]?.reason).toBe('canonical-path-occupied');
});

test('a body recipe without a document hash is an operational planning failure', () => {
  const planned = planDoctorRepairs({
    issues: [issue('crlf-body', 'MMR-1')],
    scope: 'MMR',
    snapshot: snapshot([
      { body: 'a\r\n', documentHash: null, path: 'MMR/MMR-1.md', stem: 'MMR-1' },
    ]),
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  expect(planned.migration.operations).toEqual([]);
  expect(planned.failures[0]?.reason).toBe('missing-cas-hash');
});

test('supported repairs never choose a first document when an identity is duplicated', () => {
  const planned = planDoctorRepairs({
    issues: [issue('crlf-body', 'MMR-1'), issue('duplicate-stem', 'MMR-1')],
    scope: 'MMR',
    snapshot: snapshot([
      { body: 'first\r\n', documentHash: 'hash-a', path: 'a/MMR-1.md', stem: 'MMR-1' },
      { body: 'second\r\n', documentHash: 'hash-b', path: 'b/MMR-1.md', stem: 'MMR-1' },
    ]),
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  expect(planned.migration.operations).toEqual([]);
  expect(planned.skipped.map((item) => [item.issue.code, item.reason])).toEqual([
    ['crlf-body', 'ambiguous-identity'],
    ['duplicate-stem', 'ambiguous-identity'],
  ]);
});

test('body repair resolves a relocated project through its exact locator and logical owner', () => {
  const planned = planDoctorRepairs({
    issues: [issue('crlf-body', 'custom', { count: 1 }, 'relocated/custom.md')],
    scope: undefined,
    snapshot: {
      documents: [
        {
          body: 'project\r\n',
          documentHash: 'hash',
          frontmatter: { key: 'MMR', type: 'project' },
          path: 'relocated/custom.md',
          stem: 'custom',
        },
      ],
      graph: {
        nodes: [],
        projectKeys: ['MMR'],
        sources: [{ kind: 'project', path: 'relocated/custom.md', stem: 'MMR' }],
      },
      sectionFailures: [],
      validateFindings: [],
    },
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  expect(planned.skipped).toEqual([]);
  expect(planned.migration.operations).toEqual([
    {
      fields: {
        document_hash: 'hash',
        new_value: 'project\n',
        path: 'relocated/custom.md',
      },
      kind: 'replace_body',
    },
  ]);
});

test('missing-project recovery refuses an existing relocated logical project owner', () => {
  const planned = planDoctorRepairs({
    issues: [issue('missing-project', 'NEW-1', { key: 'NEW' })],
    scope: undefined,
    snapshot: {
      documents: [
        {
          body: 'project',
          documentHash: 'hash',
          frontmatter: { key: 'NEW', type: 'project' },
          path: 'relocated/custom.md',
          stem: 'custom',
        },
      ],
      graph: {
        nodes: [],
        projectKeys: ['NEW'],
        sources: [{ kind: 'project', path: 'relocated/custom.md', stem: 'NEW' }],
      },
      sectionFailures: [],
      validateFindings: [],
    },
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  expect(planned.migration.operations).toEqual([]);
  expect(planned.skipped[0]?.reason).toBe('ambiguous-identity');
});

test('project projection repair writes the relocated project logical owner key', () => {
  const planned = planDoctorRepairs({
    issues: [
      issue(
        'stem-project-divergence',
        'custom',
        { actualProject: 'WRONG', canonicalProject: 'MMR' },
        'relocated/custom.md',
      ),
    ],
    scope: undefined,
    snapshot: {
      documents: [
        {
          body: 'project',
          documentHash: 'hash',
          frontmatter: { key: 'MMR', project: '[[WRONG]]', type: 'project' },
          path: 'relocated/custom.md',
          stem: 'custom',
        },
      ],
      graph: {
        nodes: [],
        projectKeys: ['MMR'],
        sources: [{ kind: 'project', path: 'relocated/custom.md', stem: 'MMR' }],
      },
      sectionFailures: [],
      validateFindings: [],
    },
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  expect(planned.migration.operations[0]).toMatchObject({
    fields: { new_value: '[[MMR]]', path: 'relocated/custom.md' },
    kind: 'set_frontmatter',
  });
});

test('repair planning builds document and identity indexes once', () => {
  let pathReads = 0;
  const documents = Array.from({ length: 100 }, (_, index) => {
    const stem = `MMR-${String(index + 1)}`;
    return {
      body: 'body\r\n',
      documentHash: `hash-${String(index)}`,
      get path() {
        pathReads += 1;
        return `MMR/${stem}.md`;
      },
      stem,
    } satisfies DoctorSnapshotDocument;
  });
  const planned = planDoctorRepairs({
    issues: documents.map((doc) => issue('crlf-body', doc.stem, {}, `MMR/${doc.stem}.md`)),
    scope: undefined,
    snapshot: {
      documents,
      graph: {
        nodes: [],
        projectKeys: ['MMR'],
        sources: documents.map((doc) => ({ kind: 'node', path: doc.path, stem: doc.stem })),
      },
      sectionFailures: [],
      validateFindings: [],
    },
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  expect(planned.planned).toHaveLength(100);
  expect(pathReads).toBeLessThan(5_000);
});

test('Norn-equivalent heading variants remain byte-identical ambiguous skips', () => {
  for (const body of [
    'text\n## History ##\n',
    'text\n## History   \n',
    'text\n## **History**\n',
    'text\n## _History_\n',
  ]) {
    const planned = planDoctorRepairs({
      issues: [issue('section-history-unreadable', 'MMR-1')],
      scope: 'MMR',
      snapshot: snapshot([{ body, documentHash: 'hash', path: 'MMR/MMR-1.md', stem: 'MMR-1' }]),
      timestamp: '2026-07-13T12:00:00.000Z',
      vaultRoot: '/vault',
    });
    expect(planned.migration.operations).toEqual([]);
    expect(planned.skipped[0]?.reason).toBe('ambiguous-section-heading');
  }
});

test('a heading-shaped line inside fenced code is not a structural insertion anchor', () => {
  const body = '## Task Description\n```md\n## Annotations\n```\n';
  const planned = planDoctorRepairs({
    issues: [issue('section-history-unreadable', 'MMR-1')],
    scope: 'MMR',
    snapshot: snapshot([{ body, documentHash: 'hash', path: 'MMR/MMR-1.md', stem: 'MMR-1' }]),
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  expect(planned.migration.operations[0]).toMatchObject({
    fields: { new_value: `${body}## History\n` },
    kind: 'replace_body',
  });
});

test('an unclosed fenced block is an ambiguous skip because insertion cannot become structural', () => {
  const body = '## Task Description\n```md\nexample without closing fence\n';
  const planned = planDoctorRepairs({
    issues: [issue('section-history-unreadable', 'MMR-1')],
    scope: 'MMR',
    snapshot: snapshot([{ body, documentHash: 'hash', path: 'MMR/MMR-1.md', stem: 'MMR-1' }]),
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  expect(planned.migration.operations).toEqual([]);
  expect(planned.skipped).toEqual([
    { issue: issue('section-history-unreadable', 'MMR-1'), reason: 'ambiguous-section-heading' },
  ]);
});

test('resolver-visible nested and HTML-formatted headings remain byte-identical skips', () => {
  for (const body of ['> ## History\n', '- item\n\n  ## History\n', '## <i>History</i>\n']) {
    const planned = planDoctorRepairs({
      issues: [issue('section-history-unreadable', 'MMR-1')],
      scope: 'MMR',
      snapshot: snapshot([{ body, documentHash: 'hash', path: 'MMR/MMR-1.md', stem: 'MMR-1' }]),
      timestamp: '2026-07-13T12:00:00.000Z',
      vaultRoot: '/vault',
    });
    expect(planned.migration.operations).toEqual([]);
    expect(planned.skipped[0]?.reason).toBe('ambiguous-section-heading');
  }
});

test('Norn-equivalent target names at any heading depth or in image alt text are skips', () => {
  for (const body of [
    '# History\n',
    '### History\n',
    '## ![History](image.png)\n',
    '## ![ History ](image.png)\n',
    '## ![History][history-image]\n\n[history-image]: image.png\n',
  ]) {
    const planned = planDoctorRepairs({
      issues: [issue('section-history-unreadable', 'MMR-1')],
      scope: 'MMR',
      snapshot: snapshot([{ body, documentHash: 'hash', path: 'MMR/MMR-1.md', stem: 'MMR-1' }]),
      timestamp: '2026-07-13T12:00:00.000Z',
      vaultRoot: '/vault',
    });
    expect(planned.migration.operations).toEqual([]);
    expect(planned.skipped[0]?.reason).toBe('ambiguous-section-heading');
  }
});

test('image-alt HTML and Rust whitespace follow Norn heading-name semantics', () => {
  for (const body of ['## ![<i>History</i>](image.png)\n', '## \u0085History\u0085\n']) {
    const planned = planDoctorRepairs({
      issues: [issue('section-history-unreadable', 'MMR-1')],
      scope: 'MMR',
      snapshot: snapshot([{ body, documentHash: 'hash', path: 'MMR/MMR-1.md', stem: 'MMR-1' }]),
      timestamp: '2026-07-13T12:00:00.000Z',
      vaultRoot: '/vault',
    });
    expect(planned.migration.operations).toEqual([]);
  }

  const bom = '## \uFEFFHistory\uFEFF\n';
  const planned = planDoctorRepairs({
    issues: [issue('section-history-unreadable', 'MMR-1')],
    scope: 'MMR',
    snapshot: snapshot([{ body: bom, documentHash: 'hash', path: 'MMR/MMR-1.md', stem: 'MMR-1' }]),
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  expect(planned.migration.operations).toHaveLength(1);
});

test('a validate-only malformed owner makes a supported typed repair ambiguous', () => {
  const snap = snapshot([
    {
      body: '## Task Description\ntext\n',
      documentHash: 'hash',
      path: 'relocated/MMR-1.md',
      stem: 'MMR-1',
    },
  ]);
  snap.validateFindings = [{ code: 'frontmatter-parse-failed', path: 'MMR/MMR-1.md' }];
  const planned = planDoctorRepairs({
    issues: [issue('section-history-unreadable', 'MMR-1')],
    scope: 'MMR',
    snapshot: snap,
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  expect(planned.migration.operations).toEqual([]);
  expect(planned.skipped[0]?.reason).toBe('ambiguous-identity');
});

test('insertion before an indented structural heading preserves its source line bytes', () => {
  const planned = planDoctorRepairs({
    issues: [issue('section-history-unreadable', 'MMR-1')],
    scope: 'MMR',
    snapshot: snapshot([
      {
        body: '## Task Description\n   ## Annotations\n',
        documentHash: 'hash',
        path: 'MMR/MMR-1.md',
        stem: 'MMR-1',
      },
    ]),
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  expect(planned.migration.operations[0]).toMatchObject({
    fields: { new_value: '## Task Description\n## History\n   ## Annotations\n' },
    kind: 'replace_body',
  });
});

test('bare carriage returns still place History after prose and before Annotations', () => {
  const planned = planDoctorRepairs({
    issues: [issue('section-history-unreadable', 'MMR-1')],
    scope: 'MMR',
    snapshot: snapshot([
      {
        body: '## Task Description\rtext\r## Annotations\r',
        documentHash: 'hash',
        path: 'MMR/MMR-1.md',
        stem: 'MMR-1',
      },
    ]),
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  expect(planned.migration.operations[0]).toMatchObject({
    fields: {
      new_value: '## Task Description\rtext\r## History\n## Annotations\n',
    },
    kind: 'replace_body',
  });
});

test('scoped repair accounts for whole-vault findings as out-of-scope skips', () => {
  const planned = planDoctorRepairs({
    issues: [issue('crlf-body', 'MMR-1'), issue('dangling-parent', 'OTH-1')],
    scope: 'MMR',
    snapshot: snapshot([
      { body: 'x\r\n', documentHash: 'hash', path: 'MMR/MMR-1.md', stem: 'MMR-1' },
    ]),
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  expect(planned.skipped).toContainEqual({
    issue: issue('dangling-parent', 'OTH-1'),
    reason: 'out-of-scope',
  });
  expect(planned.migration.operations).toHaveLength(1);
});

// MMR-312: stamp-updated-at — the one recipe whose write cannot itself carry an
// updated_at CAS guard (the field is absent/null, exactly what the finding
// names), so it is planned as an unguarded add (absent) or a null-old-value set
// (present-but-null) rather than a value-guarded set_frontmatter.
test('stamp-updated-at adds the field, seeded from created, when it is absent', () => {
  const planned = planDoctorRepairs({
    issues: [issue('missing-updated-at', 'MMR-1', { present: false })],
    scope: 'MMR',
    snapshot: snapshot([
      {
        body: 'body',
        documentHash: 'hash',
        frontmatter: { created: '2026-01-01T00:00:00.000Z', type: 'task' },
        path: 'MMR/MMR-1.md',
        stem: 'MMR-1',
      },
    ]),
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  expect(planned.skipped).toEqual([]);
  expect(planned.failures).toEqual([]);
  expect(planned.migration.operations).toEqual([
    {
      fields: {
        field: 'updated_at',
        new_value: '2026-01-01T00:00:00.000Z',
        path: 'MMR/MMR-1.md',
      },
      kind: 'add_frontmatter',
    },
  ]);
});

test('stamp-updated-at sets the field against a null old value when it is present-but-null', () => {
  const planned = planDoctorRepairs({
    issues: [issue('missing-updated-at', 'MMR-1', { present: true })],
    scope: 'MMR',
    snapshot: snapshot([
      {
        body: 'body',
        documentHash: 'hash',
        frontmatter: { created: '2026-01-01T00:00:00.000Z', type: 'task', updated_at: null },
        path: 'MMR/MMR-1.md',
        stem: 'MMR-1',
      },
    ]),
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  expect(planned.migration.operations).toEqual([
    {
      fields: {
        expected_old_value: null,
        field: 'updated_at',
        new_value: '2026-01-01T00:00:00.000Z',
        path: 'MMR/MMR-1.md',
      },
      kind: 'set_frontmatter',
    },
  ]);
});

test('stamp-updated-at falls back to the repair timestamp when no created exists', () => {
  const planned = planDoctorRepairs({
    issues: [issue('missing-updated-at', 'MMR-1', { present: false })],
    scope: 'MMR',
    snapshot: snapshot([
      {
        body: 'body',
        documentHash: 'hash',
        frontmatter: { type: 'task' },
        path: 'MMR/MMR-1.md',
        stem: 'MMR-1',
      },
    ]),
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  expect(planned.migration.operations).toEqual([
    {
      fields: { field: 'updated_at', new_value: '2026-07-13T12:00:00.000Z', path: 'MMR/MMR-1.md' },
      kind: 'add_frontmatter',
    },
  ]);
});

test('missing-project verification identity is stable across representative nodes', () => {
  expect(repairIssueKey(issue('missing-project', 'MMR-1', { key: 'MMR' }))).toBe(
    repairIssueKey(issue('missing-project', 'MMR-99', { key: 'MMR' })),
  );
});

test('adding a heading after a lone carriage return produces a canonical LF post-image', () => {
  const planned = planDoctorRepairs({
    issues: [issue('section-history-unreadable', 'MMR-1')],
    scope: 'MMR',
    snapshot: snapshot([
      { body: 'text\r', documentHash: 'hash', path: 'MMR/MMR-1.md', stem: 'MMR-1' },
    ]),
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  expect(planned.migration.operations[0]).toMatchObject({
    fields: { new_value: 'text\n## History\n' },
    kind: 'replace_body',
  });
});

test('missing structural headings are inserted in canonical History then Annotations order', () => {
  for (const [body, issues] of [
    [
      '## Task Description\ntext\n',
      [
        issue('section-annotations-unreadable', 'MMR-1'),
        issue('section-history-unreadable', 'MMR-1'),
      ],
    ],
    ['## Task Description\ntext\n## Annotations\n', [issue('section-history-unreadable', 'MMR-1')]],
  ] as const) {
    const planned = planDoctorRepairs({
      issues,
      scope: 'MMR',
      snapshot: snapshot([{ body, documentHash: 'hash', path: 'MMR/MMR-1.md', stem: 'MMR-1' }]),
      timestamp: '2026-07-13T12:00:00.000Z',
      vaultRoot: '/vault',
    });
    const replacement = planned.migration.operations.find((op) => op.kind === 'replace_body');
    expect(replacement?.fields.new_value).toBe(
      '## Task Description\ntext\n## History\n## Annotations\n',
    );
  }
});

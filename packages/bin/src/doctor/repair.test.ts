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

function snapshot(
  documents: DoctorSnapshotDocument[],
  scratchpads?: DoctorSnapshotDocument[],
): DoctorSnapshot {
  return {
    documents,
    graph: { nodes: [], projectKeys: [] },
    ...(scratchpads === undefined ? {} : { scratchpads }),
    sectionFailures: [],
    validateFindings: [],
  };
}

test('the total repair registry explicitly classifies every current issue code', () => {
  expect(Object.keys(REPAIR_POLICY).toSorted()).toEqual([
    'agenda-sequence',
    'archived-requester',
    'crlf-body',
    'cycle-depends-on',
    'cycle-parent',
    'dangling-depends-on',
    'dangling-parent',
    'dangling-spawned',
    'dangling-upstream',
    'duplicate-agenda-section',
    'duplicate-artifact-stem',
    'duplicate-journal-section',
    'duplicate-next-section',
    'duplicate-stem',
    'empty-journal-entry',
    'frontmatter-disallowed-value',
    'frontmatter-parse-failed',
    'frontmatter-required-field-missing',
    'interior-seq-gap',
    'invalid-hold',
    'invalid-journal-timestamp',
    'invalid-lifecycle',
    'invalid-open-ended',
    'invalid-priority',
    'invalid-seed-kind',
    'invalid-seed-lifecycle',
    'invalid-size',
    'journal-sequence',
    'malformed-agenda-item',
    'malformed-history-heading',
    'malformed-journal-entry',
    'malformed-upstream',
    'missing-agenda-section',
    'missing-journal-section',
    'missing-project',
    'missing-updated-at',
    'non-canonical-record-timestamp',
    'non-canonical-timestamp',
    'non-iso-annotation-heading',
    'orphaned-seed',
    'scratchpad-created-after-updated',
    'scratchpad-cross-project-anchor',
    'scratchpad-dangling-anchor',
    'scratchpad-invalid-body',
    'scratchpad-invalid-created',
    'scratchpad-invalid-freezing-at',
    'scratchpad-invalid-path',
    'scratchpad-invalid-project',
    'scratchpad-invalid-title',
    'scratchpad-invalid-type',
    'scratchpad-invalid-updated-at',
    'scratchpad-malformed-anchor',
    'scratchpad-missing-project',
    'section-annotations-unreadable',
    'section-history-unreadable',
    'section-order',
    'stem-project-divergence',
    'superseded-reason-required',
    'uninterpretable-record-timestamp',
    'uninterpretable-timestamp',
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

test('stamp-updated-at ignores an unparseable created and stamps the repair timestamp', () => {
  const planned = planDoctorRepairs({
    issues: [issue('missing-updated-at', 'MMR-1', { present: false })],
    scope: 'MMR',
    snapshot: snapshot([
      {
        body: 'body',
        documentHash: 'hash',
        frontmatter: { created: 'sometime last winter', type: 'task' },
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

// MMR-351: the stamp seed must itself satisfy the canonical invariant. The docs
// missing `updated_at` are legacy ones, so their `created` is exactly where a
// non-canonical value lives — `Date.parse` would have accepted it and stamped
// corruption forward as a value nothing can normalize afterwards.

test('stamp-updated-at refuses a zone-less created and stamps the repair timestamp', () => {
  const planned = planDoctorRepairs({
    issues: [issue('missing-updated-at', 'MMR-1', { present: false })],
    scope: 'MMR',
    snapshot: snapshot([
      {
        body: 'body',
        documentHash: 'hash',
        // Date.parse accepts this and reads it as HOST-LOCAL time; copying it
        // into updated_at would mint an `uninterpretable-timestamp` that no
        // repair can ever fix, because the instant it meant was never stated.
        frontmatter: { created: '2026-01-01T00:00:00', type: 'task' },
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

test('stamp-updated-at seeds from a NORMALIZABLE created, in canonical form', () => {
  const planned = planDoctorRepairs({
    issues: [issue('missing-updated-at', 'MMR-1', { present: false })],
    scope: 'MMR',
    snapshot: snapshot([
      {
        body: 'body',
        documentHash: 'hash',
        frontmatter: { created: '2026-01-01T05:30:00+05:30', type: 'task' },
        path: 'MMR/MMR-1.md',
        stem: 'MMR-1',
      },
    ]),
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  // The offset value states its instant, so it still seeds the stamp — but the
  // stamp written is the canonical form of it, never the variant verbatim.
  expect(planned.migration.operations).toEqual([
    {
      fields: { field: 'updated_at', new_value: '2026-01-01T00:00:00.000Z', path: 'MMR/MMR-1.md' },
      kind: 'add_frontmatter',
    },
  ]);
});

// MMR-313: the seed store's mutating verbs share the MMR-303 co-write guard, so
// a seed with a missing/null updated_at is repaired by the same stamp recipe,
// seeded from the seed's `created` frontmatter key exactly as node/project docs.
test('stamp-updated-at adds the field to a seed, seeded from created, when it is absent', () => {
  const planned = planDoctorRepairs({
    issues: [issue('missing-updated-at', 'MMR-s1', { present: false })],
    scope: 'MMR',
    snapshot: snapshot([
      {
        body: 'body',
        documentHash: 'hash',
        frontmatter: { created: '2026-01-01T00:00:00.000Z', kind: 'feature', type: 'seed' },
        path: 'MMR/seeds/MMR-s1.md',
        stem: 'MMR-s1',
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
        path: 'MMR/seeds/MMR-s1.md',
      },
      kind: 'add_frontmatter',
    },
  ]);
});

test('stamp-updated-at sets a seed field against a null old value when it is present-but-null', () => {
  const planned = planDoctorRepairs({
    issues: [issue('missing-updated-at', 'MMR-s1', { present: true })],
    scope: 'MMR',
    snapshot: snapshot([
      {
        body: 'body',
        documentHash: 'hash',
        frontmatter: {
          created: '2026-01-01T00:00:00.000Z',
          kind: 'feature',
          type: 'seed',
          updated_at: null,
        },
        path: 'MMR/seeds/MMR-s1.md',
        stem: 'MMR-s1',
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
        path: 'MMR/seeds/MMR-s1.md',
      },
      kind: 'set_frontmatter',
    },
  ]);
});

// MMR-317: the artifact store's tag/title mutations share the co-write guard, so
// an artifact with a missing/null updated_at is repaired by the same stamp recipe.
// Artifacts live in the snapshot's separate `artifacts` slice (never `documents`),
// so the recipe reaches them only because the planner folds that slice into its
// doc + identity indexes.
test('stamp-updated-at adds the field to an artifact, seeded from created, when it is absent', () => {
  const planned = planDoctorRepairs({
    issues: [issue('missing-updated-at', 'MMR-a1', { present: false }, 'MMR/artifacts/MMR-a1.md')],
    scope: 'MMR',
    snapshot: {
      artifacts: [
        {
          frontmatter: { created: '2026-01-01T00:00:00.000Z', type: 'artifact' },
          path: 'MMR/artifacts/MMR-a1.md',
          stem: 'MMR-a1',
        },
      ],
      documents: [],
      graph: { nodes: [], projectKeys: [] },
      sectionFailures: [],
      validateFindings: [],
    },
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
        path: 'MMR/artifacts/MMR-a1.md',
      },
      kind: 'add_frontmatter',
    },
  ]);
});

test('stamp-updated-at sets an artifact field against a null old value when it is present-but-null', () => {
  const planned = planDoctorRepairs({
    issues: [issue('missing-updated-at', 'MMR-a1', { present: true }, 'MMR/artifacts/MMR-a1.md')],
    scope: 'MMR',
    snapshot: {
      artifacts: [
        {
          frontmatter: {
            created: '2026-01-01T00:00:00.000Z',
            type: 'artifact',
            updated_at: null,
          },
          path: 'MMR/artifacts/MMR-a1.md',
          stem: 'MMR-a1',
        },
      ],
      documents: [],
      graph: { nodes: [], projectKeys: [] },
      sectionFailures: [],
      validateFindings: [],
    },
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  expect(planned.migration.operations).toEqual([
    {
      fields: {
        expected_old_value: null,
        field: 'updated_at',
        new_value: '2026-01-01T00:00:00.000Z',
        path: 'MMR/artifacts/MMR-a1.md',
      },
      kind: 'set_frontmatter',
    },
  ]);
});

// The fabricated artifact index entry (`body: ''`, `documentHash: null`) is the
// fail-closed guard, not just filler: a body-affecting recipe that ever reaches
// an artifact stem plans a `missing-cas-hash` failure, never a `replace_body`
// over the fabricated empty body.
test('a body recipe reaching an artifact-slice doc fails closed on the fabricated hash (MMR-317)', () => {
  const planned = planDoctorRepairs({
    issues: [issue('section-history-unreadable', 'MMR-a1', {}, 'MMR/artifacts/MMR-a1.md')],
    scope: 'MMR',
    snapshot: {
      artifacts: [
        {
          frontmatter: { created: '2026-01-01T00:00:00.000Z', type: 'artifact' },
          path: 'MMR/artifacts/MMR-a1.md',
          stem: 'MMR-a1',
        },
      ],
      documents: [],
      graph: { nodes: [], projectKeys: [] },
      sectionFailures: [],
      validateFindings: [],
    },
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  expect(planned.migration.operations).toEqual([]);
  expect(planned.failures.map((item) => item.reason)).toEqual(['missing-cas-hash']);
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

// MMR-351: the two timestamp recipes. Both trust the finding's classification
// (the normalized form was computed at detection and is never recomputed here);
// the snapshot supplies only the CAS precondition and the addressed line.

test('normalize-timestamp writes the canonical value under a CAS on the observed one', () => {
  const planned = planDoctorRepairs({
    issues: [
      issue(
        'non-canonical-timestamp',
        'MMR-1',
        {
          canonical: '2026-01-01T00:00:00.000Z',
          field: 'updated_at',
          value: '2026-01-01T05:30:00+05:30',
        },
        'MMR/MMR-1.md',
      ),
    ],
    scope: 'MMR',
    snapshot: snapshot([
      {
        body: 'body',
        documentHash: 'hash',
        frontmatter: { type: 'task', updated_at: '2026-01-01T05:30:00+05:30' },
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
        expected_old_value: '2026-01-01T05:30:00+05:30',
        field: 'updated_at',
        new_value: '2026-01-01T00:00:00.000Z',
        path: 'MMR/MMR-1.md',
      },
      kind: 'set_frontmatter',
    },
  ]);
});

test('normalize-timestamp fails closed when the snapshot no longer carries the field', () => {
  const planned = planDoctorRepairs({
    issues: [
      issue(
        'non-canonical-timestamp',
        'MMR-1',
        {
          canonical: '2026-01-01T00:00:00.000Z',
          field: 'archived_at',
          value: '2026-01-01T00:00:00Z',
        },
        'MMR/MMR-1.md',
      ),
    ],
    scope: 'MMR',
    snapshot: snapshot([
      {
        body: 'b',
        documentHash: 'hash',
        frontmatter: { type: 'task' },
        path: 'MMR/MMR-1.md',
        stem: 'MMR-1',
      },
    ]),
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  expect(planned.migration.operations).toEqual([]);
  expect(planned.failures).toEqual([
    {
      issue: expect.objectContaining({ code: 'non-canonical-timestamp' }),
      reason: 'missing-snapshot-value',
    },
  ]);
});

test('an uninterpretable timestamp is skipped as requiring explicit correction', () => {
  const planned = planDoctorRepairs({
    issues: [
      issue('uninterpretable-timestamp', 'MMR-1', {
        field: 'created',
        value: '2026-01-01T00:00:00',
      }),
      issue('uninterpretable-record-timestamp', 'MMR-1', {
        line: 2,
        section: 'History',
        value: 'tuesday',
      }),
    ],
    scope: 'MMR',
    snapshot: snapshot([
      {
        body: 'body',
        documentHash: 'hash',
        frontmatter: { created: '2026-01-01T00:00:00', type: 'task' },
        path: 'MMR/MMR-1.md',
        stem: 'MMR-1',
      },
    ]),
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  expect(planned.migration.operations).toEqual([]);
  expect(planned.skipped.map((item) => item.reason)).toEqual([
    'requires-explicit-correction',
    'requires-explicit-correction',
  ]);
});

test('normalize-record-timestamp rewrites only the addressed heading, under the body CAS', () => {
  const body =
    '## History\n### 2026-01-01T05:30:00+05:30 — lifecycle\nactive → done\n' +
    '## Annotations\n### 2026-01-01T00:00:00Z\na note\n';
  const planned = planDoctorRepairs({
    issues: [
      issue(
        'non-canonical-record-timestamp',
        'MMR-1',
        {
          canonical: '2026-01-01T00:00:00.000Z',
          line: 2,
          section: 'History',
          value: '2026-01-01T05:30:00+05:30',
        },
        'MMR/MMR-1.md:2',
      ),
      issue(
        'non-canonical-record-timestamp',
        'MMR-1',
        {
          canonical: '2026-01-01T00:00:00.000Z',
          line: 5,
          section: 'Annotations',
          value: '2026-01-01T00:00:00Z',
        },
        'MMR/MMR-1.md:5',
      ),
    ],
    scope: 'MMR',
    snapshot: snapshot([
      {
        body,
        documentHash: 'body-hash',
        frontmatter: { type: 'task' },
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
        document_hash: 'body-hash',
        new_value:
          '## History\n### 2026-01-01T00:00:00.000Z — lifecycle\nactive → done\n' +
          '## Annotations\n### 2026-01-01T00:00:00.000Z\na note\n',
        path: 'MMR/MMR-1.md',
      },
      kind: 'replace_body',
    },
  ]);
});

test('normalize-record-timestamp skips a line that is not the heading the finding names', () => {
  const planned = planDoctorRepairs({
    issues: [
      issue(
        'non-canonical-record-timestamp',
        'MMR-1',
        {
          canonical: '2026-01-01T00:00:00.000Z',
          line: 3,
          section: 'History',
          value: '2026-01-01T00:00:00Z',
        },
        'MMR/MMR-1.md:3',
      ),
    ],
    scope: 'MMR',
    snapshot: snapshot([
      {
        body: '## History\n### 2026-01-01T00:00:00Z — lifecycle\nactive → done\n',
        documentHash: 'body-hash',
        frontmatter: { type: 'task' },
        path: 'MMR/MMR-1.md',
        stem: 'MMR-1',
      },
    ]),
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  expect(planned.migration.operations).toEqual([]);
  expect(planned.skipped).toEqual([
    {
      issue: expect.objectContaining({ code: 'non-canonical-record-timestamp' }),
      reason: 'ambiguous-body-record',
    },
  ]);
});

test('a CRLF body keeps its line endings when a record timestamp is normalized', () => {
  const planned = planDoctorRepairs({
    issues: [
      issue(
        'non-canonical-record-timestamp',
        'MMR-1',
        {
          canonical: '2026-01-01T00:00:00.000Z',
          line: 2,
          section: 'History',
          value: '2026-01-01T00:00:00Z',
        },
        'MMR/MMR-1.md:2',
      ),
    ],
    scope: 'MMR',
    snapshot: snapshot([
      {
        body: '## History\r\n### 2026-01-01T00:00:00Z — lifecycle\r\nactive → done\r\n',
        documentHash: 'body-hash',
        frontmatter: { type: 'task' },
        path: 'MMR/MMR-1.md',
        stem: 'MMR-1',
      },
    ]),
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  expect(planned.migration.operations[0]).toMatchObject({
    fields: {
      new_value: '## History\r\n### 2026-01-01T00:00:00.000Z — lifecycle\r\nactive → done\r\n',
    },
  });
});

// MMR-351: a Scratchpad is PATH-addressed — its UUID stem is deliberately
// outside the durable KEY grammar, so it never enters the identity index. An
// unindexed pad plans a `missing-snapshot-document` FAILURE, and a planning
// failure is FATAL to the whole run (commands.ts discards every planned op and
// exits nonzero) — so one hand-edited pad could take out every unrelated repair.

const PAD = 'scratch/018f3f36-7b2b-4c92-8f31-44c764a1a456.md';
const PAD_STEM = '018f3f36-7b2b-4c92-8f31-44c764a1a456';

function padIssue(): DoctorFinding {
  return {
    ...issue(
      'non-canonical-timestamp',
      PAD_STEM,
      { canonical: '2026-01-01T00:00:00.000Z', field: 'updated_at', value: '2026-01-01T00:00:00Z' },
      PAD,
    ),
    scopeKey: 'MMR',
  };
}

function padDocument(): DoctorSnapshotDocument {
  return {
    body: '## Journal\n\n## Agenda\n',
    documentHash: 'pad-hash',
    frontmatter: {
      created: '2026-01-01T00:00:00.000Z',
      project: '[[MMR]]',
      type: 'scratch',
      updated_at: '2026-01-01T00:00:00Z',
    },
    path: PAD,
    stem: PAD_STEM,
  };
}

test('a Scratchpad timestamp is planned, not lost as a missing-snapshot-document', () => {
  const planned = planDoctorRepairs({
    issues: [padIssue()],
    scope: 'MMR',
    snapshot: snapshot([], [padDocument()]),
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  // Neither a planning failure (fatal to the run) nor an `ambiguous-identity`
  // skip (what indexing pads WITHOUT path-addressed ownership would produce).
  expect(planned.failures).toEqual([]);
  expect(planned.skipped).toEqual([]);
  expect(planned.migration.operations).toEqual([
    {
      fields: {
        expected_old_value: '2026-01-01T00:00:00Z',
        field: 'updated_at',
        new_value: '2026-01-01T00:00:00.000Z',
        path: PAD,
      },
      kind: 'set_frontmatter',
    },
  ]);
});

test('a corrupt Scratchpad cannot strand the unrelated repairs in the same run', () => {
  const planned = planDoctorRepairs({
    issues: [padIssue(), issue('crlf-body', 'MMR-1', { count: 1 })],
    scope: 'MMR',
    snapshot: snapshot(
      [
        {
          body: 'text\r\n',
          documentHash: 'node-hash',
          frontmatter: { type: 'task' },
          path: 'MMR/MMR-1.md',
          stem: 'MMR-1',
        },
      ],
      [padDocument()],
    ),
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  expect(planned.failures).toEqual([]);
  expect(planned.planned.map((item) => String(item.recipe)).toSorted()).toEqual([
    'normalize-crlf',
    'normalize-timestamp',
  ]);
  expect(planned.migration.operations).toHaveLength(2);
});

test('a Scratchpad body repair rides its REAL document hash, never a fabricated one', () => {
  // Pads carry their own body and hash in the snapshot (unlike artifacts, whose
  // slice fabricates `documentHash: null`), so a body-affecting recipe reaching
  // one is a genuine CAS write rather than a `missing-cas-hash` failure.
  const planned = planDoctorRepairs({
    issues: [{ ...issue('crlf-body', PAD_STEM, { count: 1 }, PAD), scopeKey: 'MMR' }],
    scope: 'MMR',
    snapshot: snapshot([], [{ ...padDocument(), body: '## Journal\r\n' }]),
    timestamp: '2026-07-13T12:00:00.000Z',
    vaultRoot: '/vault',
  });
  expect(planned.failures).toEqual([]);
  expect(planned.migration.operations).toEqual([
    {
      fields: { document_hash: 'pad-hash', new_value: '## Journal\n', path: PAD },
      kind: 'replace_body',
    },
  ]);
});

test('timestamp findings key by field and line so one document cannot mask another', () => {
  const created = issue('non-canonical-timestamp', 'MMR-1', { field: 'created' }, 'MMR/MMR-1.md');
  const updated = issue(
    'non-canonical-timestamp',
    'MMR-1',
    { field: 'updated_at' },
    'MMR/MMR-1.md',
  );
  expect(repairIssueKey(created)).not.toBe(repairIssueKey(updated));
  const first = issue('non-canonical-record-timestamp', 'MMR-1', { line: 2 }, 'MMR/MMR-1.md:2');
  const second = issue('non-canonical-record-timestamp', 'MMR-1', { line: 9 }, 'MMR/MMR-1.md:9');
  expect(repairIssueKey(first)).not.toBe(repairIssueKey(second));
});

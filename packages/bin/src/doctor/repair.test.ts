import { expect, test } from 'bun:test';

import type { DoctorFinding, DoctorIssueCode } from './checks';
import { planDoctorRepairs, REPAIR_POLICY } from './repair';
import type { DoctorSnapshot, DoctorSnapshotDocument } from './snapshot';

function issue(
  code: DoctorIssueCode,
  stem: string,
  evidence: Record<string, unknown> = {},
): DoctorFinding {
  const scopeKey = stem.split('-')[0] ?? stem;
  return {
    check: 'test',
    code,
    evidence,
    locator: 'test',
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
    'duplicate-stem',
    'frontmatter-disallowed-value',
    'frontmatter-parse-failed',
    'frontmatter-required-field-missing',
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
        new_value: '## Task Description\ntext\n## Annotations\n## History\n',
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
  expect(planned.skipped.map((item) => item.reason)).toEqual(['ambiguous-section-heading']);

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

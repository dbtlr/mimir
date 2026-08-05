import { expect, test } from 'bun:test';

import type {
  ArtifactDetail,
  ArtifactSummary,
  NodeView,
  OverviewReport,
  SeedView,
  TriageReport,
} from '@mimir/contract';

import {
  artifactRows,
  renderArtifactDetail,
  renderOverview,
  renderRecords,
  renderSeedRecords,
  renderTable,
  renderTriageReport,
  seedRows,
} from './render';
import { fakeIo } from './testing';

function task(over: Partial<NodeView> = {}): NodeView {
  return {
    createdAt: '2026-01-01T00:00:00.000Z',
    description: null,
    id: 'MMR-5',
    parent: 'MMR-2',
    priority: 'p1',
    status: 'ready',
    title: 'child',
    type: 'task',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

test('table set view shows the parent id as a row column (MMR-87)', () => {
  const text = renderTable({ items: [task()], returned: 1, startsAt: 0, total: 1 }, fakeIo(false));
  expect(text).toContain('MMR-5'); // the node id
  expect(text).toContain('MMR-2'); // its parent, the hierarchy anchor
  expect(text).toContain('child'); // the title
});

test('a top-level node (no parent) renders an empty parent cell, not a crash (MMR-87)', () => {
  const text = renderTable(
    { items: [task({ id: 'MMR-1', parent: null })], returned: 1, startsAt: 0, total: 1 },
    fakeIo(false),
  );
  expect(text).toContain('MMR-1');
  expect(text).toContain('child');
});

// MMR-95: empty set views print a clear no-results line on a TTY
test('renderTable: empty set on a TTY prints a no-results line (MMR-95)', () => {
  const text = renderTable(
    { items: [], returned: 0, startsAt: 0, total: 0 },
    fakeIo(true),
    'No tasks match.',
  );
  expect(text).toContain('No tasks match.');
  // Must not be just the count line
  expect(text).not.toBe('0 tasks');
});

// MMR-288: the upstream-resolution head line reads left to right — the settled
// upstream resolves INTO the task, old → new, never the reversed `<-` form.
test('renderTriageReport: upstream-resolution arrow reads upstream → task (MMR-288)', () => {
  const report: TriageReport = {
    board: 'MMR',
    dryRun: false,
    failures: [],
    readyToResolve: [],
    untriaged: [],
    upstreamResolutions: [
      {
        alreadyRecorded: false,
        annotated: true,
        blocked: false,
        lifecycle: 'resolved',
        reason: null,
        task: 'MMR-3',
        upstream: 'MMR-s1',
      },
    ],
  };
  const text = renderTriageReport(report, fakeIo(false));
  expect(text).toContain('MMR-s1 -> MMR-3'); // plain io: ascii glyph, upstream first
  expect(text).not.toContain('<-');
});

// ─── Local-time rendering (MMR-350, ADR 0029) ───────────────────────────────
//
// The fixture Io is pinned to America/New_York, so every assertion below is the
// same string on any machine. The rule under test is one line: no human surface
// prints a raw UTC ISO instant.

/** No `…Z` instant anywhere in the rendered text. */
const RAW_ISO = /\d{4}-\d{2}-\d{2}T[\d:.]+Z/;

function seed(over: Partial<SeedView> = {}): SeedView {
  return {
    createdAt: '2026-08-05T13:14:00.000Z',
    id: 'MMR-s1',
    kind: 'idea',
    lifecycle: 'new',
    project: 'MMR',
    readyToResolve: false,
    requester: null,
    spawned: [],
    title: 'a seed',
    updatedAt: '2026-08-05T13:14:00.000Z',
    ...over,
  };
}

function artifact(over: Partial<ArtifactDetail> = {}): ArtifactDetail {
  return {
    createdAt: '2026-08-05T13:14:00.000Z',
    id: 'MMR-a1',
    links: [],
    project: 'MMR',
    tags: [],
    title: 'an artifact',
    ...over,
  };
}

test('records: a completed instant reads local with its zone, never raw UTC (MMR-350)', () => {
  const text = renderRecords(
    task({ completedAt: '2026-08-05T13:14:00.000Z', status: 'done' }),
    fakeIo(false),
  );
  expect(text).toContain('2026-08-05 09:14 EDT');
  expect(text).not.toMatch(RAW_ISO);
});

test('records: the same instant reads EST on the winter side of the boundary (MMR-350)', () => {
  const text = renderRecords(
    task({ completedAt: '2026-01-15T13:14:00.000Z', status: 'done' }),
    fakeIo(false),
  );
  expect(text).toContain('2026-01-15 08:14 EST');
});

test('artifact records: created reads local with its zone (MMR-350)', () => {
  const io = fakeIo(false);
  renderArtifactDetail(artifact(), 'records', io);
  expect(io.out.join('\n')).toContain('created  2026-08-05 09:14 EDT');
  expect(io.out.join('\n')).not.toMatch(RAW_ISO);
});

test('artifact table: the dense one-liner carries the local day only (MMR-350)', () => {
  const io = fakeIo(false);
  // 02:00Z is still the previous day where the reader sits.
  renderArtifactDetail(artifact({ createdAt: '2026-08-05T02:00:00.000Z' }), 'table', io);
  expect(io.out.join('\n')).toContain('2026-08-04');
  expect(io.out.join('\n')).not.toMatch(RAW_ISO);
});

test('artifact json stays the canonical UTC wire, untouched (MMR-350)', () => {
  const io = fakeIo(false);
  renderArtifactDetail(artifact(), 'json', io);
  expect(io.out.join('\n')).toContain('2026-08-05T13:14:00.000Z');
});

test('seed records: created reads local with its zone (MMR-350)', () => {
  const text = renderSeedRecords(seed(), fakeIo(false));
  expect(text).toContain('created    2026-08-05 09:14 EDT');
  expect(text).not.toMatch(RAW_ISO);
});

test('seed rows: the age column is relative, and the column aligns to it (MMR-350)', () => {
  const now = Date.now();
  const rows = seedRows(
    [
      seed({ createdAt: new Date(now - 3 * 3_600_000).toISOString(), id: 'MMR-s1' }),
      seed({ createdAt: new Date(now - 56 * 86_400_000).toISOString(), id: 'MMR-s2' }),
    ],
    fakeIo(false),
  );
  expect(rows[0]).toContain('3h');
  expect(rows[1]).toContain('8w');
  expect(rows.join('\n')).not.toMatch(RAW_ISO);
  // Both rows pad to the widest rendered age, so the id column still lines up.
  expect(rows[0]?.indexOf('MMR-s1')).toBe(rows[1]?.indexOf('MMR-s2') ?? -1);
});

test('artifact rows: the trailing date is relative, never a raw instant (MMR-350)', () => {
  const summary: ArtifactSummary = {
    createdAt: new Date(Date.now() - 6 * 86_400_000).toISOString(),
    id: 'MMR-a1',
    project: 'MMR',
    tags: [],
    title: 'an artifact',
  };
  const rows = artifactRows([summary], fakeIo(false), { showProject: true });
  expect(rows[0]).toEndWith('6d');
  expect(rows.join('\n')).not.toMatch(RAW_ISO);
});

function overview(over: Partial<OverviewReport> = {}): OverviewReport {
  return {
    awaiting: { count: 0, tasks: [] },
    direction: { containers: [], count: 0, project: null },
    hygiene: {
      blocked: 0,
      dropped: 0,
      listings: { blocked: [], stale: [], untriaged: [] },
      stale: 0,
      untriaged: 0,
    },
    inFlight: { count: 0, tasks: [] },
    next: { count: 0, tasks: [] },
    project: { distribution: {}, id: 'MMR', status: 'in_progress' },
    scratchpads: { count: 0, scratchpads: [] },
    sessions: { entries: [], shown: 0 },
    ...over,
  };
}

test('overview: a same-day session window states its zone once (MMR-350)', () => {
  const text = renderOverview(
    overview({
      sessions: {
        entries: [
          {
            from: '2026-08-05T13:14:00.000Z',
            id: 'sess-1',
            tasks: [],
            to: '2026-08-05T13:43:00.000Z',
            transitions: 2,
          },
        ],
        shown: 1,
      },
    }),
    fakeIo(false),
  );
  expect(text).toContain('2026-08-05 09:14 -> 09:43 EDT');
  expect(text).not.toMatch(RAW_ISO);
});

test('overview: a window spanning local midnight keeps both dates (MMR-350)', () => {
  const text = renderOverview(
    overview({
      sessions: {
        entries: [
          {
            from: '2026-08-06T03:50:00.000Z',
            id: 'sess-1',
            tasks: [],
            to: '2026-08-06T04:10:00.000Z',
            transitions: 1,
          },
        ],
        shown: 1,
      },
    }),
    fakeIo(false),
  );
  expect(text).toContain('2026-08-05 23:50 -> 2026-08-06 00:10 EDT');
});

test('overview: an active scratchpad row shows a relative age (MMR-350)', () => {
  const text = renderOverview(
    overview({
      scratchpads: {
        count: 1,
        scratchpads: [
          {
            id: 'a1b2',
            linkedWork: [],
            openAgenda: 1,
            project: 'MMR',
            state: 'active',
            title: 'a pad',
            updatedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
          },
        ],
      },
    }),
    fakeIo(false),
  );
  expect(text).toContain('1 open Agenda · 4m');
  expect(text).not.toMatch(RAW_ISO);
});

test('renderTable: empty set on a non-TTY keeps the bare count line only (MMR-95)', () => {
  const text = renderTable(
    { items: [], returned: 0, startsAt: 0, total: 0 },
    fakeIo(false),
    'No tasks match.',
  );
  // No-results line must NOT appear in piped/non-TTY output
  expect(text).not.toContain('No tasks match.');
  // Count line is still present (it's informational, not a message leak)
  expect(text).toContain('0 tasks');
});

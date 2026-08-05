import { afterAll, beforeAll, expect, test } from 'bun:test';

import type { DateOp } from '@mimir/contract';
import type { Server } from 'bun';

import { runCli } from './cli/run';
import { fakeIo } from './cli/testing';
import {
  attachArtifact,
  createInitiative,
  createPhase,
  createProject,
  createTask,
  dateFilterWindow,
  deriveSet,
  fileSeed,
  findNodeInSet,
  getArtifact,
  listSeeds,
  withinWindow,
} from './core';
import type { Store } from './core';
import { createServer } from './http/server';
import { toolArtifacts, toolList, toolSeeds } from './mcp/tools';
import { createTestStore, nodeIdOf, projectIdOf } from './testing/store';

/**
 * The date-query conformance suite (ADR 0029) — the registry-driven proof that
 * CLI, MCP, and HTTP resolve one date grammar to ONE instant window, over every
 * resource that has a date field.
 *
 * Each case names an operator, a filter value, and a caller timezone. The
 * EXPECTED answer is computed from the shared date core against each fixture's
 * own `created_at`, so the assertion is not merely "the three agree" — it is
 * "the three agree with the resolved boundary", which is what a transport doing
 * its own arithmetic would break. The cases cover DST spring-forward and
 * fall-back days, a 45-minute zone, a leap day, the exact millisecond of a
 * fixture's own timestamp (the inclusive/strict edge), and the refusals: an
 * impossible calendar date, a zone-less timestamp, and a bare date with no
 * caller timezone (which only MCP and HTTP can hit — the CLI always has the
 * system zone).
 */

const NORN = Bun.which('norn') !== null;

/** The three date fields the grammar reaches; `created_at` is the shared one. */
const FIELD = 'created_at';

let store: Store;
let closeStore: (() => Promise<void>) | undefined;
let server: Server<undefined>;
let base: string;

/** The fixture rows, each with the `created_at` the expectations are computed against. */
let task: { id: string; createdAt: string };
let artifact: { id: string; createdAt: string };
let seed: { id: string; createdAt: string };

beforeAll(async () => {
  if (!NORN) {
    return;
  }
  ({ close: closeStore, store } = await createTestStore());
  await createProject(store, { key: 'MMR', name: 'Mimir' });
  const projectId = await projectIdOf(store, 'MMR');
  const initiative = await createInitiative(store, { projectId, title: 'initiative' });
  const phase = await createPhase(store, {
    parentId: await nodeIdOf(store, `MMR-${String(initiative.seq)}`),
    title: 'phase',
  });
  const created = await createTask(store, {
    parentId: await nodeIdOf(store, `MMR-${String(phase.seq)}`),
    title: 'the dated task',
  });
  const taskRef = `MMR-${String(created.seq)}`;
  const node = findNodeInSet(deriveSet(await store.loadWorkingSet()), taskRef);
  task = { createdAt: node?.created_at ?? '', id: taskRef };

  const attached = await attachArtifact(store, {
    content: '# a frozen note',
    projectId,
    tags: [],
    title: 'the dated artifact',
  });
  artifact = {
    createdAt: (await getArtifact(store, attached.renderedId)).createdAt,
    id: attached.renderedId,
  };

  const filed = await fileSeed(store, {
    kind: 'idea',
    project: 'MMR',
    requester: null,
    title: 'the dated seed',
  });
  const queued = (await listSeeds(store, { project: 'MMR' })).find((s) => s.id === filed.id);
  seed = { createdAt: queued?.createdAt ?? '', id: filed.id };

  server = createServer(store, { hunt: false, port: 0, version: '0.0.0-test' });
  base = `http://127.0.0.1:${String(server.port)}`;
});

afterAll(async () => {
  await server?.stop(true);
  await closeStore?.();
});

/** What a transport answered: whether the fixture row matched, or why it refused. */
type Outcome = { matched: boolean } | { refused: string };

/** The camelCase MCP arg key for an operator. */
const MCP_ARG: Record<DateOp, 'on' | 'before' | 'after' | 'atOrBefore' | 'atOrAfter'> = {
  after: 'after',
  'at-or-after': 'atOrAfter',
  'at-or-before': 'atOrBefore',
  before: 'before',
  on: 'on',
};

/** A tool result → the ids it carries, or the refusal message. */
function toolOutcome(
  result: { isError?: boolean; content: { text?: string }[] },
  id: string,
): Outcome {
  const text = result.content[0]?.text ?? '';
  if (result.isError === true) {
    return { refused: text };
  }
  return { matched: text.includes(`"${id}"`) };
}

async function httpOutcome(url: string, id: string): Promise<Outcome> {
  const res = await fetch(url);
  const text = await res.text();
  return res.ok ? { matched: text.includes(`"${id}"`) } : { refused: text };
}

async function cliOutcome(argv: string[], id: string): Promise<Outcome> {
  const io = fakeIo(false);
  const code = await runCli(argv, () => store, io);
  return code === 0
    ? { matched: io.out.join('').includes(`"${id}"`) }
    : { refused: io.err.join('') };
}

/** One or more date filters, as the caller writes them. */
type Filters = readonly (readonly [DateOp, string])[];

/** One resource's three transport bindings — the same query, spoken three ways. */
type Resource = {
  name: string;
  row: () => { id: string; createdAt: string };
  cli: (filters: Filters, zone?: string) => Promise<Outcome>;
  mcp: (filters: Filters, zone?: string) => Promise<Outcome>;
  http: (filters: Filters, zone?: string) => Promise<Outcome>;
};

/** The CLI flag pairs for a filter list. */
const cliFlags = (filters: Filters): string[] =>
  filters.flatMap(([op, value]) => [`--${op}`, `${FIELD}:${value}`]);

/** The repeated query params for a filter list. */
const httpParams = (filters: Filters): string =>
  filters.map(([op, value]) => `&${op}=${encodeURIComponent(`${FIELD}:${value}`)}`).join('');

/** The camelCase token arrays for a filter list. */
function mcpArgs(filters: Filters): Record<string, string[]> {
  const args: Record<string, string[]> = {};
  for (const [op, value] of filters) {
    (args[MCP_ARG[op]] ??= []).push(`${FIELD}:${value}`);
  }
  return args;
}

/** The CLI's zone flag pair, omitted when the case sends no zone (system default). */
const tzFlag = (zone?: string): string[] => (zone === undefined ? [] : ['--tz', zone]);
const tzArg = (zone?: string): { tz?: string } => (zone === undefined ? {} : { tz: zone });
const tzParam = (zone?: string): string => (zone === undefined ? '' : `&tz=${zone}`);

const RESOURCES: readonly Resource[] = [
  {
    cli: (filters, zone) =>
      cliOutcome(
        ['list', '-s', 'MMR', ...cliFlags(filters), ...tzFlag(zone), '-f', 'json'],
        task.id,
      ),
    http: (filters, zone) =>
      httpOutcome(`${base}/api/nodes?project=MMR${httpParams(filters)}${tzParam(zone)}`, task.id),
    mcp: async (filters, zone) =>
      toolOutcome(
        await toolList(store, { scope: 'MMR', ...mcpArgs(filters), ...tzArg(zone) }),
        task.id,
      ),
    name: 'nodes',
    row: () => task,
  },
  {
    cli: (filters, zone) =>
      cliOutcome(
        ['artifacts', '-s', 'MMR', ...cliFlags(filters), ...tzFlag(zone), '-f', 'json'],
        artifact.id,
      ),
    http: (filters, zone) =>
      httpOutcome(
        `${base}/api/artifacts?project=MMR${httpParams(filters)}${tzParam(zone)}`,
        artifact.id,
      ),
    mcp: async (filters, zone) =>
      toolOutcome(
        await toolArtifacts(store, { scope: 'MMR', ...mcpArgs(filters), ...tzArg(zone) }),
        artifact.id,
      ),
    name: 'artifacts',
    row: () => artifact,
  },
  {
    cli: (filters, zone) =>
      cliOutcome(
        ['seeds', '-p', 'MMR', ...cliFlags(filters), ...tzFlag(zone), '-f', 'json'],
        seed.id,
      ),
    http: (filters, zone) =>
      httpOutcome(`${base}/api/seeds?project=MMR${httpParams(filters)}${tzParam(zone)}`, seed.id),
    mcp: async (filters, zone) =>
      toolOutcome(
        await toolSeeds(store, { project: 'MMR', ...mcpArgs(filters), ...tzArg(zone) }),
        seed.id,
      ),
    name: 'seeds',
    row: () => seed,
  },
];

/** A case whose answer is the resolved window's own verdict on the fixture row. */
type MatchCase = {
  name: string;
  op: DateOp;
  zone: string;
  /** The filter value, derived from the fixture's `created_at` where the edge matters. */
  value: (createdAt: string) => string;
};

/** The fixture's local calendar date in `zone` — the day the caller would name. */
const localDate = (instant: string, zone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(instant));

/** The fixture's own instant, shifted by minutes and rendered with an offset. */
const offsetInstant = (instant: string, minutes: number): string => {
  const shifted = new Date(Date.parse(instant) + minutes * 60_000);
  return new Date(shifted.getTime() + 2 * 60 * 60 * 1000).toISOString().replace('Z', '+02:00');
};

const MATCH_CASES: readonly MatchCase[] = [
  // The caller's own calendar day, in zones 25 hours apart: the same instant is
  // a different date in each, so a transport reading UTC days answers wrong.
  {
    name: 'on the caller-local day (+14)',
    op: 'on',
    value: (createdAt) => localDate(createdAt, 'Pacific/Kiritimati'),
    zone: 'Pacific/Kiritimati',
  },
  {
    name: 'on the +14 day, read in a -11 zone',
    op: 'on',
    value: (createdAt) => localDate(createdAt, 'Pacific/Kiritimati'),
    zone: 'Pacific/Niue',
  },
  {
    name: 'on the caller-local day (-11)',
    op: 'on',
    value: (createdAt) => localDate(createdAt, 'Pacific/Niue'),
    zone: 'Pacific/Niue',
  },
  // A 45-minute zone — the boundary is not on an hour.
  {
    name: 'at-or-after the caller-local day (+05:45)',
    op: 'at-or-after',
    value: (createdAt) => localDate(createdAt, 'Asia/Kathmandu'),
    zone: 'Asia/Kathmandu',
  },
  {
    name: 'before the caller-local day (+05:45)',
    op: 'before',
    value: (createdAt) => localDate(createdAt, 'Asia/Kathmandu'),
    zone: 'Asia/Kathmandu',
  },
  {
    name: 'after the caller-local day (+10:30)',
    op: 'after',
    value: (createdAt) => localDate(createdAt, 'Australia/Lord_Howe'),
    zone: 'Australia/Lord_Howe',
  },
  {
    name: 'at-or-before the caller-local day (+10:30)',
    op: 'at-or-before',
    value: (createdAt) => localDate(createdAt, 'Australia/Lord_Howe'),
    zone: 'Australia/Lord_Howe',
  },
  // The DST days: a 23-hour day and a 25-hour one, whose windows open and close
  // at offsets the naive UTC-midnight arithmetic never produces.
  {
    name: 'at-or-after the spring-forward day (23 hours)',
    op: 'at-or-after',
    value: () => '2026-03-08',
    zone: 'America/New_York',
  },
  {
    name: 'before the spring-forward day',
    op: 'before',
    value: () => '2026-03-08',
    zone: 'America/New_York',
  },
  {
    name: 'at-or-before the fall-back day (25 hours)',
    op: 'at-or-before',
    value: () => '2026-11-01',
    zone: 'America/New_York',
  },
  {
    name: 'on the fall-back day',
    op: 'on',
    value: () => '2026-11-01',
    zone: 'America/New_York',
  },
  // A leap day is a real calendar day everywhere.
  { name: 'before the leap day', op: 'before', value: () => '2028-02-29', zone: 'UTC' },
  { name: 'after the leap day', op: 'after', value: () => '2024-02-29', zone: 'UTC' },
  // The exact millisecond of the row's own creation — the inclusive/strict edge.
  {
    name: 'at-or-after the row instant (inclusive)',
    op: 'at-or-after',
    value: (createdAt) => createdAt,
    zone: 'UTC',
  },
  {
    name: 'after the row instant (strict)',
    op: 'after',
    value: (createdAt) => createdAt,
    zone: 'UTC',
  },
  {
    name: 'at-or-before the row instant (inclusive)',
    op: 'at-or-before',
    value: (createdAt) => createdAt,
    zone: 'UTC',
  },
  {
    name: 'before the row instant (strict)',
    op: 'before',
    value: (createdAt) => createdAt,
    zone: 'UTC',
  },
  // An offset timestamp is the same instant written differently.
  {
    name: 'at-or-after the row instant, written +02:00',
    op: 'at-or-after',
    value: (createdAt) => offsetInstant(createdAt, -30),
    zone: 'UTC',
  },
  {
    name: 'before the row instant, written +02:00',
    op: 'before',
    value: (createdAt) => offsetInstant(createdAt, -30),
    zone: 'UTC',
  },
];

for (const resource of RESOURCES) {
  for (const matchCase of MATCH_CASES) {
    test.skipIf(!NORN)(`${resource.name}: ${matchCase.name}`, async () => {
      const row = resource.row();
      const value = matchCase.value(row.createdAt);
      const matched = withinWindow(
        dateFilterWindow(matchCase.op, value, matchCase.zone),
        row.createdAt,
      );
      const filters = [[matchCase.op, value]] as const;
      expect(await resource.cli(filters, matchCase.zone)).toEqual({ matched });
      expect(await resource.mcp(filters, matchCase.zone)).toEqual({ matched });
      expect(await resource.http(filters, matchCase.zone)).toEqual({ matched });
    });
  }
}

/** A value every transport must refuse, and the phrase the refusal must carry. */
const REFUSAL_CASES: readonly { name: string; op: DateOp; value: string; says: string }[] = [
  { name: 'an impossible calendar date', op: 'on', says: 'invalid date', value: '2026-02-30' },
  { name: 'a non-leap February 29', op: 'before', says: 'invalid date', value: '2027-02-29' },
  { name: 'an out-of-range month', op: 'before', says: 'invalid date', value: '2026-13-01' },
  {
    name: 'a zone-less timestamp',
    op: 'before',
    says: 'invalid date',
    value: '2026-07-31T10:15:00',
  },
  { name: 'a word', op: 'after', says: 'invalid date', value: 'yesterday' },
];

for (const resource of RESOURCES) {
  for (const refusal of REFUSAL_CASES) {
    test.skipIf(!NORN)(`${resource.name} refuses ${refusal.name}`, async () => {
      const filters = [[refusal.op, refusal.value]] as const;
      for (const outcome of [
        await resource.cli(filters, 'UTC'),
        await resource.mcp(filters, 'UTC'),
        await resource.http(filters, 'UTC'),
      ]) {
        expect(outcome).toMatchObject({ refused: expect.stringContaining(refusal.says) });
      }
    });
  }

  // Only the remote transports can be zone-less: the CLI defaults to the
  // invoking system's zone, so a bare date there always has a calendar.
  test.skipIf(!NORN)(`${resource.name} refuses a bare date with no tz off-CLI`, async () => {
    const filters = [['on', localDate(resource.row().createdAt, 'UTC')]] as const;
    expect(await resource.mcp(filters)).toMatchObject({
      refused: expect.stringContaining('no caller timezone'),
    });
    expect(await resource.http(filters)).toMatchObject({
      refused: expect.stringContaining('no caller timezone'),
    });
    expect(await resource.cli(filters)).toEqual({ matched: expect.any(Boolean) });
  });

  test.skipIf(!NORN)(`${resource.name} refuses an unknown timezone`, async () => {
    const filters = [['on', '2026-07-31']] as const;
    for (const outcome of [
      await resource.cli(filters, 'Mars/Olympus'),
      await resource.mcp(filters, 'Mars/Olympus'),
      await resource.http(filters, 'Mars/Olympus'),
    ]) {
      expect(outcome).toMatchObject({ refused: expect.stringContaining('unknown timezone') });
    }
  });

  // `on` names a calendar day; an instant is not one, on any transport.
  test.skipIf(!NORN)(`${resource.name} refuses on with a timestamp`, async () => {
    const filters = [['on', '2026-07-31T10:15:00Z']] as const;
    for (const outcome of [
      await resource.cli(filters, 'UTC'),
      await resource.mcp(filters, 'UTC'),
      await resource.http(filters, 'UTC'),
    ]) {
      expect(outcome).toMatchObject({ refused: expect.stringContaining('not a calendar date') });
    }
  });
}

/**
 * Windows whose edges are pinned to instants computed OUTSIDE this codebase — a
 * minute-by-minute scan over Intl's `longOffset` readings, run across all 445
 * zones and every offset transition from 1970 to 2038. Pinning them here keeps
 * the transports honest against the CALENDAR, not merely against each other:
 * the match cases above take their expectation from the date core, which can
 * only prove the three agree.
 */
const ANCHORS: readonly { zone: string; day: string; from: string; until: string }[] = [
  // A fall-back landing at 00:00 — the day opens at the FIRST of two midnights.
  {
    day: '2021-10-29',
    from: '2021-10-28T21:00:00.000Z',
    until: '2021-10-29T22:00:00.000Z',
    zone: 'Asia/Amman',
  },
  // Spring forward — a 23-hour day.
  {
    day: '2026-03-08',
    from: '2026-03-08T05:00:00.000Z',
    until: '2026-03-09T04:00:00.000Z',
    zone: 'America/New_York',
  },
  // A zone whose offset is not a whole hour.
  {
    day: '2026-06-10',
    from: '2026-06-09T18:15:00.000Z',
    until: '2026-06-10T18:15:00.000Z',
    zone: 'Asia/Kathmandu',
  },
];

for (const resource of RESOURCES) {
  for (const anchor of ANCHORS) {
    test.skipIf(!NORN)(
      `${resource.name}: ${anchor.zone} ${anchor.day} lands on its true edges`,
      async () => {
        const created = Date.parse(resource.row().createdAt);
        const [from, until] = [Date.parse(anchor.from), Date.parse(anchor.until)];
        // The expectations come from the anchored instants alone — no module call.
        const expected: Record<DateOp, boolean> = {
          after: created >= until,
          'at-or-after': created >= from,
          'at-or-before': created < until,
          before: created < from,
          on: created >= from && created < until,
        };
        for (const op of Object.keys(expected)) {
          const filters = [[op, anchor.day]] as Filters;
          const matched = expected[op as DateOp];
          expect(await resource.cli(filters, anchor.zone)).toEqual({ matched });
          expect(await resource.mcp(filters, anchor.zone)).toEqual({ matched });
          expect(await resource.http(filters, anchor.zone)).toEqual({ matched });
        }
      },
    );
  }

  // Two ops compose to the intersection of their windows — on every transport.
  test.skipIf(!NORN)(`${resource.name}: composed bounds intersect`, async () => {
    const created = resource.row().createdAt;
    const hour = 60 * 60 * 1000;
    const before = new Date(Date.parse(created) + hour).toISOString();
    const after = new Date(Date.parse(created) - hour).toISOString();
    const straddles = [
      ['after', after],
      ['before', before],
    ] as Filters;
    // A window that excludes the row on its LOWER edge, the upper still open.
    const misses = [
      ['after', before],
      ['before', new Date(Date.parse(created) + 2 * hour).toISOString()],
    ] as Filters;
    for (const [filters, matched] of [
      [straddles, true],
      [misses, false],
    ] as const) {
      expect(await resource.cli(filters, 'UTC')).toEqual({ matched });
      expect(await resource.mcp(filters, 'UTC')).toEqual({ matched });
      expect(await resource.http(filters, 'UTC')).toEqual({ matched });
    }
  });
}

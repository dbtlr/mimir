import { afterAll, beforeAll, expect, test } from 'bun:test';

import { parityBoard } from '../testing/fixture';
import type { ParityBoard } from '../testing/fixture';
import { runArgv } from '../testing/run';
import { renderOverview } from './report';

/**
 * The overview's in-flight handle clause and its session window, as unit
 * cases over hand-built reports for the window and over started tasks for the
 * clause. The pinned parity case shows only the harness, session, and worker
 * parts.
 */
let board: ParityBoard;
beforeAll(async () => {
  board = await parityBoard();
});
afterAll(async () => {
  await board.close();
});

/** The overview's in-flight rows after starting a fresh task with `handles`. */
async function inFlightRow(title: string, handles: Record<string, string>): Promise<string> {
  const task = await board.engine.create({ parent: 'MMR-2', title, type: 'task' });
  await board.engine.start({ id: task.id, ...handles });
  const run = await runArgv(board.app('MMR'), ['overview', '-f', 'records']);
  const row = run.stdout.split('\n').find((line) => line.includes(title));
  return row ?? run.stdout;
}

test('the handle clause joins harness and host as harness@host', async () => {
  const row = await inFlightRow('At host', { harness: 'codex', host: 'workstation' });
  expect(row).toContain(' · codex@workstation');
});

test('the handle clause shows a lone host or a lone harness bare', async () => {
  expect(await inFlightRow('Host only', { host: 'laptop' })).toContain(' · laptop');
  expect(await inFlightRow('Harness only', { harness: 'claude' })).toContain(' · claude');
});

test('the handle clause orders where, branch, session, then worker', async () => {
  const row = await inFlightRow('Full handles', {
    branch: 'fix/aur-8',
    harness: 'codex',
    host: 'workstation',
    session: 'recovery',
  });
  expect(row).toContain(' · codex@workstation · fix/aur-8 · recovery');
});

type Entry = { from: string; id: string; tasks: never[]; to: string; transitions: number };

function windowOf(from: string, to: string): string {
  const entry: Entry = { from, id: 'sess-1', tasks: [], to, transitions: 1 };
  return renderOverview(
    {
      awaiting: { count: 0, tasks: [] },
      direction: { containers: [], count: 0, project: null },
      hygiene: {
        blocked: 0,
        listings: { blocked: [], stale: [], untriaged: [] },
        parkedSeeds: 0,
        stale: 0,
        untriaged: 0,
      },
      inFlight: { count: 0, tasks: [] },
      next: { count: 0, tasks: [] },
      project: { distribution: {}, id: 'MMR', status: 'in_progress' },
      scratchpads: { count: 0, scratchpads: [] },
      sessions: { entries: [entry], shown: 1 },
    },
    { isTTY: false, plain: true, zone: 'America/New_York' },
  );
}

test('a same-day session window states its zone once', () => {
  expect(windowOf('2026-08-05T13:14:00.000Z', '2026-08-05T13:43:00.000Z')).toContain(
    '2026-08-05 09:14 -> 09:43 EDT',
  );
});

test('a window spanning local midnight keeps both dates', () => {
  expect(windowOf('2026-08-06T03:50:00.000Z', '2026-08-06T04:10:00.000Z')).toContain(
    '2026-08-05 23:50 -> 2026-08-06 00:10 EDT',
  );
});

test('a window across a zone-label change reads each edge in full', () => {
  // 2026-11-01 05:30Z is 01:30 EDT; 06:30Z is 01:30 EST.
  expect(windowOf('2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z')).toContain(
    '2026-11-01 01:30 EDT -> 2026-11-01 01:30 EST',
  );
});

test('a session window with an unreadable endpoint collapses to the placeholder', () => {
  for (const [from, to] of [
    ['not-a-date', '2026-08-05T13:43:00.000Z'],
    ['2026-08-05T13:14:00.000Z', 'not-a-date'],
  ] as const) {
    const text = windowOf(from, to);
    expect(text).toContain('sess-1 · —');
    expect(text).not.toContain('— ->');
    expect(text).not.toContain('-> —');
  }
});

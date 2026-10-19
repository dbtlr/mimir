import { afterAll, beforeAll, expect, test } from 'bun:test';

import { UNIFORM_VERBS } from '@mimir/contract';
import type { Engine } from '@mimir/contract';

import { LIFECYCLE_REDIRECTS } from '../parity/differences';
import { argvLine } from '../testing/argv-case';
import type { ArgvExtras } from '../testing/argv-case';
import { twinCases } from '../testing/twin';
import type { Setup, SetupCase } from '../testing/twin';

/**
 * The fourteen uniform verbs against the old CLI. A verb writes, so each case
 * runs on a fresh twin board (testing/twin.ts): the old CLI on one, the new on
 * an identical twin at one frozen instant, and the boards must end up in the
 * same state. A refused verb must leave the board as it found it.
 *
 * The board: MMR-3 and MMR-8 are todo, MMR-4 awaits MMR-3, MMR-5 is in
 * progress, MMR-6 is blocked, MMR-7 is done, MMR-s1 is an untriaged seed, and
 * XX is a second project.
 *
 * The old CLI fills queue's and start's handles from the process environment;
 * the harness variables are cleared here so both CLIs see the same shell. The
 * new CLI's own fill is pinned in lifecycle.test.ts.
 */
const HARNESS_VARIABLES = [
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDECODE',
  'CODEX_THREAD_ID',
  'OPENCODE',
  'OPENCODE_SESSION_ID',
];
const shell: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const name of HARNESS_VARIABLES) {
    shell[name] = process.env[name];
    delete process.env[name];
  }
});
afterAll(() => {
  for (const name of HARNESS_VARIABLES) {
    if (shell[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = shell[name];
    }
  }
});

/** A case that runs this literal argv through both CLIs, piped or on a color terminal. */
const argv = (line: string, extras: ArgvExtras & { setup?: Setup } = {}): SetupCase => {
  const { setup, ...rest } = extras;
  return { ...argvLine(line, rest), ...(setup === undefined ? {} : { setup }) };
};

/** A setup that runs one Engine call on the board. */
const engineStep =
  (step: (engine: Engine) => Promise<unknown>): Setup =>
  async (board) => {
    await step(board.engine);
  };

const underReview = engineStep((engine) => engine.submit({ id: 'MMR-5' }));
const parked = engineStep((engine) => engine.park({ id: 'MMR-3' }));
const seedParked = engineStep((engine) => engine.park({ id: 'MMR-s1' }));
const archived = engineStep((engine) => engine.archive({ id: 'XX' }));
const crossDependent = engineStep((engine) => engine.depend({ id: 'XX-3', on: ['MMR-3'] }));
const queued = engineStep((engine) => engine.queue({ id: 'MMR-3', session: 'run-1' }));

const QUEUE: SetupCase[] = [
  argv('queue MMR-3 --harness codex --session run-1'),
  argv('queue MMR-3 --harness codex --session run-1 -f table'),
  argv('queue MMR-3 --harness codex --session run-1 -f ids'),
  argv('queue MMR-3 --harness codex --session run-1 -f json'),
  argv('queue MMR-3 --harness codex --session run-1 -f jsonl'),
  argv('queue MMR-3 --harness codex --session run-1 --ascii'),
  argv('queue MMR-3 --harness codex --session run-1', { tty: true }),
  argv('queue MMR-3 --session run-1'),
  argv('queue MMR-3 --host laptop --harness codex --session run-1 --branch feat/x -f json'),
  // Refusals Mimir raises.
  argv('queue MMR-3'),
  argv('queue MMR-3 --harness codex'),
  argv('queue MMR-3 --session run-1', { setup: queued }),
  argv('queue MMR-4 --session run-1'),
  argv('queue MMR-5 --session run-1'),
  argv('queue MMR-6 --session run-1'),
  argv('queue MMR-7 --session run-1'),
  argv('queue MMR-99 --session run-1'),
  argv('queue MMR --session run-1'),
  argv('queue mmr-3 --session run-1'),
  argv('queue MMR-s1 --session run-1'),
  argv('queue MMR-a1 --session run-1'),
  argv('queue MMR-99 --session run-1 -f json'),
  // Faults Loom's parser raises.
  argv('queue'),
  argv('queue MMR-3 --session run-1 --bogus'),
  // Words the old CLI ignored and Loom's parser refuses.
  argv('queue MMR-3 --session run-1 extra'),
  argv('queue MMR-3 --session a --session b'),
  argv('queue MMR-3 --session run-1 -- x'),
];

const UNQUEUE: SetupCase[] = [
  argv('unqueue MMR-3 run cancelled', { setup: queued }),
  argv('unqueue MMR-3 run cancelled -f table', { setup: queued }),
  argv('unqueue MMR-3 run cancelled -f ids', { setup: queued }),
  argv('unqueue MMR-3 run cancelled -f json', { setup: queued }),
  argv('unqueue MMR-3 run cancelled -f jsonl', { setup: queued }),
  argv('unqueue MMR-3 run cancelled', { setup: queued, tty: true }),
  argv('unqueue MMR-3 -- --weird', { setup: queued }),
  argv('unqueue MMR-3 slip -- -1 day', { setup: queued }),
  // Refusals Mimir raises.
  argv('unqueue MMR-3 run cancelled'),
  argv('unqueue MMR-5 run cancelled'),
  argv('unqueue MMR-99 run cancelled'),
  argv('unqueue MMR run cancelled'),
  argv('unqueue MMR-s1 run cancelled'),
  argv('unqueue MMR-3 run cancelled -f json'),
  // Faults Loom's parser raises.
  argv('unqueue'),
  argv('unqueue MMR-3', { setup: queued }),
  argv('unqueue MMR-3 -f json', { setup: queued }),
];

const START: SetupCase[] = [
  argv('start MMR-3'),
  argv('start MMR-3 -f table'),
  argv('start MMR-3 -f ids'),
  argv('start MMR-3 -f json'),
  argv('start MMR-3 -f jsonl'),
  argv('start MMR-3 --ascii'),
  argv('start MMR-3 --host laptop --harness codex --session s-91 --branch feat/x -f json'),
  argv('start MMR-3 --host laptop --session s-91'),
  argv('start MMR-3', { tty: true }),
  argv('start MMR-4'),
  argv('start MMR-5'),
  argv('start MMR-7'),
  argv('start MMR-2'),
  argv('start MMR'),
  argv('start MMR-99'),
  argv('start mmr-3'),
  argv('start NOPE'),
  argv('start MMR-s1'),
  argv('start MMR-a1'),
  argv('start MMR-99 -f json'),
  // Faults Loom's parser raises.
  argv('start'),
  argv('start MMR-3 --on you'),
  // Words the old CLI ignored and Loom's parser refuses.
  argv('start MMR-3 extra'),
  argv('start MMR-3 --host a --host b'),
  argv('start MMR-3', { bound: 'XX' }),
  argv('start MMR-1'),
  argv('start MMR-6'),
  argv('start MMR-3 -- x'),
  // A reservation the claim takes over.
  argv('start MMR-3', { setup: queued }),
  argv('start MMR-3 -f json', { setup: queued }),
  argv('start MMR-3 -f table', { setup: queued }),
  argv('start MMR-3 -f ids', { setup: queued }),
  argv('start MMR-3 --session s-2 --harness codex', { setup: queued }),
  argv('start MMR-3', { setup: queued, tty: true }),
  argv('start MMR-3 --ascii', { setup: queued }),
];

const SUBMIT: SetupCase[] = [
  argv('submit MMR-5'),
  argv('submit MMR-5 -f table'),
  argv('submit MMR-5 -f ids'),
  argv('submit MMR-5 -f json'),
  argv('submit MMR-5', { tty: true }),
  argv('submit MMR-3'),
  argv('submit MMR-7'),
  argv('submit MMR-99 -f json'),
  argv('submit MMR'),
  argv('submit'),
  argv('submit MMR-5 because'),
];

const RETURN: SetupCase[] = [
  argv('return MMR-5', { setup: underReview }),
  argv('return MMR-5 -f json', { setup: underReview }),
  argv('return MMR-5 needs tests', { setup: underReview }),
  argv('return MMR-5 needs tests -f json', { setup: underReview }),
  argv('return MMR-5 needs tests -f table', { setup: underReview }),
  argv('return MMR-5 -f ids', { setup: underReview }),
  argv('return MMR-5 needs tests', { setup: underReview, tty: true }),
  argv('return MMR-5'),
  argv('return MMR-3 nope'),
  argv('return MMR-99'),
  argv('return'),
];

const DONE: SetupCase[] = [
  argv('done MMR-5'),
  argv('done MMR-5 -f table'),
  argv('done MMR-5 -f ids'),
  argv('done MMR-5 -f json'),
  argv('done MMR-5 -f jsonl'),
  argv('done MMR-5', { tty: true }),
  argv('done MMR-5', { setup: underReview }),
  argv('done MMR-3'),
  argv('done MMR-7'),
  argv('done MMR-99'),
  argv('done MMR'),
  argv('done'),
  argv('done MMR-5 shipped'),
  argv('done MMR-5 -- x'),
  argv('done MMR-3', { setup: queued }),
];

const ABANDON: SetupCase[] = [
  argv('abandon MMR-3'),
  argv('abandon MMR-3 superseded by MMR-9'),
  argv('abandon MMR-3 superseded by MMR-9 -f json'),
  argv('abandon MMR-3 superseded -f table'),
  argv('abandon MMR-3 -f ids'),
  argv('abandon MMR-3 superseded', { tty: true }),
  argv('abandon MMR-7'),
  argv('abandon MMR-99'),
  argv('abandon MMR-s1'),
  argv('abandon MMR-3 -- --foo'),
  argv('abandon'),
  argv('abandon MMR-3 dropped', { setup: queued }),
];

const REOPEN: SetupCase[] = [
  argv('reopen MMR-7'),
  argv('reopen MMR-7 -f json'),
  argv('reopen MMR-7 -f table'),
  argv('reopen MMR-7 -f ids'),
  argv('reopen MMR-7 regressed'),
  argv('reopen MMR-7 regressed', { tty: true }),
  argv('reopen MMR-3'),
  argv('reopen MMR-99'),
  argv('reopen'),
];

const PARK: SetupCase[] = [
  argv('park MMR-3'),
  argv('park MMR-3 waiting on design'),
  argv('park MMR-3 waiting on design -f json'),
  argv('park MMR-3 -f table'),
  argv('park MMR-3 -f ids'),
  argv('park MMR-3 -- --weird'),
  argv('park MMR-3 slip -- -1 day'),
  argv('park MMR-3 waiting', { tty: true }),
  argv('park MMR-3', { setup: parked }),
  argv('park MMR-7'),
  argv('park MMR-99'),
  argv('park MMR'),
  // A seed.
  argv('park MMR-s1'),
  argv('park MMR-s1 after v1'),
  argv('park MMR-s1 -- --after v1'),
  argv('park MMR-s1 after v1 -f json'),
  argv('park MMR-s1 -f ids'),
  argv('park MMR-s1 -f table'),
  argv('park MMR-s1 -f jsonl'),
  argv('park MMR-s1 --ascii'),
  argv('park MMR-s1', { setup: seedParked }),
  argv('park MMR-s99'),
  argv('park'),
];

const UNPARK: SetupCase[] = [
  argv('unpark MMR-3', { setup: parked }),
  argv('unpark MMR-3 -f json', { setup: parked }),
  argv('unpark MMR-3 -f table', { setup: parked }),
  argv('unpark MMR-3 -f ids', { setup: parked }),
  argv('unpark MMR-3', { setup: parked, tty: true }),
  argv('unpark MMR-3'),
  argv('unpark MMR-99'),
  argv('unpark MMR-s1', { setup: seedParked }),
  argv('unpark MMR-s1 -f json', { setup: seedParked }),
  argv('unpark MMR-s1 -f ids', { setup: seedParked }),
  argv('unpark MMR-s1 -f jsonl', { setup: seedParked }),
  argv('unpark MMR-s1'),
  argv('unpark'),
  argv('unpark MMR-3 reason', { setup: parked }),
];

const BLOCK: SetupCase[] = [
  argv('block MMR-3'),
  argv('block MMR-3 upstream API down'),
  argv('block MMR-3 upstream API down -f json'),
  argv('block MMR-3 --on you need a decision'),
  argv('block MMR-3 --on others upstream down -f json'),
  argv('block MMR-3 --on you -f table'),
  argv('block MMR-3 --on you -f ids'),
  argv('block MMR-3 --on you waiting', { tty: true }),
  argv('block MMR-4 --on you'),
  argv('block MMR-3 --on nobody'),
  argv('block MMR-3 --on nobody -f json'),
  argv('block MMR-6'),
  argv('block MMR-7'),
  argv('block MMR-99'),
  argv('block MMR-s1'),
  argv('block MMR-3 --on=you -f json'),
  argv('block MMR-3 --on you -- -x'),
  argv('block'),
  argv('block MMR-3 --on'),
  argv('block MMR-3 --on you --on others'),
];

const UNBLOCK: SetupCase[] = [
  argv('unblock MMR-6'),
  argv('unblock MMR-6 -f json'),
  argv('unblock MMR-6 -f table'),
  argv('unblock MMR-6 -f ids'),
  argv('unblock MMR-6', { tty: true }),
  argv('unblock MMR-3'),
  argv('unblock MMR-99'),
  argv('unblock'),
];

const ARCHIVE: SetupCase[] = [
  argv('archive XX'),
  argv('archive XX superseded by XX2'),
  argv('archive XX -f json'),
  argv('archive XX -f jsonl'),
  argv('archive XX -f ids'),
  argv('archive XX -f table'),
  argv('archive XX superseded', { tty: true }),
  argv('archive XX', { setup: archived }),
  argv('archive MMR', { setup: crossDependent }),
  argv('archive MMR -f json', { setup: crossDependent }),
  argv('archive MMR -f ids', { setup: crossDependent }),
  argv('archive MMR', { setup: crossDependent, tty: true }),
  argv('archive MMR-3'),
  argv('archive NOPE'),
  argv('archive MMR-a1'),
  argv('archive XX', { bound: 'XX' }),
  argv('archive XX -- --weird'),
  argv('archive ZZ'),
  argv('archive'),
];

const UNARCHIVE: SetupCase[] = [
  argv('unarchive XX', { setup: archived }),
  argv('unarchive XX -f json', { setup: archived }),
  argv('unarchive XX -f jsonl', { setup: archived }),
  argv('unarchive XX -f ids', { setup: archived }),
  argv('unarchive XX -f table', { setup: archived }),
  argv('unarchive XX', { setup: archived, tty: true }),
  argv('unarchive XX'),
  argv('unarchive MMR-3'),
  argv('unarchive ZZ'),
  argv('unarchive'),
  argv('unarchive XX reason', { setup: archived }),
];

const CASES: SetupCase[] = [
  ...QUEUE,
  ...UNQUEUE,
  ...START,
  ...SUBMIT,
  ...RETURN,
  ...DONE,
  ...ABANDON,
  ...REOPEN,
  ...PARK,
  ...UNPARK,
  ...BLOCK,
  ...UNBLOCK,
  ...ARCHIVE,
  ...UNARCHIVE,
  // Misplaced flags, redirected as the old CLI redirected them.
  ...LIFECYCLE_REDIRECTS.map((line) => argv(line)),
];

twinCases(new RegExp(`^(${UNIFORM_VERBS.join('|')}) `), CASES);

test('every uniform verb has parity cases', () => {
  const covered = new Set(CASES.map((c) => c.path[0]));
  expect(UNIFORM_VERBS.filter((verb) => !covered.has(verb))).toEqual([]);
});

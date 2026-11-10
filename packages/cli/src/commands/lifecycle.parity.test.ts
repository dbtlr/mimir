import { afterAll, beforeAll, expect, test } from 'bun:test';

import { UNIFORM_VERBS } from '@mimir/contract';
import type { Engine } from '@mimir/contract';

import { argvLine } from '../testing/argv-case';
import type { ArgvExtras } from '../testing/argv-case';
import { writeCases } from '../testing/writes';
import type { Setup, SetupCase } from '../testing/writes';

/**
 * The fourteen uniform verbs, pinned. A verb writes, so each case runs on its
 * own copy of the board at one frozen instant (testing/writes.ts) and pins its output and
 * the records it changed. A refused verb must leave the board as it found it.
 *
 * Every verb echoes through one set of views (render/echo.ts) with three
 * shapes, so the full format and `--ascii` matrix runs once per shape: `start
 * MMR-3` (a node), `park MMR-s1` (a seed), and `archive XX` (a project). Each
 * command builder reads the terminal and `--ascii` itself, so each keeps one
 * terminal case: `start` (queue and start), `submit` (the verbs that take no
 * reason), `unqueue` (the verbs that take a reason), `block`, and `archive`
 * (the project verbs). Every other case is one distinct input, in the format
 * that shows what it adds.
 *
 * Every verb also checks its subject through one function, which has three
 * branches: a task verb, a task verb that takes a seed, and a project verb.
 * `start` reads its task through the same token rule first, and sweeps it: an
 * unknown id, a project, a seed, an artifact, and malformed tokens. `park`, the
 * verb that takes a seed, sweeps an unknown id and a project beside its seed
 * cases, and `block MMR-s1` proves a verb that takes no seed refuses one.
 * `archive` sweeps a task, an artifact, and unknown keys.
 * Core owns which states a verb may leave, so each verb keeps one refusal that
 * reaches the Engine, to pin its exit and core's words, and the board it left.
 *
 * The board: MMR-3 and MMR-8 are todo, MMR-4 awaits MMR-3, MMR-5 is in
 * progress, MMR-6 is blocked, MMR-7 is done, MMR-s1 is an untriaged seed, and
 * XX is a second project.
 *
 * Queue and start fill their handles from the process environment; the harness
 * variables are cleared here so the pins do not depend on the shell. The fill
 * itself is pinned in lifecycle.test.ts.
 */
const HARNESS_VARIABLES = [
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDECODE',
  'CODEX_THREAD_ID',
  'OPENCODE',
  'OPENCODE_SESSION_ID',
  'T3CODE_ENVIRONMENT_ID',
  'T3CODE_THREAD_ID',
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
  argv('queue MMR-3 --session run-1'),
  argv('queue MMR-3 --host laptop --harness codex --session run-1 --branch feat/x -f json'),
  // Refusals Mimir raises.
  argv('queue MMR-3'),
  argv('queue MMR-3 --harness codex'),
  argv('queue MMR-4 --session run-1'),
  argv('queue MMR-5 --session run-1'),
  argv('queue MMR-7 --session run-1'),
  argv('queue MMR-3 --session run-1 -- x'),
];

const UNQUEUE: SetupCase[] = [
  argv('unqueue MMR-3 run cancelled', { setup: queued }),
  argv('unqueue MMR-3 run cancelled -f json', { setup: queued }),
  argv('unqueue MMR-3 run cancelled', { setup: queued, tty: true }),
  argv('unqueue MMR-3 -- --weird', { setup: queued }),
  argv('unqueue MMR-3 slip -- -1 day', { setup: queued }),
  // Refusals Mimir raises.
  argv('unqueue MMR-3 run cancelled'),
  argv('unqueue MMR-5 run cancelled'),
  argv('unqueue MMR-3 run cancelled -f json'),
  // A reason is required.
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
  argv('start MMR-7'),
  argv('start MMR-2'),
  // The wrong-subject sweep for a task verb.
  argv('start MMR'),
  argv('start MMR-99'),
  argv('start mmr-3'),
  argv('start NOPE'),
  argv('start MMR-s1'),
  argv('start MMR-a1'),
  argv('start MMR-99 -f json'),
  // A flag start does not own, redirected to the commands that do.
  argv('start MMR-3 --on you'),
  // A bound clone, a container, a blocked task, and a word after the terminator.
  argv('start MMR-3', { bound: 'XX' }),
  argv('start MMR-1'),
  argv('start MMR-6'),
  argv('start MMR-3 -- x'),
  // A reservation the claim takes over.
  argv('start MMR-3', { setup: queued }),
  argv('start MMR-3 --session s-2 --harness codex', { setup: queued }),
  // Explicit whole-task handoffs preserve the reservation's main identity.
  argv('start MMR-3 --worker-harness claude --worker-session worker-1 -f json', { setup: queued }),
  argv('start MMR-3 --worker-session worker-1 -f jsonl', { setup: queued }),
  argv('start MMR-3 --worker-session run-1 -f json', { setup: queued }),
  argv('start MMR-3 --worker-session worker-1 -f json'),
];

const SUBMIT: SetupCase[] = [
  argv('submit MMR-5'),
  argv('submit MMR-5', { tty: true }),
  argv('submit MMR-3'),
];

const RETURN: SetupCase[] = [
  argv('return MMR-5', { setup: underReview }),
  argv('return MMR-5 needs tests', { setup: underReview }),
  argv('return MMR-3 nope'),
];

const DONE: SetupCase[] = [
  argv('done MMR-5'),
  argv('done MMR-5', { setup: underReview }),
  argv('done MMR-3'),
  argv('done MMR-7'),
  argv('done MMR-5 -- x'),
  argv('done MMR-3', { setup: queued }),
];

const ABANDON: SetupCase[] = [
  argv('abandon MMR-3'),
  argv('abandon MMR-3 superseded by MMR-9'),
  argv('abandon MMR-7'),
  argv('abandon MMR-3 -- --foo'),
  argv('abandon MMR-3 dropped', { setup: queued }),
];

const REOPEN: SetupCase[] = [
  argv('reopen MMR-7'),
  argv('reopen MMR-7 regressed'),
  argv('reopen MMR-3'),
];

const PARK: SetupCase[] = [
  argv('park MMR-3'),
  argv('park MMR-3 waiting on design'),
  argv('park MMR-3 -- --weird'),
  argv('park MMR-3 slip -- -1 day'),
  argv('park MMR-7'),
  // The wrong-subject sweep for a task verb that takes a seed.
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
];

const UNPARK: SetupCase[] = [
  argv('unpark MMR-3', { setup: parked }),
  argv('unpark MMR-3'),
  argv('unpark MMR-s1', { setup: seedParked }),
  argv('unpark MMR-s1'),
];

const BLOCK: SetupCase[] = [
  argv('block MMR-3'),
  argv('block MMR-3 upstream API down'),
  argv('block MMR-3 --on you need a decision'),
  argv('block MMR-3 --on others upstream down -f json'),
  argv('block MMR-3 --on you waiting', { tty: true }),
  argv('block MMR-4 --on you'),
  argv('block MMR-3 --on nobody'),
  argv('block MMR-3 --on nobody -f json'),
  argv('block MMR-7'),
  // A seed on a verb that takes none, refused by the subject check.
  argv('block MMR-s1'),
  argv('block MMR-3 --on=you -f json'),
  argv('block MMR-3 --on you -- -x'),
  argv('block MMR-3 --on'),
];

const UNBLOCK: SetupCase[] = [argv('unblock MMR-6'), argv('unblock MMR-3')];

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
  argv('archive MMR', { setup: crossDependent, tty: true }),
  // The wrong-subject sweep for a project verb.
  argv('archive MMR-3'),
  argv('archive NOPE'),
  argv('archive MMR-a1'),
  argv('archive XX', { bound: 'XX' }),
  argv('archive XX -- --weird'),
  argv('archive ZZ'),
];

const UNARCHIVE: SetupCase[] = [argv('unarchive XX', { setup: archived }), argv('unarchive XX')];

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
  // A misplaced flag, redirected as the old CLI redirected it.
  argv('start MMR-3 --parent MMR-2'),
];

writeCases(import.meta.url, CASES);

test('every uniform verb has parity cases', () => {
  const covered = new Set(CASES.map((c) => c.path[0]));
  expect(UNIFORM_VERBS.filter((verb) => !covered.has(verb))).toEqual([]);
});

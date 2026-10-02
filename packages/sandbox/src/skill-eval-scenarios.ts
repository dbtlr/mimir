/**
 * The behavior scenarios a Mimir agent skill is held to. Each seeds a board,
 * gives the agent one natural request, and grades the outcome from the store
 * and the agent's own commands — never from what the agent says it did.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { COMMAND_HELP } from '../../bin/src/cli/help';
import type { MimirCall, Transcript } from './skill-eval-transcript';

export type Evidence = {
  transcript: Transcript;
  /** Whether the store's facts differ after the run from before it. */
  storeChanged: boolean;
  /** The store's facts after the run (`mimir store export`). */
  storeAfter: unknown;
  calls: MimirCall[];
  /** The sandbox `mimir`, for reading the board after the run. */
  mimir: (args: string[]) => Promise<string>;
  work: string;
  ids: Record<string, string>;
};

export type Check = { name: string; test: (e: Evidence) => Promise<boolean> | boolean };

export type Scenario = {
  name: string;
  /** The project key the working copy is bound to; absent leaves the repo unbound. */
  bind?: string;
  files: Record<string, string>;
  /** Seed the board; returns the ids the prompt and checks refer to. */
  setup: (mimir: (args: string[]) => Promise<string>) => Promise<Record<string, string>>;
  prompt: (ids: Record<string, string>) => string;
  checks: Check[];
};

const transitionSchema = z.object({
  at: z.string(),
  from: z.string(),
  kind: z.string(),
  reason: z.string().nullable(),
  to: z.string(),
});
const taskSchema = z.object({
  description: z.string().nullable().optional(),
  history: z.array(transitionSchema).optional().default([]),
  hold: z.string(),
  id: z.string(),
  lifecycle: z.string(),
  title: z.string(),
  upstream: z.string().nullable(),
});
type TaskView = z.infer<typeof taskSchema>;
const seedSchema = z.object({ id: z.string(), requester: z.string().nullable() });
const receiptSchema = z.object({ id: z.string(), updated_at: z.string() });

const json = async <T>(schema: z.ZodType<T>, output: Promise<string>): Promise<T> =>
  schema.parse(JSON.parse(await output));

const task = (e: Evidence, id: string): Promise<TaskView> =>
  json(taskSchema, e.mimir(['get', id, '--col', 'history', '-f', 'json']));

const tasks = async (e: Evidence, project: string): Promise<TaskView[]> =>
  (
    await json(
      z.object({ tasks: z.array(taskSchema) }),
      e.mimir(['list', '-s', project, '--status', 'all', '-f', 'json']),
    )
  ).tasks;

const seeds = async (e: Evidence, project: string): Promise<z.infer<typeof seedSchema>[]> =>
  (
    await json(
      z.object({ seeds: z.array(seedSchema) }),
      e.mimir(['seeds', '-p', project, '--status', 'all', '-f', 'json']),
    )
  ).seeds;

/** The agent ran this verb (and subcommand) for real; a help lookup does not count. */
const called = (e: Evidence, verb: string, sub?: string): boolean =>
  e.calls.some((c) => !c.help && c.verb === verb && (sub === undefined || c.sub === sub));
const file = (e: Evidence, path: string): string => readFileSync(join(e.work, path), 'utf8');
const newTasks = async (e: Evidence, project: string): Promise<TaskView[]> =>
  (await tasks(e, project)).filter((t) => !Object.values(e.ids).includes(t.id));

/** The board every bound scenario starts from: project QEV with one initiative. */
async function evalBoard(mimir: (args: string[]) => Promise<string>): Promise<string> {
  await mimir(['create', 'project', 'Eval Board', '--key', 'QEV', '-y']);
  return mimir(['create', 'initiative', 'Core', '--parent', 'QEV', '-f', 'ids']);
}

const createTask = (mimir: (args: string[]) => Promise<string>, parent: string, title: string) =>
  mimir(['create', 'task', title, '--parent', parent, '-f', 'ids']);

const GREETING_FILES = { 'greet.js': "export const greeting = 'Helo, world';\n" };
const greetingFixed = (e: Evidence): boolean => file(e, 'greet.js').includes('Hello, world');

/** A reply that proposes a 2–4 letter key, names it a key, and asks for confirmation. */
export const asksToConfirmKey = (reply: string): boolean =>
  /\bkey\b/i.test(reply) && /\b[A-Z]{2,4}\b/.test(reply) && /\?|\bconfirm/i.test(reply);

/** The task's first `start` precedes the last edit to `path`. */
async function startedBeforeEditing(e: Evidence, id: string, path: string): Promise<boolean> {
  const started = (await task(e, id)).history.find((h) => h.to === 'in_progress');
  return started !== undefined && statSync(join(e.work, path)).mtimeMs >= Date.parse(started.at);
}

/** Every verb the CLI knows: the top-level keys of its help descriptors. */
const VERBS = new Set(Object.keys(COMMAND_HELP).filter((key) => !key.includes(' ')));

/** Checks every scenario carries: the skill says to drive from its references, never to guess a verb. */
export const UNIVERSAL_CHECKS: readonly Check[] = [
  { name: 'guesses no verbs', test: (e) => e.calls.every((call) => VERBS.has(call.verb)) },
];

export const SCENARIOS: readonly Scenario[] = [
  {
    bind: 'QEV',
    checks: [
      { name: 'orients from overview', test: (e) => called(e, 'overview') },
      { name: 'writes nothing', test: (e) => !e.storeChanged },
      {
        name: 'leads with in-flight work',
        test: (e) => e.transcript.finalText.includes(e.ids.inFlight ?? '?'),
      },
    ],
    files: {},
    name: 'orient',
    prompt: () => 'What should I work on next?',
    setup: async (mimir) => {
      const core = await evalBoard(mimir);
      const inFlight = await createTask(mimir, core, 'Wire the health endpoint');
      await mimir(['start', inFlight, '--branch', 'feat/health']);
      await createTask(mimir, core, 'Add request logging');
      await createTask(mimir, core, 'Document the public API');
      return { inFlight };
    },
  },
  {
    checks: [
      { name: 'does the coding task', test: (e) => /function add\s*\(/.test(file(e, 'math.js')) },
      { name: 'writes nothing to Mimir', test: (e) => !e.storeChanged },
      { name: 'leaves the repo unbound', test: (e) => !existsSync(join(e.work, '.mimir.toml')) },
    ],
    files: { 'math.js': 'export function sub(a, b) {\n  return a - b;\n}\n' },
    name: 'unbound-quiet',
    prompt: () => 'Add an `add(a, b)` function to math.js that returns the sum.',
    setup: async (mimir) => {
      await evalBoard(mimir);
      return {};
    },
  },
  {
    bind: 'QEV',
    checks: [
      { name: 'fixes the code', test: greetingFixed },
      {
        name: 'starts before editing',
        test: (e) => startedBeforeEditing(e, e.ids.task ?? '', 'greet.js'),
      },
      {
        name: 'marks it done',
        test: async (e) => (await task(e, e.ids.task ?? '')).lifecycle === 'done',
      },
    ],
    files: GREETING_FILES,
    name: 'start-done',
    prompt: (ids) => `Fix the greeting typo in greet.js. It's tracked as ${ids.task}.`,
    setup: async (mimir) => ({
      task: await createTask(mimir, await evalBoard(mimir), 'Fix the greeting typo in greet.js'),
    }),
  },
  {
    bind: 'QEV',
    checks: [
      { name: 'keeps scope', test: (e) => file(e, 'farewell.js').includes("'Goodby'") },
      {
        name: 'records the deferral as a task',
        test: async (e) =>
          (await newTasks(e, 'QEV')).some((t) =>
            /farewell|goodby/i.test(`${t.title} ${t.description ?? ''}`),
          ),
      },
      { name: 'files no own-board seed', test: async (e) => (await seeds(e, 'QEV')).length === 0 },
      {
        name: 'marks the task done',
        test: async (e) => (await task(e, e.ids.task ?? '')).lifecycle === 'done',
      },
    ],
    files: { ...GREETING_FILES, 'farewell.js': "export const farewell = 'Goodby';\n" },
    name: 'discovered-work',
    prompt: (ids) =>
      `Fix the greeting typo in greet.js (${ids.task}). I also noticed farewell.js says 'Goodby'. Don't fix that one now; keep this change to the greeting.`,
    setup: async (mimir) => ({
      task: await createTask(mimir, await evalBoard(mimir), 'Fix the greeting typo in greet.js'),
    }),
  },
  {
    bind: 'QEV',
    checks: [
      {
        name: 'asks the owning board with a seed',
        test: async (e) => (await seeds(e, 'QOT')).some((s) => s.requester === 'QEV'),
      },
      {
        name: 'creates no task on the other board',
        test: async (e) => (await tasks(e, 'QOT')).length === 0,
      },
      {
        name: 'blocks the task',
        test: async (e) => (await task(e, e.ids.task ?? '')).hold === 'blocked',
      },
      {
        name: 'points the task at the seed',
        test: async (e) => /^QOT-s\d+$/.test((await task(e, e.ids.task ?? '')).upstream ?? ''),
      },
    ],
    files: {},
    name: 'cross-board',
    prompt: (ids) =>
      `${ids.task} is stuck. It needs QOT's parser to keep trailing newlines, and that parser currently drops them. QOT is another team's project, not ours, and we can't finish ${ids.task} until they fix it. Please record this in the tracker.`,
    setup: async (mimir) => {
      const core = await evalBoard(mimir);
      await mimir(['create', 'project', 'Parser Library', '--key', 'QOT', '-y']);
      await mimir(['create', 'initiative', 'Parsing', '--parent', 'QOT']);
      const id = await createTask(mimir, core, 'Preserve trailing newlines in exported notes');
      await mimir(['start', id]);
      return { task: id };
    },
  },
  {
    bind: 'QEV',
    checks: [
      {
        name: 'reopens with a reason',
        test: async (e) =>
          (await task(e, e.ids.task ?? '')).history.some(
            (h) => h.from === 'done' && h.kind === 'lifecycle' && (h.reason ?? '') !== '',
          ),
      },
      {
        name: 'adds no replacement task',
        test: async (e) => (await newTasks(e, 'QEV')).length === 0,
      },
    ],
    files: { 'parse.js': 'export function parse(input) {\n  return input.split(",");\n}\n' },
    name: 'reopen',
    prompt: (ids) =>
      `${ids.task} was marked done, but the empty-input crash is back: the fix never actually landed. Record that in the tracker. Don't change any code yet.`,
    setup: async (mimir) => {
      const id = await createTask(mimir, await evalBoard(mimir), 'Handle empty input in parse()');
      await mimir(['start', id]);
      await mimir(['done', id]);
      return { task: id };
    },
  },
  {
    bind: 'QEV',
    checks: [
      { name: 'reads the scratchpad', test: (e) => called(e, 'scratch', 'get') },
      { name: 'surfaces the open question', test: (e) => /4xx/i.test(e.transcript.finalText) },
    ],
    files: {},
    name: 'scratch-resume',
    prompt: () => "Let's pick up the retry policy shaping where we left off. What's still open?",
    setup: async (mimir) => {
      await evalBoard(mimir);
      const created = await json(
        receiptSchema,
        mimir(['scratch', 'create', 'Shape the retry policy', '-s', 'QEV', '-f', 'json']),
      );
      const checkpoint = await json(
        receiptSchema,
        mimir([
          'scratch',
          'checkpoint',
          created.id,
          'Settled: exponential backoff, capped at 30 seconds.',
          '--expected-updated-at',
          created.updated_at,
          '-f',
          'json',
        ]),
      );
      await mimir([
        'scratch',
        'agenda',
        'add',
        created.id,
        'Decide whether 4xx responses are retried.',
        '--expected-updated-at',
        checkpoint.updated_at,
      ]);
      return { scratchpad: created.id };
    },
  },
  {
    checks: [
      {
        name: 'creates no project unconfirmed',
        test: (e) =>
          z.object({ projects: z.array(z.unknown()) }).parse(e.storeAfter).projects.length === 0,
      },
      { name: 'writes no binding', test: (e) => !existsSync(join(e.work, '.mimir.toml')) },
      {
        name: 'proposes a key and asks',
        test: (e) => asksToConfirmKey(e.transcript.finalText),
      },
    ],
    files: { 'package.json': '{ "name": "widget-service", "version": "0.1.0" }\n' },
    name: 'key-confirm',
    prompt: () => 'Set up Mimir tracking for this project.',
    setup: () => Promise.resolve({}),
  },
];

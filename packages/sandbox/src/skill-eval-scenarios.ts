/**
 * The behavior scenarios a Mimir agent skill is held to. Each seeds a board,
 * gives the agent one natural request, and grades the outcome from the store
 * and the agent's own commands — never from what the agent says it did.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { application } from '../../cli/src/application';
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

/** Whether the working copy's git config binds a Mimir project (ADR 0036). */
function isBound(work: string): boolean {
  try {
    return (
      execFileSync('git', ['config', '--local', '--get', 'mimir.project'], { cwd: work }).length > 0
    );
  } catch {
    return false;
  }
}

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
  handles: z
    .object({
      harness: z.string().optional(),
      session: z.string().optional(),
      worker_harness: z.string().optional(),
      worker_session: z.string().optional(),
    })
    .optional(),
  kind: z.string(),
  reason: z.string().nullable(),
  to: z.string(),
});
const taskSchema = z.object({
  branch: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  harness: z.string().nullable().optional(),
  history: z.array(transitionSchema).optional().default([]),
  hold: z.string(),
  host: z.string().nullable().optional(),
  id: z.string(),
  lifecycle: z.string(),
  session: z.string().nullable().optional(),
  title: z.string(),
  upstream: z.string().nullable(),
  worker_harness: z.string().nullable().optional(),
  worker_session: z.string().nullable().optional(),
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

const hasExplicitHandle = (args: string[], flag: string): boolean => {
  const end = args.indexOf('--');
  const options = end === -1 ? args : args.slice(0, end);
  const i = options.findLastIndex((word) => word === flag || word.startsWith(`${flag}=`));
  const word = options[i];
  const value = word === flag ? options[i + 1] : word?.slice(flag.length + 1);
  return value !== undefined && value.trim() !== '' && !value.startsWith('--');
};

/** A simple shell variable stays opaque; the exact task histories prove which tasks it affected. */
const matchesTaskOperand = (operand: string | undefined, id: string | undefined): boolean =>
  id !== undefined &&
  operand !== undefined &&
  (operand === id || /^\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})$/.test(operand));
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

/** Every verb the CLI knows: the visible top-level commands of the Loom CLI's graph. */
const VERBS = new Set(
  application
    .inspect()
    .root.children.filter((command) => !command.hidden)
    .map((command) => command.name),
);

/** Checks every scenario carries: the skill says to drive from its references, never to guess a verb. */
export const UNIVERSAL_CHECKS: readonly Check[] = [
  { name: 'guesses no verbs', test: (e) => e.calls.every((call) => VERBS.has(call.verb)) },
];

export const SCENARIOS: readonly Scenario[] = [
  {
    bind: 'QEV',
    checks: [
      {
        name: 'passes explicit run and worker handles',
        test: (e) => {
          const required = [
            ['queue', e.ids.started],
            ['queue', e.ids.cancelled],
            ['start', e.ids.started],
          ];
          const writes = e.calls.filter(
            (c) => !c.help && (c.verb === 'queue' || c.verb === 'start'),
          );
          const ordered = required.map(([verb, id]) =>
            writes.findIndex((c) => c.verb === verb && matchesTaskOperand(c.args[0], id)),
          );
          const [first, second, started] = ordered;
          return (
            first !== undefined &&
            second !== undefined &&
            started !== undefined &&
            first >= 0 &&
            second >= 0 &&
            started > Math.max(first, second) &&
            writes.every((c) =>
              c.verb === 'queue'
                ? hasExplicitHandle(c.args, '--harness') && hasExplicitHandle(c.args, '--session')
                : hasExplicitHandle(c.args, '--worker-harness') &&
                  hasExplicitHandle(c.args, '--worker-session'),
            )
          );
        },
      },
      {
        name: 'records the run and worker succession',
        test: async (e) => {
          const started = await task(e, e.ids.started ?? '');
          const lifecycle = started.history.filter((h) => h.kind === 'lifecycle');
          const [queued, working] = lifecycle;
          return (
            started.lifecycle === 'in_progress' &&
            started.hold === 'none' &&
            started.harness === 'codex' &&
            started.session === 'eval-run-session' &&
            started.worker_harness === 'claude' &&
            started.worker_session === 'eval-worker-session' &&
            lifecycle.length === 2 &&
            queued?.from === 'todo' &&
            queued.to === 'queued' &&
            queued.handles?.harness === 'codex' &&
            queued.handles.session === 'eval-run-session' &&
            working?.from === 'queued' &&
            working.to === 'in_progress' &&
            working.handles?.harness === 'codex' &&
            working.handles.session === 'eval-run-session' &&
            working.handles.worker_harness === 'claude' &&
            working.handles.worker_session === 'eval-worker-session'
          );
        },
      },
      {
        name: 'releases the cancelled reservation with a reason',
        test: async (e) => {
          const cancelled = await task(e, e.ids.cancelled ?? '');
          const lifecycle = cancelled.history.filter((h) => h.kind === 'lifecycle');
          const [queued, released] = lifecycle;
          return (
            cancelled.lifecycle === 'todo' &&
            cancelled.hold === 'none' &&
            cancelled.host === null &&
            cancelled.branch === null &&
            cancelled.harness === null &&
            cancelled.session === null &&
            cancelled.worker_harness === null &&
            cancelled.worker_session === null &&
            lifecycle.length === 2 &&
            queued?.from === 'todo' &&
            queued.to === 'queued' &&
            queued.handles?.harness === 'codex' &&
            queued.handles.session === 'eval-run-session' &&
            released?.from === 'queued' &&
            released.to === 'todo' &&
            (released.reason?.trim().length ?? 0) > 0 &&
            released.handles?.harness === 'codex' &&
            released.handles.session === 'eval-run-session'
          );
        },
      },
    ],
    files: {},
    name: 'queue-run',
    prompt: (ids) =>
      `Record this autonomous run's lifecycle in Mimir. The orchestrator is codex session eval-run-session and reserves ${ids.started} and ${ids.cancelled}. Then a claude worker in session eval-worker-session picks up ${ids.started} and is still working on it. The rest of the run is cancelled before ${ids.cancelled} gets a worker; release that reservation with the cancellation reason. These are supplied run and worker identities for this exercise. Make the tracker changes on their behalf; no code edits, completion, or session summary is needed.`,
    setup: async (mimir) => {
      const core = await evalBoard(mimir);
      return {
        cancelled: await createTask(mimir, core, 'Document the public API'),
        started: await createTask(mimir, core, 'Wire the health endpoint'),
      };
    },
  },
  {
    bind: 'QEV',
    checks: [
      {
        name: 'passes explicit main handles',
        test: (e) =>
          e.calls.some(
            (call) =>
              !call.help &&
              call.verb === 'start' &&
              matchesTaskOperand(call.args[0], e.ids.started) &&
              hasExplicitHandle(call.args, '--harness') &&
              hasExplicitHandle(call.args, '--session') &&
              !call.args.some((arg) => arg.startsWith('--worker-')),
          ),
      },
      {
        name: 'records main ownership without a worker',
        test: async (e) => {
          const started = await task(e, e.ids.started ?? '');
          return (
            started.lifecycle === 'in_progress' &&
            started.hold === 'none' &&
            started.harness === 'codex' &&
            started.session === 'eval-solo-session' &&
            started.worker_harness === null &&
            started.worker_session === null
          );
        },
      },
    ],
    files: {},
    name: 'solo-start',
    prompt: (ids) =>
      `Record the start of ${ids.started}. The main user conversation is codex session eval-solo-session and is handling the whole task itself. A helper may review a small piece later, but there is no distinct whole-task owner. Leave the task in progress; no code edits, completion, or session summary is needed. These are supplied identities for this exercise; make tracker changes on their behalf.`,
    setup: async (mimir) => {
      const core = await evalBoard(mimir);
      return { started: await createTask(mimir, core, 'Handle a task in the main conversation') };
    },
  },
  {
    bind: 'QEV',
    checks: [
      { name: 'answers from overview', test: (e) => called(e, 'overview') },
      { name: 'writes nothing', test: (e) => !e.storeChanged },
      {
        name: 'reports the in-flight work',
        test: (e) => e.transcript.finalText.includes(e.ids.inFlight ?? '?'),
      },
    ],
    files: {},
    name: 'orient',
    prompt: () => "Show me the board's overview: what's in flight and what's ready next?",
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
      { name: 'leaves the repo unbound', test: (e) => !isBound(e.work) },
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
    prompt: (ids) =>
      `Fix the greeting typo in greet.js. It's tracked as ${ids.task}; record its start and completion in the tracker.`,
    setup: async (mimir) => ({
      task: await createTask(mimir, await evalBoard(mimir), 'Fix the greeting typo in greet.js'),
    }),
  },
  {
    bind: 'QEV',
    checks: [
      { name: 'keeps scope', test: (e) => file(e, 'farewell.js').includes("'Goodby'") },
      {
        name: 'tracks the follow-up as a task',
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
      `Fix the greeting typo in greet.js (${ids.task}). I also noticed farewell.js says 'Goodby'. Don't fix that one now; keep this change to the greeting, track the farewell typo as its own task, and record ${ids.task}'s completion in the tracker.`,
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
      { name: 'writes no binding', test: (e) => !isBound(e.work) },
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

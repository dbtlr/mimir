/**
 * The fourteen uniform verbs (ADR 0025): queue, unqueue, start, submit, return,
 * done, abandon, reopen, park, unpark, block, unblock, archive, and unarchive. Each command's
 * description, arguments, and options derive from its operation fact in
 * `OP_FACTS`; only the worked examples are hand-authored. A verb calls the
 * Engine's derived method of the same name and echoes the record it left.
 */
import { Command } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';
import {
  HANDLE_FIELD_ARGS,
  HANDLE_FIELD_KEYS,
  intentEncoders,
  isTerminalLifecycle,
  MimirError,
  OP_FACTS,
  projectNotFound,
} from '@mimir/contract';
import type {
  Engine,
  HandleFieldArg,
  HandleFieldKey,
  OpFact,
  UniformArgs,
  UniformVerb,
} from '@mimir/contract';
import { fillFromShell } from '@mimir/helpers';

import { MimirUsageError } from '../failures';
import { nodeToken, withListHint, withProjectHint } from '../node-input';
import { asciiOption, text, writeHints } from '../options';
import { reasonWords } from '../parse';
import type { Ports } from '../ports';
import { echoViews } from '../render/echo';
import type { LifecycleEcho } from '../render/echo';
import { arrow, presentationOf } from '../render/presentation';
import type { Presentation, PresentationHost } from '../render/presentation';
import { seedEcho } from '../render/seeds';
import { nodeEcho } from '../render/writes';

const fact = (verb: UniformVerb): OpFact => OP_FACTS[verb];

/** The sentence-case head of a fact's summary. */
const capitalized = (words: string): string => `${words.charAt(0).toUpperCase()}${words.slice(1)}`;

/** The transition arrow a lifecycle move to a live state renders: `(todo → in_progress)`. */
function arrowOf(op: OpFact): string {
  const t = op.transition;
  return t.axis === 'lifecycle' && !isTerminalLifecycle(t.to)
    ? ` (${t.from.join('/')} → ${t.to})`
    : '';
}

/** The one-line description: the canonical summary, with its transition arrow and seed note. */
export function describeVerb(verb: UniformVerb): string {
  const op = fact(verb);
  const seeds = op.seeds === true ? ' Also takes a seed (KEY-sN).' : '';
  return `${capitalized(op.summary)}${arrowOf(op)}.${seeds}`;
}

/** The description an agent reads: the summary with its reason, choice, echo, and seed clauses. */
export function describeVerbForAgent(verb: UniformVerb): string {
  const op = fact(verb);
  const reason = {
    none: '',
    optional: ' Optionally records a reason on the transition.',
    required: ' Requires a reason recorded on the transition.',
  }[op.reason];
  const required =
    (op.requiredFields?.length ?? 0) > 0 ? ` Requires ${op.requiredFields?.join(', ')}.` : '';
  const choice =
    op.choice === undefined
      ? ''
      : ` Optional ${op.choice.name} (${op.choice.values.join('|')}): ${op.choice.summary}.`;
  const echo = op.subject === 'project' ? 'Echoes the project.' : 'Echoes the updated node.';
  const seeds =
    op.seeds === true
      ? ' A seed id (KEY-sN) is accepted too: it moves the seed between untriaged and parked and echoes the seed.'
      : '';
  const ownership =
    verb === 'start'
      ? ' Preserves the main conversation. Explicit worker-session assigns a distinct whole-task owner; worker-harness is optional and is never inferred from the shell.'
      : '';
  return `${capitalized(op.summary)}${arrowOf(op)}.${reason}${required}${choice} ${echo}${seeds}${ownership}`;
}

/** The worked examples: the one part of a verb's help the facts do not carry. */
const EXAMPLES: Record<UniformVerb, { command: string; note: string }[]> = {
  abandon: [{ command: 'abandon MMR-3 "superseded by MMR-9"', note: 'kept, not deleted' }],
  archive: [
    { command: 'archive SAGA "superseded by SAGA2"', note: 'freeze and hide the project' },
    { command: 'projects --status archived', note: 'the archived projects' },
  ],
  block: [
    { command: 'block MMR-3 --on you "need a decision from me"', note: 'only you can clear it' },
    { command: 'block MMR-3 --on others "upstream API down"', note: 'someone else clears it' },
    { command: 'block MMR-3 "upstream API down"', note: 'others if it has an upstream, else you' },
  ],
  done: [{ command: 'done MMR-3', note: 'complete it, approving a review' }],
  park: [
    { command: 'park MMR-3 "waiting on design"', note: 'put it on hold' },
    { command: 'park MMR-s4 "after v1"', note: 'a seed: kept, no longer untriaged' },
  ],
  queue: [
    {
      command: 'queue MMR-3 --harness codex --session run-91',
      note: 'reserve it for a run, recording the run handles',
    },
  ],
  reopen: [{ command: 'reopen MMR-3', note: 'back to in_progress' }],
  return: [{ command: 'return MMR-3 "needs tests"', note: 'send it back with a reason' }],
  start: [
    { command: 'start MMR-3', note: 'begin the task' },
    {
      command: 'start MMR-3 --host laptop --harness codex --session s-91 --branch feat/mmr-3',
      note: 'work in the main conversation',
    },
    {
      command: 'start MMR-3 --worker-session worker-92 --worker-harness claude',
      note: 'hand the whole task to a distinct worker',
    },
    {
      command: 'update MMR-3 --worker-session worker-93',
      note: 'worker takeover; omitted harness becomes unknown',
    },
  ],
  submit: [{ command: 'submit MMR-3', note: 'send it for review' }],
  unarchive: [{ command: 'unarchive SAGA', note: 'restore the project' }],
  unblock: [{ command: 'unblock MMR-3', note: 'clear the hold' }],
  unpark: [
    { command: 'unpark MMR-3', note: 'clear the hold' },
    { command: 'unpark MMR-s4', note: 'a seed: back to untriaged' },
  ],
  unqueue: [{ command: 'unqueue MMR-3 "run cancelled"', note: 'release the reservation' }],
};

/** The past-participle word of a verb's signpost; `done` and `submit` are the two irregulars. */
const PAST_PARTICIPLE_OVERRIDES: Partial<Record<UniformVerb, string>> = {
  done: 'completed',
  submit: 'submitted',
};
function pastParticiple(verb: UniformVerb): string {
  return PAST_PARTICIPLE_OVERRIDES[verb] ?? (verb.endsWith('e') ? `${verb}d` : `${verb}ed`);
}

/**
 * The transition a lifecycle move to a live state names: its source when the
 * fact has one or the task's actual `source` is known, else the target alone.
 */
function transitionSuffix(op: OpFact, presentation: Presentation, source?: string): string {
  const t = op.transition;
  if (t.axis !== 'lifecycle' || isTerminalLifecycle(t.to)) {
    return '';
  }
  const glyph = arrow(presentation.plain);
  const from = t.from.length === 1 ? t.from[0] : source;
  return from === undefined ? ` ${glyph} ${t.to}` : ` · ${from} ${glyph} ${t.to}`;
}

const withReason = (line: string, reason: string | undefined): string =>
  reason === undefined ? line : `${line} · ${reason}`;

/** What one invocation reads off its words, before the Engine is asked. */
type Invocation = {
  verb: UniformVerb;
  /** The subject id, or the project key. */
  id: string;
  /** The reason words, joined; empty for none. */
  reason: string;
  handles?: Readonly<Partial<Record<HandleFieldArg, string>>>;
  startExpectation?: UniformArgs['startExpectation'];
  on?: string;
  presentation: Presentation;
};

/** The Engine arguments an invocation carries, keyed as the verb's fact declares them. */
function engineArgs(call: Invocation): UniformArgs {
  const op = fact(call.verb);
  const args: UniformArgs = { id: call.id };
  if (op.reason !== 'none' && call.reason !== '') {
    args.reason = call.reason;
  }
  for (const key of HANDLE_FIELD_KEYS) {
    const arg = HANDLE_FIELD_ARGS[key];
    const value = call.handles?.[arg];
    if (op.fields?.includes(key) === true && value !== undefined) {
      args[arg] = value;
    }
  }
  if (call.startExpectation !== undefined) {
    args.startExpectation = call.startExpectation;
  }
  if (op.choice !== undefined && call.on !== undefined) {
    args.on = call.on;
  }
  return args;
}

/**
 * Refuse a subject that cannot be the verb's, in the words the old CLI used. The
 * Engine takes canonical ids, so what the token names is decided here by its
 * grammar: a project key on a task verb, a seed on a verb that takes none, an
 * artifact anywhere, and anything not shaped like a project key on a project verb.
 */
function refuseWrongSubject(ports: Ports, op: OpFact, id: string): void {
  const kind = ports.grammar.idKind(id);
  if (op.subject === 'project') {
    if (kind !== 'project') {
      throw projectNotFound(id);
    }
    return;
  }
  if (op.seeds === true && kind === 'seed') {
    return;
  }
  nodeToken(ports.grammar, id, 'task');
}

/** The seed verbs `park` and `unpark` reach the Engine through their own methods. */
function callSeed(engine: Engine, verb: UniformVerb, args: UniformArgs): Promise<unknown> {
  if (verb === 'unpark') {
    return engine.seedUnpark({ id: args.id });
  }
  return engine.seedPark({
    id: args.id,
    ...(args.reason === undefined ? {} : { reason: args.reason }),
  });
}

/**
 * Call the Engine method of a task or project verb. `engine[verb]` is a union of
 * methods, so its argument must satisfy every verb's input at once; the two verbs
 * whose facts require a field (queue's session, unqueue's reason) are called on
 * their own, with the value `runVerb` has already checked is present.
 */
function callUniform(engine: Engine, verb: UniformVerb, args: UniformArgs): Promise<unknown> {
  if (verb === 'queue') {
    return engine.queue({ ...args, session: args.session ?? '' });
  }
  if (verb === 'unqueue') {
    return engine.unqueue({ ...args, reason: args.reason ?? '' });
  }
  return engine[verb](args);
}

/** Run one verb and shape what the Engine echoed. Only the Engine reads or writes work state. */
async function runVerb(ports: Ports, call: Invocation): Promise<LifecycleEcho> {
  const op = fact(call.verb);
  if (call.id.trim() === '') {
    throw new MimirUsageError(
      `${call.verb} requires ${op.subject === 'project' ? 'a project KEY' : 'an id (KEY-seq)'}`,
    );
  }
  if (op.reason === 'required' && call.reason.trim() === '') {
    throw new MimirUsageError(`${call.verb} requires a reason`);
  }
  for (const key of HANDLE_FIELD_KEYS) {
    if (
      op.requiredFields?.includes(key) === true &&
      (call.handles?.[HANDLE_FIELD_ARGS[key]] ?? '').trim() === ''
    ) {
      throw new MimirError('validation', `${call.verb} requires a nonblank ${key}`);
    }
  }
  refuseWrongSubject(ports, op, call.id);
  const engine = await ports.engine();
  const forSeed = op.seeds === true && ports.grammar.idKind(call.id) === 'seed';
  const args = engineArgs(call);
  const source = call.startExpectation?.lifecycle ?? undefined;
  const run = (): Promise<unknown> =>
    forSeed ? callSeed(engine, call.verb, args) : callUniform(engine, call.verb, args);
  let raw: unknown;
  if (forSeed) {
    raw = await run();
  } else if (op.subject === 'project') {
    raw = await withProjectHint(call.id, run);
  } else {
    raw = await withListHint([call.id], run);
  }
  const { presentation } = call;
  const reason = call.reason === '' || op.reason === 'none' ? undefined : call.reason;
  const word = pastParticiple(call.verb);
  if (forSeed) {
    const seed = intentEncoders.seed.parse(raw);
    return seedEcho(ports, seed, withReason(`${word} ${seed.id}`, reason), presentation);
  }
  if (op.subject === 'project') {
    const node = intentEncoders.node.parse(raw);
    // Only archive echoes what it freed; the other project verbs release nothing.
    const released = call.verb === 'archive' ? intentEncoders.archive.parse(raw).released : [];
    const archivedAt = ports.wire.node(node).archived_at;
    return {
      archivedAt: typeof archivedAt === 'string' ? archivedAt : null,
      key: node.id,
      presentation,
      released,
      signpost: withReason(`${word} ${node.id}`, reason),
    };
  }
  return nodeEcho(ports, raw, presentation, (id) =>
    withReason(`${word} ${id}${transitionSuffix(op, presentation, source)}`, reason),
  );
}

/** The `.command()` pieces every verb shares: its description, help, and MCP opt-in. */
function header(verb: UniformVerb) {
  return {
    description: describeVerb(verb),
    extensions: [
      helpCommand({ examples: EXAMPLES[verb] }),
      mcpCommand({
        annotations: { ...writeHints, idempotent: false },
        description: describeVerbForAgent(verb),
      }),
    ],
  };
}

/** A verb without a reason takes no words after `--` either; Loom hands them over, so refuse them rather than drop them. */
function refuseStray(passthrough: readonly string[]): void {
  if (passthrough.length > 0) {
    throw new MimirUsageError(`unexpected argument: ${passthrough.join(' ')}`);
  }
}

const SUBJECT_DESCRIPTIONS = {
  project: 'The project key (bare KEY).',
  task: 'The task: KEY-seq.',
  taskOrSeed: 'The task (KEY-seq) or the seed (KEY-sN).',
} as const;

/** The reason argument; its help says whether the verb's fact requires the reason. */
const reasonArgumentFor = (verb: UniformVerb) =>
  ({
    description: `The reason is ${fact(verb).reason === 'required' ? 'required' : 'optional'}; it is recorded in the transition log.`,
    variadic: true,
  }) as const;

/** The subject's description: a seed too where the fact accepts one. */
const subjectOf = (op: OpFact): string =>
  op.seeds === true ? SUBJECT_DESCRIPTIONS.taskOrSeed : SUBJECT_DESCRIPTIONS.task;

/** A task verb that takes no reason: submit, done, unblock, unpark. */
function plainTask(verb: UniformVerb, ports: Ports) {
  return new Command(verb, header(verb))
    .argument('id', { description: subjectOf(fact(verb)), required: true })
    .option('ascii', asciiOption)
    .result<LifecycleEcho>({ views: echoViews })
    .views({ records: echoViews.records }, { default: 'records' })
    .action(async ({ args, host, options, out, passthrough }) => {
      refuseStray(passthrough);
      const presentation = presentationOf(host, options.ascii);
      await out.results(await runVerb(ports, { id: args.id, presentation, reason: '', verb }));
    });
}

/** A verb that takes a task or a seed and a reason, optional or required by its fact. */
function reasonedTask(verb: UniformVerb, ports: Ports) {
  const run = (id: string, reason: string, ascii: boolean, host: PresentationHost) =>
    runVerb(ports, { id, presentation: presentationOf(host, ascii), reason, verb });
  return new Command(verb, header(verb))
    .argument('id', { description: subjectOf(fact(verb)), required: true })
    .argument('reason', reasonArgumentFor(verb))
    .option('ascii', asciiOption)
    .result<LifecycleEcho>({ views: echoViews })
    .views({ records: echoViews.records }, { default: 'records' })
    .action(async ({ args, host, options, out, passthrough }) => {
      await out.results(
        await run(args.id, reasonWords(args.reason, passthrough), options.ascii, host),
      );
    });
}

/** A project verb: `archive` takes a reason, `unarchive` takes none. */
function projectVerb(verb: UniformVerb, ports: Ports) {
  const base = new Command(verb, header(verb)).argument('key', {
    description: SUBJECT_DESCRIPTIONS.project,
    required: true,
  });
  const run = (key: string, reason: string, ascii: boolean, host: PresentationHost) =>
    runVerb(ports, { id: key, presentation: presentationOf(host, ascii), reason, verb });
  if (fact(verb).reason === 'none') {
    return base
      .option('ascii', asciiOption)
      .result<LifecycleEcho>({ views: echoViews })
      .views({ records: echoViews.records }, { default: 'records' })
      .action(async ({ args, host, options, out, passthrough }) => {
        refuseStray(passthrough);
        await out.results(await run(args.key, '', options.ascii, host));
      });
  }
  return base
    .argument('reason', reasonArgumentFor(verb))
    .option('ascii', asciiOption)
    .result<LifecycleEcho>({ views: echoViews })
    .views({ records: echoViews.records }, { default: 'records' })
    .action(async ({ args, host, options, out, passthrough }) => {
      await out.results(
        await run(args.key, reasonWords(args.reason, passthrough), options.ascii, host),
      );
    });
}

/** What a handle flag says in help; a required one names the fallback that can fill it. */
const handleDescription = (verb: UniformVerb, key: HandleFieldKey, summary: string): string =>
  fact(verb).requiredFields?.includes(key) === true
    ? `${summary} Required, after the shell environment fills it.`
    : summary;

/**
 * Fill a new main identity from one unambiguous shell. An established main
 * or explicit worker input suppresses fallback; worker identity stays explicit.
 */
async function runHandles(
  options: Readonly<Partial<Record<HandleFieldArg, string>>>,
  verb: 'queue' | 'start',
  starting: UniformArgs['startExpectation'],
  env: Readonly<Record<string, string | undefined>>,
  warn: (message: string) => Promise<void>,
): Promise<Partial<Record<HandleFieldArg, string>>> {
  const handles = { ...options };
  if (
    (verb === 'start' &&
      (starting?.harness != null ||
        starting?.session != null ||
        handles.workerHarness !== undefined ||
        handles.workerSession !== undefined)) ||
    (handles.harness !== undefined && handles.session !== undefined)
  ) {
    return handles;
  }
  const filled = fillFromShell(handles, env);
  if (filled.kind === 'conflict') {
    await warn(
      `detected multiple harnesses (${filled.harnesses.join(', ')}); pass --harness and --session explicitly`,
    );
    return handles;
  }
  const { harness, session } = filled;
  return {
    ...handles,
    ...(harness == null ? {} : { harness }),
    ...(session == null ? {} : { session }),
  };
}

/** `queue` and `start` record the resume handles as the reservation or the claim (ADR 0026). */
function handleVerb(verb: 'queue' | 'start', ports: Ports) {
  const describe = (key: HandleFieldKey, summary: string) =>
    text(handleDescription(verb, key, summary));
  const base = new Command(verb, header(verb))
    .argument('id', { description: SUBJECT_DESCRIPTIONS.task, required: true })
    .option('host', describe('host', 'The machine the work is happening on.'))
    .option('harness', describe('harness', 'The main conversation or workflow harness.'))
    .option('session', describe('session', 'The main conversation or workflow session.'))
    .option('branch', describe('branch', 'The branch the work lives on.'));
  const command =
    verb === 'start'
      ? base
          .option('worker-harness', text('The distinct whole-task worker harness, when known.'))
          .option(
            'worker-session',
            text('The distinct whole-task worker session; requires a main session.'),
          )
      : base;
  return command
    .option('ascii', asciiOption)
    .result<LifecycleEcho>({ views: echoViews })
    .views({ records: echoViews.records }, { default: 'records' })
    .action(async ({ args, host, options, out, passthrough }) => {
      refuseStray(passthrough);
      if (args.id.trim() === '') {
        throw new MimirUsageError(`${verb} requires an id (KEY-seq)`);
      }
      const presentation = presentationOf(host, options.ascii);
      const observed =
        verb === 'start'
          ? await withListHint([args.id], async () =>
              (await ports.engine()).getNode({ id: nodeToken(ports.grammar, args.id, 'task') }),
            )
          : undefined;
      const startExpectation =
        observed === undefined
          ? undefined
          : {
              harness: observed.harness ?? null,
              lifecycle: observed.lifecycle ?? null,
              session: observed.session ?? null,
            };
      const handles = await runHandles(
        {
          branch: options.branch,
          harness: options.harness,
          host: options.host,
          session: options.session,
          workerHarness:
            'worker-harness' in options && typeof options['worker-harness'] === 'string'
              ? options['worker-harness']
              : undefined,
          workerSession:
            'worker-session' in options && typeof options['worker-session'] === 'string'
              ? options['worker-session']
              : undefined,
        },
        verb,
        startExpectation,
        host.env,
        (message) => out.warn(message),
      );
      await out.results(
        await runVerb(ports, {
          handles,
          id: args.id,
          presentation,
          reason: '',
          startExpectation,
          verb,
        }),
      );
    });
}

/** `block` takes the owner choice `--on` beside its reason. */
function blockCommand(ports: Ports) {
  const choice = OP_FACTS.block.choice;
  return new Command('block', header('block'))
    .argument('id', { description: SUBJECT_DESCRIPTIONS.task, required: true })
    .argument('reason', reasonArgumentFor('block'))
    .option(choice.name, text(`${capitalized(choice.summary)}.`, choice.values.join('|')))
    .option('ascii', asciiOption)
    .result<LifecycleEcho>({ views: echoViews })
    .views({ records: echoViews.records }, { default: 'records' })
    .action(async ({ args, host, options, out, passthrough }) => {
      const presentation = presentationOf(host, options.ascii);
      await out.results(
        await runVerb(ports, {
          id: args.id,
          on: options.on,
          presentation,
          reason: reasonWords(args.reason, passthrough),
          verb: 'block',
        }),
      );
    });
}

export const queueVerb = (ports: Ports) => handleVerb('queue', ports);
export const unqueueVerb = (ports: Ports) => reasonedTask('unqueue', ports);
export const startVerb = (ports: Ports) => handleVerb('start', ports);
export const blockVerb = blockCommand;
export const submitVerb = (ports: Ports) => plainTask('submit', ports);
export const returnVerb = (ports: Ports) => reasonedTask('return', ports);
export const doneVerb = (ports: Ports) => plainTask('done', ports);
export const abandonVerb = (ports: Ports) => reasonedTask('abandon', ports);
export const reopenVerb = (ports: Ports) => reasonedTask('reopen', ports);
export const parkVerb = (ports: Ports) => reasonedTask('park', ports);
export const unparkVerb = (ports: Ports) => plainTask('unpark', ports);
export const unblockVerb = (ports: Ports) => plainTask('unblock', ports);
export const archiveVerb = (ports: Ports) => projectVerb('archive', ports);
export const unarchiveVerb = (ports: Ports) => projectVerb('unarchive', ports);

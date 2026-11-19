/**
 * The fifteen uniform verbs (ADR 0025): queue, unqueue, start, submit, stage, return,
 * done, abandon, reopen, park, unpark, block, unblock, archive, and unarchive. Each command's
 * description, arguments, and options derive from its operation fact in
 * `OP_FACTS`; only the worked examples are hand-authored. A verb calls the
 * Engine's derived method of the same name and echoes the record it left.
 */
import { Command } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';
import {
  DELIVERY_OP_FACTS,
  encodeDelivery,
  HANDLE_FIELD_ARGS,
  HANDLE_FIELD_KEYS,
  intentEncoders,
  isDeliveryVerb,
  isTerminalLifecycle,
  MimirError,
  OP_FACTS,
  projectNotFound,
} from '@mimir/contract';
import type {
  DeliveryVerb,
  Engine,
  HandleFieldArg,
  HandleFieldKey,
  OpFact,
  UniformArgs,
  UniformVerb,
} from '@mimir/contract';
import { fillFromShell, t3HostFromShell } from '@mimir/helpers';

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

/** The move a delivery verb makes, from its fact: `agreed → running`, `hold none → stopped`. */
function deliveryMove(verb: DeliveryVerb): string {
  const op = DELIVERY_OP_FACTS[verb];
  return `${op.axis === 'hold' ? 'hold ' : ''}${op.from.join('/')} → ${op.to}`;
}

/** The task inputs a delivery verb refuses (ADR 0042), in the CLI's words and the agent's. */
const DELIVERY_REFUSALS: Partial<Record<DeliveryVerb, { cli: string; agent: string }>> = {
  block: { agent: ' It refuses on.', cli: '; --on is refused' },
  start: {
    agent: ' It refuses every handle field and never fills identity from the shell.',
    cli: '; task handle flags are refused',
  },
};

/** The one-line description: the canonical summary, with its transition arrow, seed, and delivery notes. */
export function describeVerb(verb: UniformVerb): string {
  const op = fact(verb);
  const seeds = op.seeds === true ? ' Also takes a seed (KEY-sN).' : '';
  let delivery = '';
  if (isDeliveryVerb(verb)) {
    const reason = {
      none: '',
      optional: ', with an optional reason',
      required: ', with a required reason',
    }[DELIVERY_OP_FACTS[verb].reason];
    const refused = DELIVERY_REFUSALS[verb]?.cli ?? '';
    delivery = ` Also takes a delivery (KEY-dN): ${deliveryMove(verb)}${reason}${refused}.`;
  }
  return `${capitalized(op.summary)}${arrowOf(op)}.${seeds}${delivery}`;
}

/** What a delivery verb's `KEY-dN` does, for an agent: its move, reason, echo, and refusals. */
function deliveryClauseForAgent(verb: DeliveryVerb): string {
  const reason = {
    none: '',
    optional: ', optionally recording a reason in the delivery history',
    required: ', requiring a reason recorded in the delivery history',
  }[DELIVERY_OP_FACTS[verb].reason];
  return ` A delivery id (KEY-dN) is accepted too: it moves the delivery ${deliveryMove(verb)}${reason}, keeps the delivery's handles, and echoes the whole delivery.${DELIVERY_REFUSALS[verb]?.agent ?? ''}`;
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
  const delivery = isDeliveryVerb(verb) ? deliveryClauseForAgent(verb) : '';
  const ownership =
    verb === 'start'
      ? ' Preserves the main conversation. Explicit worker-session assigns a distinct whole-task owner; worker-harness is optional and is never inferred from the shell.'
      : '';
  return `${capitalized(op.summary)}${arrowOf(op)}.${reason}${required}${choice} ${echo}${seeds}${ownership}${delivery}`;
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
  stage: [
    { command: 'stage MMR-3', note: 'review passed; accepted on its branch, not yet on main' },
  ],
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
 * Refuse a choice value outside the verb's declared vocabulary as a usage error,
 * before the store opens, as every other enum flag is. The words match the
 * Engine's own refusal (`parseOpChoice`), which still guards the other transports.
 */
function refuseUnknownChoice(verb: UniformVerb, op: OpFact, value: string | undefined): void {
  const { choice } = op;
  if (choice === undefined || value === undefined || choice.values.includes(value)) {
    return;
  }
  throw new MimirUsageError(
    `invalid ${choice.name}: ${value}`,
    `${verb} ${choice.name} takes one of: ${choice.values.join(', ')}`,
  );
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

/** The delivery verb that does a task-only verb's job on a delivery, where one exists. */
const DELIVERY_COUNTERPART: Partial<Record<UniformVerb, DeliveryVerb>> = { done: 'land' };

/** Where each delivery verb sits in its lifecycle; a Record, so a new verb must be placed. */
const DELIVERY_VERB_PLACE: Record<DeliveryVerb, number> = {
  abandon: 8,
  block: 1,
  land: 7,
  park: 3,
  return: 6,
  start: 0,
  submit: 5,
  unblock: 2,
  unpark: 4,
};

/** The verbs a delivery takes, in the order its lifecycle reaches them. */
const DELIVERY_VERBS = Object.keys(DELIVERY_VERB_PLACE)
  .filter(isDeliveryVerb)
  .toSorted((a, b) => DELIVERY_VERB_PLACE[a] - DELIVERY_VERB_PLACE[b]);

/**
 * Refuse a delivery id on a verb that cannot act on one, before any input of
 * the verb's own is checked: naming the delivery verb that does the job, or
 * the verbs a delivery takes.
 */
function refuseDeliverySubject(verb: UniformVerb, id: string): never {
  const counterpart = DELIVERY_COUNTERPART[verb];
  const last = DELIVERY_VERBS.at(-1) ?? '';
  throw new MimirError(
    'validation',
    `${verb} does not apply to a delivery: ${id} is a delivery`,
    counterpart === undefined
      ? `a delivery takes ${DELIVERY_VERBS.slice(0, -1).join(', ')}, and ${last}`
      : `use ${counterpart} ${id}`,
  );
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
  if (ports.grammar.idKind(call.id) === 'delivery' && isDeliveryVerb(call.verb)) {
    if (
      call.on !== undefined ||
      Object.values(call.handles ?? {}).some((value) => value !== undefined)
    ) {
      throw new MimirError(
        'validation',
        `delivery ${call.verb} refuses task handle flags and --on`,
        'use update to set delivery handles; omit --on',
      );
    }
    const engine = await ports.engine();
    const opDelivery = DELIVERY_OP_FACTS[call.verb];
    let result;
    if (opDelivery.reason === 'required') {
      result = await engine[opDelivery.method]({ id: call.id, reason: call.reason });
    } else if (opDelivery.reason === 'optional') {
      result = await engine[opDelivery.method]({ id: call.id, reason: call.reason || undefined });
    } else {
      result = await engine[opDelivery.method]({ id: call.id });
    }
    return { delivery: encodeDelivery(result), presentation: call.presentation };
  }
  if (ports.grammar.idKind(call.id) === 'decision') {
    throw new MimirError(
      'validation',
      `${call.id} is a decision`,
      'use get, update, confirm, or overturn; decide records a new decision',
    );
  }
  if (ports.grammar.idKind(call.id) === 'delivery') {
    refuseDeliverySubject(call.verb, call.id);
  }
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
  refuseUnknownChoice(call.verb, op, call.on);
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
  taskOrDelivery: 'The task (KEY-seq) or the delivery (KEY-dN).',
  taskOrSeed: 'The task (KEY-seq) or the seed (KEY-sN).',
  taskSeedOrDelivery: 'The task (KEY-seq), the seed (KEY-sN), or the delivery (KEY-dN).',
} as const;

/**
 * The reason argument; its help says, for each subject the verb takes, whether
 * the reason is required and where it is recorded.
 */
function reasonArgumentFor(verb: UniformVerb) {
  const op = fact(verb);
  const required = op.reason === 'required' ? 'required' : 'optional';
  let description = `The reason is ${required}; it is recorded in the transition log.`;
  if (isDeliveryVerb(verb)) {
    const subjects = op.seeds === true ? 'a task or a seed' : 'a task';
    description = `For ${subjects} the reason is ${required} and recorded in the transition log; for a delivery it is ${DELIVERY_OP_FACTS[verb].reason} and recorded in the delivery history.`;
  }
  return { description, variadic: true } as const;
}

/** The subject's description: a seed or a delivery too where the verb accepts one. */
function subjectOf(verb: UniformVerb): string {
  const seeds = fact(verb).seeds === true;
  if (isDeliveryVerb(verb)) {
    return seeds ? SUBJECT_DESCRIPTIONS.taskSeedOrDelivery : SUBJECT_DESCRIPTIONS.taskOrDelivery;
  }
  return seeds ? SUBJECT_DESCRIPTIONS.taskOrSeed : SUBJECT_DESCRIPTIONS.task;
}

/** A task verb that takes no reason: submit, stage, done, unblock, unpark. */
function plainTask(verb: UniformVerb, ports: Ports) {
  return new Command(verb, header(verb))
    .argument('id', { description: subjectOf(verb), required: true })
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
    .argument('id', { description: subjectOf(verb), required: true })
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

type Handles = Partial<Record<HandleFieldArg, string>>;

/**
 * Fill a new main identity from one unambiguous shell, then the host of a T3
 * thread from its environment. An established main or explicit worker input
 * suppresses both; worker identity stays explicit.
 */
async function runHandles(
  options: Readonly<Handles>,
  verb: 'queue' | 'start',
  starting: UniformArgs['startExpectation'],
  env: Readonly<Record<string, string | undefined>>,
  warn: (message: string) => Promise<void>,
): Promise<Handles> {
  const handles = { ...options };
  if (
    verb === 'start' &&
    (starting?.harness != null ||
      starting?.session != null ||
      handles.workerHarness !== undefined ||
      handles.workerSession !== undefined)
  ) {
    return handles;
  }
  const identity =
    handles.harness !== undefined && handles.session !== undefined
      ? handles
      : await fillIdentity(handles, env, warn);
  const host = t3HostFromShell(identity, env);
  return host == null ? identity : { ...identity, host };
}

/** Fill an omitted main harness or session from the shell, or explain a conflict. */
async function fillIdentity(
  handles: Readonly<Handles>,
  env: Readonly<Record<string, string | undefined>>,
  warn: (message: string) => Promise<void>,
): Promise<Handles> {
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
    .argument('id', { description: subjectOf(verb), required: true })
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
        verb === 'start' && ports.grammar.idKind(args.id) !== 'delivery'
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
      const handles = await (
        ports.grammar.idKind(args.id) === 'delivery'
          ? async (explicit: Handles) => explicit
          : runHandles
      )(
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
    .argument('id', { description: subjectOf('block'), required: true })
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
export const stageVerb = (ports: Ports) => plainTask('stage', ports);
export const returnVerb = (ports: Ports) => reasonedTask('return', ports);
export const doneVerb = (ports: Ports) => plainTask('done', ports);
export const abandonVerb = (ports: Ports) => reasonedTask('abandon', ports);
export const reopenVerb = (ports: Ports) => reasonedTask('reopen', ports);
export const parkVerb = (ports: Ports) => reasonedTask('park', ports);
export const unparkVerb = (ports: Ports) => plainTask('unpark', ports);
export const unblockVerb = (ports: Ports) => plainTask('unblock', ports);
export const archiveVerb = (ports: Ports) => projectVerb('archive', ports);
export const unarchiveVerb = (ports: Ports) => projectVerb('unarchive', ports);

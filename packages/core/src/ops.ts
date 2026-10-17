import { BLOCK_OWNER_VALUES, OP_FACTS, UNIFORM_VERBS } from '@mimir/contract';
import type { BlockOwner, OpFact, SeedView, UniformVerb } from '@mimir/contract';
import { isMember } from '@mimir/helpers';

import { invariant, validation } from './errors';
import { parseSeedRef } from './ids';
import type { Node, Project } from './model';
import {
  abandonTask,
  archiveProject,
  blockTask,
  completeTask,
  parkTask,
  reopenTask,
  returnTask,
  startTask,
  submitTask,
  unarchiveProject,
  unblockTask,
  unparkTask,
} from './mutations';
import type { HandleFields } from './mutations/handles';
import { parkSeed, unparkSeed } from './seeds/intent';
import type { Store } from './store';

/**
 * The operation registry (ADR 0025 Decision 3) — the code bindings that compose
 * with the pure operation facts in `@mimir/contract` ({@link OP_FACTS},
 * re-exported here as {@link OPS}) to form the registry every uniform-verb
 * surface derives from: the CLI's one generic dispatch arm + echo (`cli/run.ts`,
 * `cli/mutations.ts`), the CLI help (terse rows + per-verb descriptors,
 * `cli/help.ts`), the MCP tool registrations (`mcp/server.ts`), and the HTTP
 * action routes (`api/src/api.ts`). Each verb binds a `run` that delegates to the
 * existing core mutation fn; the transition guards stay imperative in those
 * mutations (the registry's `transition` is a descriptive dispatch/render fact,
 * not a state machine). Facts live in the contract so any consumer (including the
 * UI) can read them; this module holds only the `run` bindings and the derived
 * views. The verb analogue of `core/field-spec.ts`.
 *
 * The twenty-nine non-uniform verbs stay bespoke and never route through here
 * (ADR 0025 Decision 3).
 */

/** The value a uniform verb's `run` yields — a work node (task) or a project row,
 * per the verb's {@link OpFact.subject}. The transport echoes the matching shape. */
export type OpResult = Node | Project;

/**
 * One uniform verb's spec — the pure facts ({@link OpFact}) plus the `run`
 * binding. `run` receives the already-resolved canonical id (a node stem for a
 * `task` subject, a project id for a `project` subject — each transport does its
 * own subject-kind resolution), the optional reason, and the extra data-plane
 * fields the verb's {@link OpFact.fields} declares (only `start`'s resume
 * handles), the verb's already-validated {@link OpFact.choice} value (only
 * `block --on`), and delegates to the core mutation fn. A binding drops the arguments
 * its verb doesn't take (e.g. `unarchiveProject` has no reason slot at all —
 * absorbed here), so the widened signature costs the other eleven nothing.
 */
export type OpSpec = OpFact & {
  run: (
    store: Store,
    id: string,
    reason?: string,
    fields?: HandleFields,
    choice?: string,
  ) => Promise<OpResult>;
};

/**
 * Validate a raw choice-argument token against its verb's declared vocabulary —
 * the one parse every transport shares (CLI `--on`, HTTP body `on`; MCP checks
 * the same list through its zod enum), so the accepted values and the error
 * wording can't drift. `undefined` passes through (the mutation applies its
 * default). Reaching it for a verb with no choice is a transport wiring bug.
 */
export function parseOpChoice(
  verb: string,
  fact: OpFact,
  raw: string | undefined,
): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const { choice } = fact;
  if (choice === undefined) {
    throw invariant(
      `${verb} declares no choice argument`,
      'a transport may only read a choice the operation fact declares',
    );
  }
  if (!choice.values.includes(raw)) {
    throw validation(
      `invalid ${choice.name}: ${raw}`,
      `${verb} ${choice.name} takes one of: ${choice.values.join(', ')}`,
    );
  }
  return raw;
}

/** Narrow `block`'s validated choice token to the owner enum. The transports
 * validate before dispatch, so a miss here is a wiring bug, not a value fault. */
function blockOwnerOf(choice: string | undefined): BlockOwner | undefined {
  if (choice === undefined) {
    return undefined;
  }
  if (!isMember(choice, BLOCK_OWNER_VALUES)) {
    throw invariant(`block owner ${choice} was not validated`, 'run it through parseOpChoice');
  }
  return choice;
}

/** The per-verb `run` bindings — the one place code pairs with a fact. Keyed by
 * the full {@link UniformVerb} union, so a new verb is a compile error here until
 * it names its mutation, never a silently unbound registry entry. */
const OP_RUN: Record<UniformVerb, OpSpec['run']> = {
  abandon: (store, id, reason) => abandonTask(store, id, reason),
  archive: (store, id, reason) => archiveProject(store, id, reason),
  block: (store, id, reason, _fields, choice) => blockTask(store, id, reason, blockOwnerOf(choice)),
  done: (store, id) => completeTask(store, id),
  park: (store, id, reason) => parkTask(store, id, reason),
  reopen: (store, id, reason) => reopenTask(store, id, reason),
  return: (store, id, reason) => returnTask(store, id, reason),
  start: (store, id, _reason, fields) => startTask(store, id, fields),
  submit: (store, id) => submitTask(store, id),
  unarchive: (store, id) => unarchiveProject(store, id),
  unblock: (store, id) => unblockTask(store, id),
  unpark: (store, id) => unparkTask(store, id),
};

/** A seed binding of a uniform verb (MMR-473): the seed id, the optional reason,
 * and the resolved seed view the transport echoes. */
export type SeedOpRun = (store: Store, id: string, reason?: string) => Promise<SeedView>;

/** The seed bindings for the verbs whose fact declares {@link OpFact.seeds}. */
const SEED_OP_RUN: Partial<Record<UniformVerb, SeedOpRun>> = {
  park: (store, id, reason) => parkSeed(store, id, reason),
  unpark: (store, id) => unparkSeed(store, id),
};

/**
 * The seed binding to run when `id` is a seed id and `verb` accepts seeds, or
 * `undefined` when the transport should dispatch its task or project subject as
 * usual. The one gate every uniform arm shares, so `mimir park KEY-sN` and the MCP
 * `park` tool can never disagree about which verbs take a seed.
 */
export function seedOpFor(verb: UniformVerb, id: string): SeedOpRun | undefined {
  const fact: OpFact = OP_FACTS[verb];
  if (fact.seeds !== true || parseSeedRef(id) === null) {
    return undefined;
  }
  const run = SEED_OP_RUN[verb];
  if (run === undefined) {
    throw invariant(`${verb} accepts seeds but binds no seed run`, 'add it to SEED_OP_RUN');
  }
  return run;
}

/**
 * The operation registry — the pure facts ({@link OP_FACTS} in `@mimir/contract`)
 * composed with the {@link OP_RUN} bindings under the core's name. Keyed by the
 * uniform verb; a transport iterates {@link UNIFORM_VERBS} for grouped rendering
 * or looks up by verb for dispatch.
 */
/**
 * Refuse a fact that declares extra data-plane fields on a PROJECT subject (ADR
 * 0026): such a verb's `run` returns a Project row, and the transports' project
 * arms — the CLI's `echoArchiveOp`, the MCP project branch, the HTTP project
 * route — have nowhere to route a field patch, so the fields would be advertised
 * and silently dropped. Refused when the registry is built, not at the first lost
 * write. (`specUpdateFields` separately refuses a key the generic `update` doesn't
 * own; together they are the whole legality of the extra-args fact.)
 */
export function assertOpFields(verb: string, fact: OpFact): void {
  if (fact.subject === 'project' && (fact.fields ?? []).length > 0) {
    throw invariant(
      `${verb} declares data-plane fields on a project subject`,
      'only a task-subject verb can record fields at its transition',
    );
  }
  // The same reasoning covers the choice argument: the project arms of all three
  // transports read neither fields nor a choice, so one declared there would be
  // advertised and silently dropped.
  if (fact.subject === 'project' && fact.choice !== undefined) {
    throw invariant(
      `${verb} declares a choice argument on a project subject`,
      'only a task-subject verb can take a choice argument',
    );
  }
}

const OP_ENTRIES: [UniformVerb, OpSpec][] = [];
for (const verb of UNIFORM_VERBS) {
  // Read through the declared fact type: `OP_FACTS`'s `as const` narrows each
  // entry to exactly the keys it happens to carry, which would make the guard
  // statically vacuous for today's table rather than a live check.
  const fact: OpFact = OP_FACTS[verb];
  assertOpFields(verb, fact);
  OP_ENTRIES.push([verb, { ...fact, run: OP_RUN[verb] }]);
}
// `Object.fromEntries` erases the key union to `string`; the entries are exactly
// the `UniformVerb` set (one per verb), so the narrow back is sound.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
export const OPS = Object.fromEntries(OP_ENTRIES) as Record<UniformVerb, OpSpec>;

/** The registry entries in canonical (grouped) order — the list the transport
 * loops (MCP registrations, HTTP routes) build from. */
const OP_SPEC_LIST: (OpSpec & { verb: UniformVerb })[] = [];
for (const verb of UNIFORM_VERBS) {
  OP_SPEC_LIST.push({ verb, ...OPS[verb] });
}
export const OP_SPECS: readonly (OpSpec & { verb: UniformVerb })[] = OP_SPEC_LIST;

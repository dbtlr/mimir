import { OP_FACTS, UNIFORM_VERBS } from '@mimir/contract';
import type { OpFact, UniformVerb } from '@mimir/contract';

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
import type { Store } from './store';

/**
 * The operation registry (ADR 0025 Decision 3) — the code bindings that compose
 * with the pure operation facts in `@mimir/contract` ({@link OP_FACTS},
 * re-exported here as {@link OPS}) to form the registry every uniform-verb
 * surface derives from: the CLI's one generic dispatch arm + echo (`cli/run.ts`,
 * `cli/mutations.ts`), the CLI help (terse rows + per-verb descriptors,
 * `cli/help.ts`), the MCP tool registrations (`mcp/server.ts`), and the HTTP
 * action routes (`http/server.ts`). Each verb binds a `run` that delegates to the
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
 * own subject-kind resolution) and the optional reason, and delegates to the core
 * mutation fn. A reason-less verb's binding drops the argument (e.g.
 * `unarchiveProject` takes no reason slot at all — absorbed here).
 */
export type OpSpec = OpFact & {
  run: (store: Store, id: string, reason?: string) => Promise<OpResult>;
};

/** The per-verb `run` bindings — the one place code pairs with a fact. Keyed by
 * the full {@link UniformVerb} union, so a new verb is a compile error here until
 * it names its mutation, never a silently unbound registry entry. */
const OP_RUN: Record<UniformVerb, OpSpec['run']> = {
  abandon: (store, id, reason) => abandonTask(store, id, reason),
  archive: (store, id, reason) => archiveProject(store, id, reason),
  block: (store, id, reason) => blockTask(store, id, reason),
  done: (store, id) => completeTask(store, id),
  park: (store, id, reason) => parkTask(store, id, reason),
  reopen: (store, id, reason) => reopenTask(store, id, reason),
  return: (store, id, reason) => returnTask(store, id, reason),
  start: (store, id) => startTask(store, id),
  submit: (store, id) => submitTask(store, id),
  unarchive: (store, id) => unarchiveProject(store, id),
  unblock: (store, id) => unblockTask(store, id),
  unpark: (store, id) => unparkTask(store, id),
};

/**
 * The operation registry — the pure facts ({@link OP_FACTS} in `@mimir/contract`)
 * composed with the {@link OP_RUN} bindings under the core's name. Keyed by the
 * uniform verb; a transport iterates {@link UNIFORM_VERBS} for grouped rendering
 * or looks up by verb for dispatch.
 */
const OP_ENTRIES: [UniformVerb, OpSpec][] = [];
for (const verb of UNIFORM_VERBS) {
  OP_ENTRIES.push([verb, { ...OP_FACTS[verb], run: OP_RUN[verb] }]);
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

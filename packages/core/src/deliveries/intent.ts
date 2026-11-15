import { DELIVERY_OP_FACTS } from '@mimir/contract';
import type { DeliveryVerb, DeliveryHistory, DeliveryView, EngineInput } from '@mimir/contract';

import { assertBoardActive } from '../archive-lock';
import { blankProse, notFound, projectNotFound, validation } from '../errors';
import { parseIdentity, renderDeliveryRef } from '../ids';
import type { Node, Project } from '../model';
import { logTransition } from '../mutations/common';
import { normalizeHandle, clearHandles } from '../mutations/handles';
import { completeTaskInTransaction } from '../mutations/lifecycle';
import { identityNoun } from '../project-only';
import { appendRank } from '../rank';
import type { NodePatch, Store } from '../store';
import { now } from '../time';
import type { DeliveryStatePatch, DeliveryCreate, DeliveryPatch, StoredDelivery } from './store';

/**
 * The delivery verbs (MMR-676, ADR 0042): the transport-agnostic rules above
 * the {@link DeliveryStore} seam, as the seed verbs sit above theirs. The
 * archive lock, the phase checks, blank text, and the id-kind refusals live
 * here; elapsed time is derived here on every read and never stored.
 */

type Ref = { key: string; seq: number };

/** The delivery an id names, or the refusal for one that names something else.
 * Another record's id is a behavioral kind error (ADR 0042), not a missing record. */
function requireDeliveryRef(id: string): Ref {
  const identity = parseIdentity(id);
  if (identity === null) {
    throw notFound(`${id} is not a delivery id`, 'delivery ids look like KEY-dN');
  }
  if (identity.kind !== 'delivery') {
    throw validation(
      `${id} is ${identityNoun(identity.kind)}, not a delivery`,
      'delivery ids look like KEY-dN',
    );
  }
  return { key: identity.key, seq: identity.seq };
}

/** Minutes since the first `start` (the first lifecycle row into `running`),
 * never below zero, or `null` before it (ADR 0042: derived, never stored). */
export function elapsedMinutes(history: readonly DeliveryHistory[], at: string): number | null {
  const started = history.find(
    (entry) => entry.kind === 'lifecycle' && entry.to_value === 'running',
  );
  if (started === undefined) {
    return null;
  }
  return Math.max(0, (Date.parse(at) - Date.parse(started.at)) / 60_000);
}

/** A stored delivery as every verb returns it. */
function viewOf(stored: StoredDelivery): DeliveryView {
  const { key, history, ...fields } = stored;
  return {
    id: renderDeliveryRef(stored),
    project_key: key,
    ...fields,
    elapsed_minutes: elapsedMinutes(history, now()),
    history,
  };
}

const activeProject = (projects: readonly Project[], key: string): Project | undefined =>
  projects.find((project) => project.key === key && project.archived_at === null);

/** The written terms a create or update carries, normalized and checked. */
type Terms = Omit<EngineInput<'deliveryUpdate'>, 'id'>;

/**
 * Check and normalize the terms of a write. A title is required text; blank
 * agreement text is refused, because `null` is its one clear (as `next` is);
 * a handle normalizes as a task's does, so blank text clears it.
 */
function patchOf(terms: Terms): DeliveryPatch {
  if (terms.title !== undefined && terms.title.trim() === '') {
    throw validation('a delivery requires a title');
  }
  if (typeof terms.agreement === 'string' && terms.agreement.trim() === '') {
    throw blankProse('agreement');
  }
  const patch: DeliveryPatch = {};
  for (const field of ['branch', 'harness', 'host', 'session'] as const) {
    const value = terms[field];
    if (value !== undefined) {
      patch[field] = normalizeHandle(value, field);
    }
  }
  if (terms.title !== undefined) {
    patch.title = terms.title;
  }
  if (terms.agreement !== undefined) {
    patch.agreement = terms.agreement;
  }
  if (terms.external_ref !== undefined) {
    patch.external_ref = terms.external_ref;
  }
  if (terms.time_cap_minutes !== undefined) {
    patch.time_cap_minutes = terms.time_cap_minutes;
  }
  return patch;
}

/** The phase a create names: it must be a phase on an active board. */
async function requirePhase(store: Store, id: string): Promise<{ key: string }> {
  const identity = parseIdentity(id);
  if (identity === null) {
    throw notFound(`${id} doesn't exist`);
  }
  if (identity.kind !== 'node') {
    throw validation(`${id} is ${identityNoun(identity.kind)}, not a phase`);
  }
  const projects = await store.loadProjects();
  assertBoardActive(
    projects.find((project) => project.key === identity.key),
    identity.key,
  );
  const nodes = await store.loadNodesForProjects(
    [identity.key],
    new Set(projects.map((project) => project.key)),
  );
  const phase = nodes.find((node) => node.id === id);
  if (phase === undefined) {
    throw notFound(`${id} doesn't exist`);
  }
  if (phase.type !== 'phase') {
    const noun = phase.type === 'initiative' ? 'an initiative' : `a ${phase.type}`;
    throw validation(`${id} is ${noun}, not a phase — a delivery delivers a phase`);
  }
  return { key: identity.key };
}

/** `create delivery` — a new attempt at a phase, in the phase's project. */
export async function createDelivery(
  store: Store,
  input: EngineInput<'deliveryCreate'>,
): Promise<DeliveryView> {
  const { phase, tasks, ...terms } = input;
  const patch = patchOf(terms);
  const { key } = await requirePhase(store, phase);
  const create: DeliveryCreate = {
    agreement: null,
    branch: null,
    external_ref: null,
    harness: null,
    host: null,
    session: null,
    time_cap_minutes: null,
    ...patch,
    key,
    phase,
    tasks,
    title: input.title,
  };
  return viewOf(await store.deliveries.create(create));
}

/** `get KEY-dN` — one delivery with its whole history. An archived board reads as absent. */
export async function getDelivery(store: Store, id: string): Promise<DeliveryView> {
  const ref = requireDeliveryRef(id);
  const projects = await store.loadProjects();
  const stored =
    activeProject(projects, ref.key) === undefined
      ? undefined
      : await store.deliveries.load(ref.key, ref.seq);
  if (stored === undefined) {
    throw notFound(`${id} doesn't exist`);
  }
  return viewOf(stored);
}

/** `deliveries` — a project's deliveries, oldest first. An unknown or archived
 * project is refused as `seeds` refuses it. */
export async function listDeliveries(store: Store, project: string): Promise<DeliveryView[]> {
  if (activeProject(await store.loadProjects(), project) === undefined) {
    throw projectNotFound(project);
  }
  return (await store.deliveries.listForProject(project)).map(viewOf);
}

/** `update KEY-dN` — replace the given terms of a live delivery. */
export async function updateDelivery(
  store: Store,
  input: EngineInput<'deliveryUpdate'>,
): Promise<DeliveryView> {
  const { id, ...terms } = input;
  const ref = requireDeliveryRef(id);
  const patch = patchOf(terms);
  assertBoardActive(
    (await store.loadProjects()).find((project) => project.key === ref.key),
    ref.key,
  );
  await store.deliveries.patch(ref.key, ref.seq, patch);
  const stored = await store.deliveries.load(ref.key, ref.seq);
  if (stored === undefined) {
    throw notFound(`${id} doesn't exist`);
  }
  return viewOf(stored);
}

/** Apply a delivery claim and its member effects in the write snapshot that guards them. */
export async function transitionDelivery(
  store: Store,
  verb: DeliveryVerb,
  input: { id: string; reason?: string },
): Promise<DeliveryView> {
  const { key, seq } = requireDeliveryRef(input.id);
  return viewOf(
    await store.deliveries.transact(key, seq, async (delivery, w) => {
      const { id, reason } = input;
      if (
        DELIVERY_OP_FACTS[verb].reason === 'required' &&
        (reason === undefined || reason.trim() === '')
      ) {
        throw validation(`${verb} requires a nonblank reason`, `${verb} ${id} "reason"`);
      }
      const patch: DeliveryStatePatch = {};
      const history: DeliveryHistory[] = [];
      const log = (kind: 'hold' | 'lifecycle', from: string, to: string) => {
        history.push({
          at: now(),
          from_value: from,
          kind,
          reason: reason ?? null,
          task: null,
          to_value: to,
        });
      };
      const clearHold = () => {
        patch.hold = 'none';
        patch.hold_reason = null;
        log('hold', delivery.hold, 'none');
      };
      const held = () => {
        if (delivery.hold !== 'none') {
          throw validation(
            `${id} is ${delivery.hold}`,
            `${delivery.hold === 'stopped' ? 'unblock' : 'unpark'} ${id} first`,
          );
        }
      };
      if (verb === 'block' || verb === 'park') {
        held();
        patch.hold = verb === 'block' ? 'stopped' : 'paused';
        patch.hold_reason = reason ?? null;
        log('hold', 'none', patch.hold);
        return { history, patch };
      }
      if (verb === 'unblock' || verb === 'unpark') {
        const expected = verb === 'unblock' ? 'stopped' : 'paused';
        if (delivery.hold !== expected) {
          throw validation(
            `${id} is not ${expected}`,
            delivery.hold === 'none'
              ? `use ${verb === 'unblock' ? 'block' : 'park'} ${id} "reason" first`
              : `${delivery.hold === 'stopped' ? 'unblock' : 'unpark'} ${id} first`,
          );
        }
        clearHold();
        return { history, patch };
      }
      if (verb !== 'abandon') {
        held();
      }
      const source = DELIVERY_OP_FACTS[verb].from[0];
      if (verb !== 'abandon' && delivery.lifecycle !== source) {
        let fix = `create delivery for a new agreed attempt`;
        if (verb !== 'start') {
          fix = `submit ${id} first`;
          if (delivery.lifecycle === 'agreed') {
            fix = `start ${id} first, then submit it`;
          }
          if (verb === 'submit' && delivery.lifecycle === 'milestone') {
            fix = `return ${id} first`;
          }
        }
        throw validation(`${verb} requires a ${source} delivery (is ${delivery.lifecycle})`, fix);
      }
      const members: Node[] = [];
      for (const taskId of delivery.members) {
        const task = await w.loadNode(taskId);
        if (task !== undefined) {
          members.push(task);
        }
      }
      if (verb === 'start') {
        if (members.length === 0) {
          throw validation(
            `${id} has no live member`,
            `add a member with update <task> --delivery ${id}`,
          );
        }
        if (delivery.agreement === null || delivery.agreement.trim() === '') {
          throw validation(
            `${id} has no agreement`,
            `set the agreement with update ${id} --agreement …`,
          );
        }
      }
      if (verb === 'land') {
        for (const task of members) {
          if (task.hold !== 'none') {
            throw validation(
              `${task.id} is held`,
              `${task.hold === 'blocked' ? 'unblock' : 'unpark'} ${task.id} first`,
            );
          }
          if (task.lifecycle !== 'staged') {
            throw validation(
              `${task.id} is not staged`,
              `stage ${task.id} first, or update ${task.id} --delivery none`,
            );
          }
        }
        if (members.length === 0) {
          throw validation(
            `${id} has no staged member`,
            `add a member with update <task> --delivery ${id}, then submit and stage it`,
          );
        }
        for (const task of members) {
          await completeTaskInTransaction(w, task);
        }
      }
      if (verb === 'abandon') {
        for (const task of members) {
          if (task.lifecycle !== 'todo') {
            const taskPatch: NodePatch = { lifecycle: 'todo' };
            const handles = clearHandles(taskPatch, task);
            if (task.hold === 'none' && task.rank === null) {
              taskPatch.rank = await appendRank(w, key);
            }
            await w.updateNode(task.id, taskPatch);
            await logTransition(w, {
              from_value: task.lifecycle,
              handles,
              kind: 'lifecycle',
              node_id: task.id,
              reason: reason ?? null,
              to_value: 'todo',
            });
          }
          await w.updateNode(task.id, { delivery: null, updated_at: now() });
          await w.appendDeliveryMember(id, task.id, 'released');
        }
        if (delivery.hold !== 'none') {
          clearHold();
        }
      }
      patch.lifecycle = DELIVERY_OP_FACTS[verb].to;
      log('lifecycle', delivery.lifecycle, patch.lifecycle);
      return { history, patch };
    }),
  );
}

import { DELIVERY_OP_FACTS } from '@mimir/contract';
import type {
  DeliveryHistory,
  DeliveryDetailView,
  DeliveryLifecycle,
  DeliveryVerb,
  DeliveryView,
  EngineInput,
  Lifecycle,
} from '@mimir/contract';

import { assertBoardActive } from '../archive-lock';
import { blankProse, notFound, projectNotFound, validation } from '../errors';
import { parseIdentity, renderArtifactRef, renderDeliveryRef } from '../ids';
import type { Node, Project } from '../model';
import { normalizeHandle } from '../mutations/handles';
import { completeTaskInTransaction } from '../mutations/lifecycle';
import { identityNoun } from '../project-only';
import { rankAppender } from '../rank';
import type { Store } from '../store';
import { now } from '../time';
import { releaseMember } from './membership';
import type {
  DeliveryStatePatch,
  DeliveryCreate,
  DeliveryPatch,
  NewDeliveryFinding,
  StoredDelivery,
} from './store';

/**
 * The delivery verbs (MMR-676, ADR 0042): the transport-agnostic rules above
 * the {@link DeliveryStore} seam, as the seed verbs sit above theirs. The
 * archive lock, the phase checks, blank text, and the id-kind refusals live
 * here; elapsed time is derived here on every read and never stored.
 */

type Ref = { key: string; seq: number };

/** The delivery an id names, or the refusal for one that names something else.
 * Another record's id is a behavioral kind error (ADR 0042), not a missing record. */
export function requireDeliveryRef(id: string): Ref {
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

/**
 * A delivery as `get KEY-dN` reads it: the record, its two lists in number
 * order, and where its run journal is — the live pad's UUID and the frozen
 * journals' ids, oldest first (ADR 0042, MMR-691).
 */
async function detailOf(store: Store, stored: StoredDelivery): Promise<DeliveryDetailView> {
  const id = renderDeliveryRef(stored);
  const entries = await store.deliveries.findings(stored.key, stored.seq);
  const pad = await store.scratchpads.forDelivery(id);
  const frozen = await store.artifacts.listForDelivery(id);
  return {
    ...viewOf(stored),
    declined: entries.flatMap((entry) =>
      entry.kind === 'declined' && entry.reason !== null
        ? [
            {
              created_at: entry.created_at,
              finding: entry.text,
              number: entry.number,
              reason: entry.reason,
            },
          ]
        : [],
    ),
    journal: {
      artifacts: frozen.map((artifact) => renderArtifactRef(artifact)),
      scratchpad: pad?.id ?? null,
    },
    limitations: entries.flatMap((entry) =>
      entry.kind === 'limitation'
        ? [{ created_at: entry.created_at, number: entry.number, text: entry.text }]
        : [],
    ),
  };
}

/** `get KEY-dN` — one delivery with its whole history. An archived board reads as absent. */
export async function getDelivery(store: Store, id: string): Promise<DeliveryDetailView> {
  const ref = requireDeliveryRef(id);
  const projects = await store.loadProjects();
  const stored =
    activeProject(projects, ref.key) === undefined
      ? undefined
      : await store.deliveries.load(ref.key, ref.seq);
  if (stored === undefined) {
    throw notFound(`${id} doesn't exist`);
  }
  return detailOf(store, stored);
}

/** Append one entry to a delivery's lists and read the delivery back as `get` does. */
async function appendFinding(
  store: Store,
  id: string,
  entry: NewDeliveryFinding,
): Promise<DeliveryDetailView> {
  const { key, seq } = requireDeliveryRef(id);
  await store.deliveries.appendFinding(key, seq, entry);
  return getDelivery(store, id);
}

/** `limitation KEY-dN <text>` — record an edge case the delivery ships knowingly. */
export async function addLimitation(
  store: Store,
  input: EngineInput<'deliveryLimitation'>,
): Promise<DeliveryDetailView> {
  if (input.text.trim() === '') {
    throw validation('a limitation cannot be blank', `limitation ${input.id} "text"`);
  }
  return appendFinding(store, input.id, { kind: 'limitation', reason: null, text: input.text });
}

/** `decline KEY-dN <finding> <reason>` — record a review finding the delivery did not act on. */
export async function declineFinding(
  store: Store,
  input: EngineInput<'deliveryDecline'>,
): Promise<DeliveryDetailView> {
  if (input.finding.trim() === '') {
    throw validation(
      'a declined finding cannot be blank',
      `decline ${input.id} "finding" "reason"`,
    );
  }
  if (input.reason.trim() === '') {
    throw validation(
      'decline requires a nonblank reason',
      `decline ${input.id} "finding" "reason"`,
    );
  }
  return appendFinding(store, input.id, {
    kind: 'declined',
    reason: input.reason,
    text: input.finding,
  });
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

/** The indefinite article a lifecycle word takes: `an agreed`, `a running`. */
const article = (word: string): string => (/^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`);

/**
 * The fix for a lifecycle verb that meets a live delivery in the wrong
 * lifecycle, read from where the delivery is now: what moves it on toward the
 * verb, or, when it is already past the verb, what it takes next.
 */
function lifecycleFix(verb: DeliveryVerb, id: string, lifecycle: DeliveryLifecycle): string {
  if (lifecycle === 'agreed') {
    return verb === 'submit' ? `start ${id} first` : `start ${id} first, then submit it`;
  }
  if (lifecycle === 'running') {
    return verb === 'start'
      ? `it is already running; submit ${id} when its milestone is ready`
      : `submit ${id} first`;
  }
  return `it is already at its milestone; land ${id}, or return ${id} to keep working`;
}

/** The steps that bring a live, unstaged member to `staged`, read from its lifecycle. */
function stagingFix(task: Pick<Node, 'id' | 'lifecycle'>): string {
  const steps: Partial<Record<Lifecycle, string>> = {
    in_progress: `submit ${task.id}, then stage it`,
    under_review: `stage ${task.id}`,
  };
  const fix = steps[task.lifecycle ?? 'todo'] ?? `start ${task.id}, submit it, then stage it`;
  return `${fix}, or update ${task.id} --delivery none`;
}

/**
 * A delivery verb's reason, normalized: blank text is no reason, so an
 * optional reason stores `null` and a required one refuses (ADR 0042 Verbs).
 */
function reasonOf(verb: DeliveryVerb, id: string, given: string | undefined): string | null {
  const reason = given === undefined || given.trim() === '' ? null : given;
  if (reason === null && DELIVERY_OP_FACTS[verb].reason === 'required') {
    throw validation(`${verb} requires a nonblank reason`, `${verb} ${id} "reason"`);
  }
  return reason;
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
      const { id } = input;
      const reason = reasonOf(verb, id, input.reason);
      const patch: DeliveryStatePatch = {};
      const history: DeliveryHistory[] = [];
      const log = (kind: 'hold' | 'lifecycle', from: string, to: string) => {
        history.push({
          at: now(),
          from_value: from,
          kind,
          reason,
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
        patch.hold_reason = reason;
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
        throw validation(
          `${verb} requires ${article(source)} delivery (is ${delivery.lifecycle})`,
          lifecycleFix(verb, id, delivery.lifecycle),
        );
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
            throw validation(`${task.id} is not staged`, stagingFix(task));
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
        const nextRank = rankAppender(w, key);
        for (const task of members) {
          await releaseMember(w, task, id, reason, nextRank);
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

import type { DeliveryHistory, DeliveryView, EngineInput } from '@mimir/contract';

import { assertBoardActive } from '../archive-lock';
import { blankProse, notFound, projectNotFound, validation } from '../errors';
import { parseIdentity, renderDeliveryRef } from '../ids';
import type { Project } from '../model';
import { normalizeHandle } from '../mutations/handles';
import { identityNoun } from '../project-only';
import type { Store } from '../store';
import { now } from '../time';
import type { DeliveryCreate, DeliveryPatch, StoredDelivery } from './store';

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
  const { phase, ...terms } = input;
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

import type { DeliveryHistory, DeliveryHold, DeliveryLifecycle } from '@mimir/contract';

import { validation } from '../errors';

/**
 * The delivery storage seam (MMR-676, ADR 0042): one attempt to deliver a
 * phase, a project-anchored record beside the work tree with its own `KEY-dN`
 * grammar, shaped like a seed.
 *
 * Keyed by external identity (`key` + `seq`). The seam owns allocation, the
 * row, and the append-only history; the verbs in `./intent` own every
 * behavioral rule (the archive lock, the phase checks, blank text) and derive
 * what is never stored (elapsed time). The one rule the seam asserts is the
 * terminal freeze, inside the write that would break it, so a concurrent
 * terminal write can never be overwritten.
 */

/** One delivery as stored: its row and its history in log order. */
export type StoredDelivery = {
  key: string;
  seq: number;
  phase: string;
  title: string;
  lifecycle: DeliveryLifecycle;
  hold: DeliveryHold;
  hold_reason: string | null;
  agreement: string | null;
  external_ref: string | null;
  branch: string | null;
  host: string | null;
  harness: string | null;
  session: string | null;
  time_cap_minutes: number | null;
  created_at: string;
  updated_at: string;
  history: DeliveryHistory[];
};

/** The terms a new delivery is written with; the verb has validated every one. */
export type DeliveryCreate = {
  /** The owning project's key, the phase's own. */
  key: string;
  phase: string;
  title: string;
  agreement: string | null;
  external_ref: string | null;
  branch: string | null;
  host: string | null;
  harness: string | null;
  session: string | null;
  time_cap_minutes: number | null;
};

/** The fields a write replaces; an absent key is left alone, `null` clears. */
export type DeliveryPatch = Partial<Omit<DeliveryCreate, 'key' | 'phase'>>;

export type DeliveryStore = {
  /** Allocate the next `KEY-dN` seq and write the delivery, born `agreed` with
   * hold `none` and no history; returns the record as written. */
  create: (input: DeliveryCreate) => Promise<StoredDelivery>;
  /** One delivery with its history, or `undefined` when absent. */
  load: (key: string, seq: number) => Promise<StoredDelivery | undefined>;
  /** A project's deliveries with their history, seq ascending. */
  listForProject: (key: string) => Promise<StoredDelivery[]>;
  /**
   * In one write: apply `patch`, append `history` in order, and stamp
   * `updated_at` — or write nothing when both are empty. Refuses an absent
   * delivery (`not_found`) and a terminal one ({@link assertLiveDelivery}).
   */
  patch: (
    key: string,
    seq: number,
    patch: DeliveryPatch,
    history?: readonly DeliveryHistory[],
  ) => Promise<void>;
};

/** `landed` and `abandoned` end an attempt. */
export function isTerminalDelivery(lifecycle: DeliveryLifecycle): boolean {
  return lifecycle === 'landed' || lifecycle === 'abandoned';
}

/** Refuse a write to a terminal delivery, in the one wording every backend gives
 * (ADR 0042: a terminal delivery "refuses every write"). */
export function assertLiveDelivery(id: string, lifecycle: DeliveryLifecycle): void {
  if (isTerminalDelivery(lifecycle)) {
    throw validation(`${id} is ${lifecycle} — a terminal delivery refuses every write`);
  }
}

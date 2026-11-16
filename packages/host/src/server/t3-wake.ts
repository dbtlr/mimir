import { parseEngineInput } from '@mimir/contract';
import { z } from 'zod';

import { T3_ATTEMPT_PATTERN, T3_WAKE_ACTIONS } from './t3-states';
import type { T3WakeAction, T3WakeField, T3WakeInput } from './t3-states';

/*
 * The wake's pure parts (ADR 0040, the wake): the fixed phrase of each action,
 * the message built from it, and the check of a Retry's input. The adapter in
 * t3.ts runs the checks and the send. The console's server-function module
 * loads this file too, so it imports the contract only, never core.
 */

const DELIVERY_ID = /^[A-Z]{2,4}-d\d{1,10}$/;
const DECISION_ID = /^[A-Z]{2,4}-q\d{1,10}$/;
/** An instant in the since read's spelling: ISO 8601 UTC with milliseconds. */
const SINCE_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** The since read's range: years 0100 to 9999 (the contract's `sinceCursorSchema`). */
const SINCE_MIN = Date.parse('0100-01-01T00:00:00.000Z');
const SINCE_MAX = Date.parse('9999-12-31T23:59:59.999Z');

/** The phrase of each action: fixed text that carries only ids. */
const PHRASES: Record<T3WakeAction, (delivery: string, decision: string | null) => string> = {
  deliveryAbandon: (delivery) => `abandoned delivery ${delivery}`,
  deliveryPark: (delivery) => `paused delivery ${delivery}`,
  deliveryReturn: (delivery) => `sent back the milestone of delivery ${delivery}`,
  deliveryUnblock: (delivery) => `cleared the stop on delivery ${delivery}`,
  deliveryUnpark: (delivery) => `resumed delivery ${delivery}`,
  deliveryUpdate: (delivery) => `edited delivery ${delivery}`,
  overturn: (delivery, decision) => `overturned decision ${decision ?? ''} on delivery ${delivery}`,
};

/**
 * The message a wake sends. Nothing the operator typed reaches it: the agent
 * reads the reason, note, or fields from Mimir, as data.
 */
export function wakeMessage(input: Omit<T3WakeInput, 'attempt'>): string {
  const phrase = PHRASES[input.action](input.delivery, input.decision);
  return `Mimir: the operator ${phrase}. Read what changed: mimir get ${input.delivery} --since ${input.since}`;
}

/** The `since` a write at `clockMs` is read from: one millisecond before the clock, as ISO text. */
export function sinceBefore(clockMs: number): string {
  return new Date(clockMs - 1).toISOString();
}

const isWakeAction = (value: unknown): value is T3WakeAction =>
  T3_WAKE_ACTIONS.some((action) => action === value);

const isSince = (value: unknown): value is string => {
  if (typeof value !== 'string' || !SINCE_INSTANT.test(value)) {
    return false;
  }
  const time = Date.parse(value);
  // A rolled-over date (Feb 30, hour 24) parses but is not its own spelling; the CLI refuses it.
  return (
    !Number.isNaN(time) &&
    time >= SINCE_MIN &&
    time <= SINCE_MAX &&
    new Date(time).toISOString() === value
  );
};

const shapeSchema = z.strictObject({
  action: z.unknown(),
  attempt: z.unknown(),
  decision: z.unknown(),
  delivery: z.unknown(),
  since: z.unknown(),
});

/** A `wakeT3` input that parsed: well-formed fields, not yet checked against the store. */
export type T3WakeRequest = T3WakeInput;

/**
 * Check a Retry's input. An input that is not an object with these five keys
 * is a thrown validation error; a bad field reads `invalid`, naming it. The
 * decision's delivery is checked against the store by the adapter.
 */
export function parseWakeInput(input: unknown): T3WakeRequest | { field: T3WakeField } {
  const shape = parseEngineInput(shapeSchema, input);
  const { action, attempt, decision, delivery, since } = shape;
  if (!isWakeAction(action)) {
    return { field: 'action' };
  }
  if (typeof delivery !== 'string' || !DELIVERY_ID.test(delivery)) {
    return { field: 'delivery' };
  }
  if (action === 'overturn') {
    if (typeof decision !== 'string' || !DECISION_ID.test(decision)) {
      return { field: 'decision' };
    }
  } else if (decision !== null) {
    return { field: 'decision' };
  }
  if (typeof attempt !== 'string' || !T3_ATTEMPT_PATTERN.test(attempt)) {
    return { field: 'attempt' };
  }
  if (!isSince(since)) {
    return { field: 'since' };
  }
  return { action, attempt, decision, delivery, since };
}

/** What the waking server functions take beside their Engine input: the browser's attempt id. */
export const wakeAttemptSchema = z.string().regex(T3_ATTEMPT_PATTERN);

/** The wake target of a delivery write: its record names the delivery. */
export const deliveryTarget = (record: { id: string }) => ({
  decision: null,
  delivery: record.id,
});

/** The wake target of an overturn: the decision, and the delivery it names (null when none). */
export const decisionTarget = (record: { id: string; delivery: string | null }) => ({
  decision: record.id,
  delivery: record.delivery,
});

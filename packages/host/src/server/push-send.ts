import type { PushSubscriptionMatch, PushSubscriptionStore } from '@mimir/core';

import { logEvent } from './log-event';
import { buildPushRequest } from './push-protocol';
import type { PushRequest, VapidKeys } from './push-protocol';
import type { PushFailure } from './push-states';

/*
 * One push and its outcome (ADR 0045, the MMR-709 refinement, Sending): one
 * `POST` that follows no redirect and has a time limit, and the row update
 * its answer calls for, made only while the row still holds the endpoint
 * and keys the push was encrypted for. Logs carry the endpoint's host and
 * the status, never its path, a key, the JWT, or the payload.
 */

/** The fetch the channel posts through; tests pass a stub push service. */
export type PushFetch = (input: string, init: RequestInit) => Promise<Response>;

/** What sending needs beside the push: the fetch, the clock, the time limit, and the VAPID subject. */
export type PushSender = {
  fetch: PushFetch;
  clock: () => number;
  timeoutMs: number;
  contact: string;
};

/**
 * What a push service's answer means for its row. `status` is what the log
 * names. `unbuilt` is a local fault: the push could not be encrypted or
 * signed, so nothing was sent and the row says nothing about the service.
 */
export type PushOutcome =
  | { kind: 'unbuilt' }
  | { kind: 'delivered' }
  | { kind: 'gone'; status: number }
  | { kind: 'failed'; failure: PushFailure; status: number | 'timeout' | 'unreachable' };

/** One row's push: where it goes and the keys it is encrypted for. */
export type PushTarget = PushSubscriptionMatch;

/** Read an answer's status as an outcome. */
function outcomeOf(status: number): PushOutcome {
  if (status >= 200 && status < 300) {
    return { kind: 'delivered' };
  }
  if (status === 404 || status === 410) {
    return { kind: 'gone', status };
  }
  // A browser-like fetch answers an unfollowed redirect with an opaque status 0.
  return status === 0
    ? { failure: 'unreachable', kind: 'failed', status: 'unreachable' }
    : { failure: `HTTP ${status}`, kind: 'failed', status };
}

/** Send one push and answer its outcome; this never rejects. */
export async function sendPush(
  sender: PushSender,
  target: PushTarget,
  vapid: VapidKeys,
  payload: unknown,
): Promise<PushOutcome> {
  let request: PushRequest;
  try {
    request = await buildPushRequest({
      contact: sender.contact,
      endpoint: target.endpoint,
      keys: target,
      now: sender.clock(),
      payload: new TextEncoder().encode(JSON.stringify(payload)),
      vapid,
    });
  } catch {
    return { kind: 'unbuilt' };
  }
  const signal = AbortSignal.timeout(sender.timeoutMs);
  let response: Response;
  try {
    response = await sender.fetch(request.endpoint, {
      body: request.body,
      headers: request.headers,
      method: 'POST',
      redirect: 'manual',
      signal,
    });
  } catch {
    return signal.aborted
      ? { failure: 'timeout', kind: 'failed', status: 'timeout' }
      : { failure: 'unreachable', kind: 'failed', status: 'unreachable' };
  }
  await response.body?.cancel().catch(() => undefined);
  return outcomeOf(response.status);
}

/** What recording an outcome needs: the table and the log sink. */
export type OutcomeRecorder = {
  subscriptions: PushSubscriptionStore;
  log: (line: string) => void;
  clock: () => number;
};

/** Whether an outcome's row update landed, and the store error when it did not. */
export type OutcomeWrite = { landed: true } | { landed: false; error: Error };

/**
 * Update the row for an outcome, only while it still matches the target, and
 * log it. A failed update is logged and answered, never thrown; an unbuilt
 * push has no update, so it lands.
 */
export async function recordOutcome(
  recorder: OutcomeRecorder,
  target: PushTarget,
  outcome: PushOutcome,
): Promise<OutcomeWrite> {
  const host = new URL(target.endpoint).hostname;
  if (outcome.kind === 'unbuilt') {
    logEvent(recorder, 'push_build_fault', { host });
    return { landed: true };
  }
  if (outcome.kind === 'gone') {
    logEvent(recorder, 'push_subscription_gone', { host, status: outcome.status });
  } else if (outcome.kind === 'failed') {
    logEvent(recorder, 'push_send_fault', { host, status: outcome.status });
  }
  try {
    if (outcome.kind === 'delivered') {
      await recorder.subscriptions.recordSuccess(target);
    } else if (outcome.kind === 'gone') {
      await recorder.subscriptions.removeIfMatches(target);
    } else {
      await recorder.subscriptions.recordFailure(target, outcome.failure);
    }
  } catch (error) {
    logEvent(recorder, 'push_outcome_write_fault', { host });
    return { error: error instanceof Error ? error : new Error(String(error)), landed: false };
  }
  return { landed: true };
}

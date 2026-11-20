import {
  resetPushKey,
  sendTestPush,
  setPushKind,
  subscribePush,
  unsubscribePush,
} from '../api/fns/push';
import type {
  PushDeviceList,
  PushEventKind,
  PushSetKindResult,
  PushStatus,
  PushSubscribeResult,
} from '../api/fns/push';
import { orderedKinds } from '../server/push-states';
import type { BrowserSubscription, PushBrowser, ThisDeviceRecord } from './push-browser';
import { sameEndpoint } from './push-endpoint';
import { decideHeal, healApplies } from './push-heal';
import type { HealAction, HealInput } from './push-heal';
import { deviceLabel } from './push-identity';
import { HEAL_RUNNING_TEXT, subscribeRefusalText } from './push-text';

/*
 * What the Notifications page and the healer do (ADR 0045, MMR-711): the
 * browser-side and host-side steps of turning notifications on and off and of
 * healing a subscription, in one place so both read the same.
 */

export type TurnOnOutcome =
  | { kind: 'subscribed' }
  /** Permission did not end granted. */
  | { kind: 'not_granted'; permission: string }
  | { kind: 'refused'; message: string; link?: string }
  | { kind: 'failed'; message: string }
  /** A heal was still running after the wait: nothing changed, and a later click can try again. */
  | { kind: 'busy'; message: string };

/** What Turn off did: turned this browser off, or nothing, because a heal was still running after the wait. */
export type TurnOffOutcome = { kind: 'off' } | { kind: 'busy'; message: string };

const BUSY = { kind: 'busy', message: HEAL_RUNNING_TEXT } as const;

type Ready = Extract<PushStatus, { state: 'ready' }>;

/** The kinds a subscribe carries for this browser: the record's, when it knows them (ADR 0045, MMR-712). */
const recordMuted = (record: ThisDeviceRecord | null): PushEventKind[] | undefined =>
  record?.state === 'on' ? record.muted : undefined;

/** Send a subscription to the host under this browser's generated label, with the kinds to mute when given. */
async function send(
  browser: PushBrowser,
  status: Ready,
  made: BrowserSubscription,
  muted: PushEventKind[] | undefined,
) {
  return subscribePush({
    data: {
      auth: made.auth,
      endpoint: made.endpoint,
      label: deviceLabel(browser.snapshot().identity),
      p256dh: made.p256dh,
      serverKey: status.publicKey,
      ...(muted === undefined ? {} : { muted }),
    },
  });
}

type Sent = {
  answer: PushSubscribeResult;
  status: Ready;
  made: BrowserSubscription;
  muted: PushEventKind[] | undefined;
};

/**
 * Send `made` to the host. A stale key means the host's key changed since
 * `status` was read: reread it, subscribe with the fresh key, and send once
 * more.
 */
async function sendOrRetry(
  browser: PushBrowser,
  status: Ready,
  readStatus: () => Promise<PushStatus>,
  made: BrowserSubscription,
  muted: PushEventKind[] | undefined,
): Promise<Sent> {
  const answer = await send(browser, status, made, muted);
  if (answer.state === 'stale_key') {
    const fresh = await readStatus();
    if (fresh.state === 'ready') {
      const again = await browser.subscribe(fresh.publicKey);
      return {
        answer: await send(browser, fresh, again, muted),
        made: again,
        muted,
        status: fresh,
      };
    }
  }
  return { answer, made, muted, status };
}

/** The record of a turn on the host accepted: the endpoint, the key it was made for, and the kinds it sent. */
const onRecord = ({ made, muted, status }: Sent): ThisDeviceRecord => ({
  endpoint: made.endpoint,
  serverKey: status.publicKey,
  state: 'on',
  ...(muted === undefined ? {} : { muted }),
});

/**
 * Refusals a heal answers by turning this browser off: the browser itself
 * causes them and trying again on the next load cannot fix them. A full host
 * (`too_many_devices`) is not one: a device removed elsewhere frees a place,
 * so the heal keeps the opt-in and the next load tries again.
 */
const FINAL_REFUSALS: ReadonlySet<PushSubscribeResult['state']> = new Set([
  'endpoint_not_allowed',
  'invalid_keys',
  'wrong_origin',
]);

/** Forget this browser's turn on and drop its subscription; the record goes first, so a failed drop still leaves it off. */
async function forget(browser: PushBrowser): Promise<void> {
  browser.writeRecord(null);
  await browser.unsubscribe();
}

/**
 * Turn notifications on for this browser. Called from the click itself, so the
 * permission prompt is user-activated: nothing is awaited before it. After it,
 * a heal that is running finishes first (`healSettled`), so the two never
 * subscribe at once; one still running after the wait leaves everything as it
 * was and answers `busy`. A refusal or a failure, including a prompt that throws,
 * clears the record and drops the browser-side subscription, so the browser and
 * the host agree and an earlier turn on or removal no longer speaks for this
 * browser.
 */
export async function turnOn(
  browser: PushBrowser,
  status: Ready,
  readStatus: () => Promise<PushStatus>,
): Promise<TurnOnOutcome> {
  try {
    const permission = await browser.requestPermission();
    if (permission !== 'granted') {
      return { kind: 'not_granted', permission };
    }
    if (!(await healSettled())) {
      return BUSY;
    }
    // A record still on keeps its kinds; any other turn on starts with every kind on.
    const sent = await sendOrRetry(
      browser,
      status,
      readStatus,
      await browser.subscribe(status.publicKey),
      recordMuted(browser.readRecord()) ?? [],
    );
    const { answer, status: used } = sent;
    if (answer.state === 'subscribed') {
      browser.writeRecord(onRecord(sent));
      return { kind: 'subscribed' };
    }
    await forget(browser).catch(() => {});
    return {
      kind: 'refused',
      link: answer.state === 'wrong_origin' ? used.consoleOrigin : undefined,
      message: subscribeRefusalText(answer, used.consoleOrigin),
    };
  } catch {
    await forget(browser).catch(() => {});
    return { kind: 'failed', message: "This browser couldn't turn notifications on. Try again." };
  }
}

/**
 * Turn notifications off for this browser: forget that it turned them on,
 * then drop its subscription here and on the host. A heal that is running
 * finishes first (`healSettled`), so it cannot turn notifications back on after
 * this; the endpoint it sent, if it replaced `endpoint`, goes too. One still
 * running after the wait leaves everything as it was and answers `busy`. The record
 * goes first, so a failed step after it never lets the healer turn
 * notifications back on. The host's rows go even when the browser's
 * unsubscribe fails, so no device lists a browser the operator turned off; that
 * failure is then thrown.
 */
export async function turnOff(browser: PushBrowser, endpoint: string): Promise<TurnOffOutcome> {
  if (!(await healSettled())) {
    return BUSY;
  }
  const record = browser.readRecord();
  browser.writeRecord(null);
  let browserFailure: { error: unknown } | undefined;
  try {
    await browser.unsubscribe();
  } catch (error) {
    browserFailure = { error };
  }
  await unsubscribePush({ data: { endpoint } });
  if (record?.state === 'on' && !sameEndpoint(record.endpoint, endpoint)) {
    await unsubscribePush({ data: { endpoint: record.endpoint } });
  }
  if (browserFailure !== undefined) {
    throw browserFailure.error;
  }
  return { kind: 'off' };
}

export const removeBrowser = async (endpoint: string) => unsubscribePush({ data: { endpoint } });
export const testBrowser = async (endpoint: string) => sendTestPush({ data: { endpoint } });
export const resetKey = async () => resetPushKey();

/**
 * Carry out a heal action. Before it marks this browser removed it rereads
 * the status: a key other than the one the decision read means a reset deleted
 * the row, so it subscribes again with that key instead; a reread that fails or
 * is not ready does nothing this load. A refusal this browser causes and a retry cannot
 * fix (`FINAL_REFUSALS`) drops the subscription here and clears the record,
 * so this browser reads Off rather than holding a subscription nothing sends
 * to. A stale key rereads the status and tries once more with the fresh key.
 * Any other answer, and a thrown failure, changes no record and keeps the
 * subscription, so the next load adopts or subscribes again. On `subscribed`
 * the record's old endpoint leaves the host before the record names the new
 * one; a removal that fails leaves the record as it was.
 */
export async function applyHeal(
  browser: PushBrowser,
  status: Ready,
  readStatus: () => Promise<PushStatus>,
  action: HealAction,
  staleEndpoint: string | undefined,
): Promise<void> {
  switch (action.kind) {
    case 'none': {
      return;
    }
    case 'mark_removed': {
      // A reset elsewhere between the status read and the list read also deletes the row; the key tells them apart.
      const fresh = await readStatus();
      if (fresh.state !== 'ready') {
        return;
      }
      if (fresh.publicKey !== status.publicKey) {
        await applyHeal(
          browser,
          fresh,
          readStatus,
          { kind: 'resubscribe', reason: 'key_changed' },
          staleEndpoint,
        );
        return;
      }
      await browser.unsubscribe();
      browser.writeRecord({ state: 'removed' });
      return;
    }
    case 'resubscribe':
    case 'adopt': {
      const made =
        action.kind === 'adopt'
          ? await browser.subscription()
          : await browser.subscribe(status.publicKey);
      if (made === null) {
        return;
      }
      const sent = await sendOrRetry(
        browser,
        status,
        readStatus,
        made,
        recordMuted(browser.readRecord()),
      );
      if (FINAL_REFUSALS.has(sent.answer.state)) {
        await forget(browser);
        return;
      }
      if (sent.answer.state !== 'subscribed') {
        return;
      }
      // The old endpoint goes first: until it does, the record keeps naming it, so the next load adopts and removes it again.
      const old = action.kind === 'adopt' ? action.staleEndpoint : staleEndpoint;
      if (old !== undefined && !sameEndpoint(old, sent.made.endpoint)) {
        await unsubscribePush({ data: { endpoint: old } });
      }
      browser.writeRecord(onRecord(sent));
      return;
    }
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

/** Whether two lists of kinds name the same kinds; an unknown list differs from every list. */
const sameKinds = (a: readonly PushEventKind[] | undefined, b: readonly PushEventKind[]) =>
  a !== undefined && a.length === b.length && a.every((kind) => b.includes(kind));

/**
 * The heal's first step (ADR 0045, MMR-712): copy this browser's row's kinds
 * into the record when they differ, so a choice made on another device
 * survives the subscribe that follows. The row is the current-key row for the
 * endpoint the browser holds, or else for the record's endpoint.
 */
function learnKinds(browser: PushBrowser, input: HealInput): void {
  const { devices, record, subscription } = input;
  if (!healApplies(input) || record?.state !== 'on' || devices.state !== 'listed') {
    return;
  }
  const rowFor = (endpoint: string) =>
    devices.devices.find((row) => row.currentKey && sameEndpoint(row.endpoint, endpoint));
  const row =
    (subscription === null ? undefined : rowFor(subscription.endpoint)) ?? rowFor(record.endpoint);
  if (row !== undefined && !sameKinds(record.muted, row.muted)) {
    browser.writeRecord({ ...record, muted: row.muted });
  }
}

/** What a switch's save answers; `busy` when a heal on this browser outlasted the wait. */
export type SaveKindOutcome = PushSetKindResult | { state: 'busy' };

/**
 * Mute or unmute one kind on one browser's row. A save on this browser's own
 * row (`own`) first waits for a running heal, so the two never cross. When it
 * saves, it applies the change to the record only when the record is `on`
 * and is for that endpoint, or the save is on this browser's own row (whose
 * record may still name an old endpoint), starting from `rowMuted` (the row's
 * listed kinds) when the record knows none: it never writes an absent or
 * removed record.
 */
export async function saveKind(
  browser: PushBrowser,
  change: {
    endpoint: string;
    kind: PushEventKind;
    muted: boolean;
    rowMuted: readonly PushEventKind[];
    own?: boolean;
  },
): Promise<SaveKindOutcome> {
  const { endpoint, kind, muted, rowMuted } = change;
  if (change.own === true && !(await healSettled())) {
    return { state: 'busy' };
  }
  const answer = await setPushKind({ data: { endpoint, kind, muted } });
  const record = browser.readRecord();
  if (
    answer.state === 'saved' &&
    record?.state === 'on' &&
    (change.own === true || sameEndpoint(record.endpoint, endpoint))
  ) {
    const others = (record.muted ?? rowMuted).filter((name) => name !== kind);
    browser.writeRecord({ ...record, muted: orderedKinds(muted ? [...others, kind] : others) });
  }
  return answer;
}

/** The heal running now, which a second caller joins. */
let healing: Promise<void> | undefined;

/**
 * Decide and apply in one go, silently: any failure leaves the record as it
 * was. A subscription read that timed out throws, so an unknown subscription
 * is never taken for a dropped one.
 */
async function heal(
  browser: PushBrowser,
  status: Ready,
  devices: PushDeviceList,
  readStatus: () => Promise<PushStatus>,
): Promise<void> {
  try {
    const snapshot = browser.snapshot();
    const record = browser.readRecord();
    const subscription = await browser.subscription();
    const input = {
      devices,
      permission: snapshot.permission,
      pushSupported: snapshot.pushSupported,
      record,
      status,
      subscription,
    };
    learnKinds(browser, input);
    const action = decideHeal(input);
    await applyHeal(
      browser,
      status,
      readStatus,
      action,
      record?.state === 'on' ? record.endpoint : undefined,
    );
  } catch (error) {
    console.warn('Could not heal this browser’s push subscription', error);
  }
}

/**
 * Heal this browser against the host's status and list; `readStatus` rereads
 * the status after a stale key. A call while a heal runs joins it rather than
 * starting another, so two callers never subscribe in parallel.
 */
export async function healThisBrowser(
  browser: PushBrowser,
  status: PushStatus,
  devices: PushDeviceList,
  readStatus: () => Promise<PushStatus>,
): Promise<void> {
  if (status.state !== 'ready') {
    return;
  }
  const run = async () => {
    try {
      await heal(browser, status, devices, readStatus);
    } finally {
      healing = undefined;
    }
  };
  healing ??= run();
  return healing;
}

/** How long Turn on, Turn off, and the page's heal after a reset wait for a heal that is running. */
export const HEAL_WAIT_MS = 10_000;

/**
 * Wait for a heal that is running, if any, so a caller reads the state it
 * leaves; at most `HEAL_WAIT_MS`, so a heal whose host call never answers
 * cannot hold a caller forever. Answers whether that heal finished: false
 * when the wait ran out and it is still running.
 */
export async function healSettled(): Promise<boolean> {
  const running = healing;
  if (running === undefined) {
    return true;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A timer has no promise form in the browser, and Promise.withResolvers is newer than Web Push on iOS.
  // oxlint-disable-next-line promise/avoid-new
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, HEAL_WAIT_MS);
  });
  try {
    return await Promise.race([running.then(() => true), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

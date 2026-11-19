import { resetPushKey, sendTestPush, subscribePush, unsubscribePush } from '../api/fns/push';
import type { PushDeviceList, PushStatus, PushSubscribeResult } from '../api/fns/push';
import type { BrowserSubscription, PushBrowser } from './push-browser';
import { sameEndpoint } from './push-endpoint';
import { decideHeal } from './push-heal';
import type { HealAction } from './push-heal';
import { deviceLabel } from './push-identity';
import { subscribeRefusalText } from './push-text';

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
  | { kind: 'failed'; message: string };

type Ready = Extract<PushStatus, { state: 'ready' }>;

/** Send a subscription to the host under this browser's generated label. */
async function send(browser: PushBrowser, status: Ready, made: BrowserSubscription) {
  return subscribePush({
    data: {
      auth: made.auth,
      endpoint: made.endpoint,
      label: deviceLabel(browser.snapshot().identity),
      p256dh: made.p256dh,
      serverKey: status.publicKey,
    },
  });
}

/** Subscribe in the browser and send it; a stale key refetches the status and tries once more. */
async function subscribeAndSend(
  browser: PushBrowser,
  status: Ready,
  readStatus: () => Promise<PushStatus>,
  retry = true,
): Promise<{ answer: PushSubscribeResult; status: Ready; made: BrowserSubscription }> {
  const made = await browser.subscribe(status.publicKey);
  const answer = await send(browser, status, made);
  if (answer.state === 'stale_key' && retry) {
    const fresh = await readStatus();
    if (fresh.state === 'ready') {
      return subscribeAndSend(browser, fresh, readStatus, false);
    }
  }
  return { answer, made, status };
}

/** Forget this browser's turn on and drop its subscription; the record goes first, so a failed drop still leaves it off. */
async function forget(browser: PushBrowser): Promise<void> {
  browser.writeRecord(null);
  await browser.unsubscribe();
}

/**
 * Turn notifications on for this browser. Called from the click itself, so the
 * permission prompt is user-activated: nothing is awaited before it. A refusal
 * or a failure, including a prompt that throws, clears the record and drops the
 * browser-side subscription, so the browser and the host agree and an earlier
 * turn on or removal no longer speaks for this browser.
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
    const { answer, made, status: used } = await subscribeAndSend(browser, status, readStatus);
    if (answer.state === 'subscribed') {
      browser.writeRecord({ endpoint: made.endpoint, state: 'on' });
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
 * then drop its subscription here and on the host. The record goes first, so
 * a failed step after it never lets the healer turn notifications back on. The
 * host's row goes even when the browser's unsubscribe fails, so no device lists
 * a browser the operator turned off; that failure is then thrown.
 */
export async function turnOff(browser: PushBrowser, endpoint: string): Promise<void> {
  browser.writeRecord(null);
  let browserFailure: { error: unknown } | undefined;
  try {
    await browser.unsubscribe();
  } catch (error) {
    browserFailure = { error };
  }
  await unsubscribePush({ data: { endpoint } });
  if (browserFailure !== undefined) {
    throw browserFailure.error;
  }
}

export const removeBrowser = async (endpoint: string) => unsubscribePush({ data: { endpoint } });
export const testBrowser = async (endpoint: string) => sendTestPush({ data: { endpoint } });
export const resetKey = async () => resetPushKey();

/**
 * Carry out a heal action. A thrown failure changes no record, so the next
 * load tries again. A subscription the host refuses is dropped here and the
 * record cleared, so this browser reads Off rather than holding a
 * subscription nothing sends to.
 */
export async function applyHeal(
  browser: PushBrowser,
  status: Ready,
  action: HealAction,
  staleEndpoint: string | undefined,
): Promise<void> {
  switch (action.kind) {
    case 'none': {
      return;
    }
    case 'mark_removed': {
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
      const answer = await send(browser, status, made);
      if (answer.state !== 'subscribed') {
        await forget(browser);
        return;
      }
      browser.writeRecord({ endpoint: made.endpoint, state: 'on' });
      const old = action.kind === 'adopt' ? action.staleEndpoint : staleEndpoint;
      if (old !== undefined && !sameEndpoint(old, made.endpoint)) {
        await unsubscribePush({ data: { endpoint: old } });
      }
      return;
    }
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

/** The heal running now, which a second caller joins. */
let healing: Promise<void> | undefined;

/** Decide and apply in one go, silently: any failure leaves the record as it was. */
async function heal(browser: PushBrowser, status: Ready, devices: PushDeviceList): Promise<void> {
  try {
    const snapshot = browser.snapshot();
    const record = browser.readRecord();
    const action = decideHeal({
      devices,
      permission: snapshot.permission,
      pushSupported: snapshot.pushSupported,
      record,
      status,
      subscription: await browser.subscription(),
    });
    await applyHeal(browser, status, action, record?.state === 'on' ? record.endpoint : undefined);
  } catch (error) {
    console.warn('Could not heal this browser’s push subscription', error);
  }
}

/**
 * Heal this browser against the host's status and list. A call while a heal
 * runs joins it rather than starting another, so two callers never subscribe
 * in parallel.
 */
export async function healThisBrowser(
  browser: PushBrowser,
  status: PushStatus,
  devices: PushDeviceList,
): Promise<void> {
  if (status.state !== 'ready') {
    return;
  }
  const run = async () => {
    try {
      await heal(browser, status, devices);
    } finally {
      healing = undefined;
    }
  };
  healing ??= run();
  return healing;
}

/** Wait for a heal that is running, if any, so a caller reads the state it leaves. */
export async function healSettled(): Promise<void> {
  await healing;
}

import { resetPushKey, sendTestPush, subscribePush, unsubscribePush } from '../api/fns/push';
import type { PushDeviceList, PushStatus, PushSubscribeResult } from '../api/fns/push';
import type { BrowserSubscription, PushBrowser } from './push-browser';
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

/**
 * Turn notifications on for this browser. Called from the click itself, so the
 * permission prompt is user-activated. A refusal drops the browser-side
 * subscription, so the browser and the host agree.
 */
export async function turnOn(
  browser: PushBrowser,
  status: Ready,
  readStatus: () => Promise<PushStatus>,
): Promise<TurnOnOutcome> {
  const permission = await browser.requestPermission();
  if (permission !== 'granted') {
    return { kind: 'not_granted', permission };
  }
  try {
    const { answer, made, status: used } = await subscribeAndSend(browser, status, readStatus);
    if (answer.state === 'subscribed') {
      browser.writeRecord({ endpoint: made.endpoint, state: 'on' });
      return { kind: 'subscribed' };
    }
    await browser.unsubscribe();
    return {
      kind: 'refused',
      link: answer.state === 'wrong_origin' ? used.consoleOrigin : undefined,
      message: subscribeRefusalText(answer, used.consoleOrigin),
    };
  } catch {
    await browser.unsubscribe().catch(() => {});
    return { kind: 'failed', message: "This browser couldn't turn notifications on. Try again." };
  }
}

/**
 * Turn notifications off for this browser: forget that it turned them on,
 * then drop its subscription here and on the host. The record goes first, so
 * a failed step after it never lets the healer turn notifications back on.
 */
export async function turnOff(browser: PushBrowser, endpoint: string): Promise<void> {
  browser.writeRecord(null);
  await browser.unsubscribe();
  await unsubscribePush({ data: { endpoint } });
}

export const removeBrowser = async (endpoint: string) => unsubscribePush({ data: { endpoint } });
export const testBrowser = async (endpoint: string) => sendTestPush({ data: { endpoint } });
export const resetKey = async () => resetPushKey();

/** Carry out a heal action; a failure changes no record. */
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
        return;
      }
      browser.writeRecord({ endpoint: made.endpoint, state: 'on' });
      const old = action.kind === 'adopt' ? action.staleEndpoint : staleEndpoint;
      if (old !== undefined && old !== made.endpoint) {
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

/** Decide and apply in one go, silently: any failure leaves the record as it was. */
export async function healThisBrowser(
  browser: PushBrowser,
  status: PushStatus,
  devices: PushDeviceList,
): Promise<void> {
  if (status.state !== 'ready') {
    return;
  }
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

import type {
  PushDevice,
  PushResetResult,
  PushSendTestResult,
  PushStatus,
  PushSubscribeResult,
} from '../api/fns/push';
import { PUSH_EVENT_KINDS } from '../server/push-states';
import type { PushEventKind } from '../server/push-states';
import { isDesktop } from './push-identity';
import type { BrowserIdentity } from './push-identity';
import type { ThisDeviceState } from './push-this-device';
import { ago } from './time';

/*
 * The words of the Notifications page (ADR 0045, MMR-711): the sentence under
 * this browser's control for each state, what an action answered, and a
 * subscribed browser's meta line. Pure, so the wording is proved here and the
 * page only places it.
 */

/** A state's sentence, and the steps that follow it where there are any. */
export type Caption = { text: string; steps: string[] };

export const KEY_UNUSABLE_TEXT =
  "Notifications are paused on every device. This host can't open its push key, usually because MIMIR_SECRET_KEY changed. Restore the previous value and restart the host. If the previous value is lost, reset the push key; each device subscribes again the next time its console opens.";

/** Each kind's name on a switch, in the event order (ADR 0045, MMR-712). */
export const KIND_NAMES: Record<PushEventKind, string> = {
  decisions: 'Decisions to confirm',
  delivery_stopped: 'Stopped deliveries',
  task_blocked: 'Tasks blocked on you',
  task_needs_answers: 'Tasks that need answers',
};

/** Each kind's short name in a row's meta line. */
const KIND_SHORT_NAMES: Record<PushEventKind, string> = {
  decisions: 'Decisions',
  delivery_stopped: 'Deliveries',
  task_blocked: 'Blocked tasks',
  task_needs_answers: 'Answers',
};

/** What a row's meta line says of its muted kinds; nothing when it mutes none. */
export function mutedText(muted: readonly PushEventKind[]): string {
  const [only] = muted;
  if (only === undefined) {
    return '';
  }
  if (muted.length === 1) {
    return `${KIND_SHORT_NAMES[only]} off`;
  }
  return muted.length >= PUSH_EVENT_KINDS.length
    ? 'Every kind off'
    : `${String(muted.length)} kinds off`;
}

/** The line under this browser's switches when they mute every kind. */
export const EVERY_KIND_OFF_TEXT =
  'Every kind is off. This browser stays subscribed and still takes a test notification.';
/** The line under another row's switches when they mute every kind. */
export const THAT_EVERY_KIND_OFF_TEXT =
  'Every kind is off. That browser stays subscribed and still takes a test notification.';
/** What a switch says when its save failed and it returned to its saved position. */
export const KIND_SAVE_FAILED_TEXT = "The choice couldn't be saved.";
/** What the page says when a save on this browser's own row found no row. */
export const THIS_BROWSER_GONE_TEXT = 'This browser is no longer subscribed.';
/** What the page says when a save on another row found no row. */
export const THAT_BROWSER_GONE_TEXT = 'That browser is no longer subscribed.';

/** What Turn on, Turn off, and a save on this browser's row answer when a heal of this browser is still running after their wait. */
export const HEAL_RUNNING_TEXT =
  "Another update to this browser's notifications is still running. Try again in a moment.";

/** Where to undo a block, by platform and browser. */
export function deniedHelp(identity: BrowserIdentity): string {
  const { platform, browser } = identity;
  let how: string;
  if (platform === 'iPhone' || platform === 'iPad') {
    how = `open the ${platform}'s Settings › Notifications › Mimir and turn on Allow Notifications`;
  } else if (browser === 'Chrome' || browser === 'Edge') {
    how = 'use the icon left of the address › Site settings › Notifications › Allow';
  } else if (browser === 'Firefox') {
    how = 'use the icon left of the address and clear the Notifications block';
  } else {
    how = "allow notifications for this site in the browser's site settings";
  }
  return `You declined notifications here. To allow them, ${how}, then come back here.`;
}

/** The sentence a desktop browser adds: it notifies only while it runs. */
function desktopHint(identity: BrowserIdentity): string {
  const { browser, platform } = identity;
  const where =
    platform === 'Mac' && browser === 'Chrome'
      ? 'System Settings › Notifications › Google Chrome'
      : `the system's notification settings for ${browser}`;
  return `Notifications arrive while ${browser} is running. If a test shows nothing, check ${where}.`;
}

function onText(device: PushDevice, identity: BrowserIdentity, now: number): string {
  const failedAt =
    device.lastFailureAt === undefined ? undefined : Date.parse(device.lastFailureAt);
  const deliveredAt =
    device.lastSuccessAt === undefined ? undefined : Date.parse(device.lastSuccessAt);
  let last = 'No notification yet.';
  if (failedAt !== undefined && (deliveredAt === undefined || failedAt > deliveredAt)) {
    last = `Last attempt failed ${ago(failedAt, now)}: ${device.lastFailure ?? 'unreachable'}.`;
  } else if (deliveredAt !== undefined) {
    last = `Last one arrived ${ago(deliveredAt, now)}.`;
  }
  return isDesktop(identity) ? `${last} ${desktopHint(identity)}` : last;
}

const IOS_STEPS = [
  'Tap the Share button in Safari.',
  'Tap Add to Home Screen, then Add.',
  'Open Mimir from the Home Screen and come back here.',
];

const plain = (text: string): Caption => ({ steps: [], text });

/** The sentence under this browser's control for its state. */
export function stateCaption(
  state: ThisDeviceState,
  identity: BrowserIdentity,
  now = Date.now(),
): Caption {
  switch (state.kind) {
    case 'loading': {
      return plain('');
    }
    case 'unconfigured': {
      return plain(
        "Notifications aren't set up on this host. Set MIMIR_PUSH_CONTACT on the host and restart it.",
      );
    }
    case 'misconfigured': {
      return plain(
        `Notifications can't start: ${state.setting} is ${state.problem}. Fix it on the host and restart it.`,
      );
    }
    case 'key_unusable': {
      return plain(KEY_UNUSABLE_TEXT);
    }
    case 'ios_needs_home_screen': {
      return {
        steps: IOS_STEPS,
        text: `On ${state.platform}, notifications only reach the console when it is opened from the Home Screen.`,
      };
    }
    case 'unsupported': {
      return plain("This browser can't receive push notifications.");
    }
    case 'denied': {
      return plain(deniedHelp(identity));
    }
    case 'removed': {
      return plain(
        'This browser was removed from the list, or its push service stopped accepting notifications.',
      );
    }
    case 'off': {
      const turnOn = 'Turn on to get a notification on this device when something needs you.';
      return plain(
        isDesktop(identity)
          ? `${turnOn} Notifications arrive while ${identity.browser} is running.`
          : turnOn,
      );
    }
    case 'on': {
      return plain(onText(state.device, identity, now));
    }
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

/** The problem a status or a result names when the channel cannot act, as one sentence. */
function unavailableText(answer: Extract<PushStatus, { state: 'misconfigured' | 'unconfigured' }>) {
  return answer.state === 'unconfigured'
    ? "Notifications aren't set up on this host."
    : `Notifications can't start: ${answer.setting} is ${answer.problem}.`;
}

/** Why a turn-on wrote nothing, as one plain sentence. */
export function subscribeRefusalText(
  answer: Exclude<PushSubscribeResult, { state: 'subscribed' }>,
  consoleOrigin: string,
): string {
  switch (answer.state) {
    case 'wrong_origin': {
      return `Open the console at ${consoleOrigin} to turn on notifications here.`;
    }
    case 'too_many_devices': {
      return '20 browsers are subscribed, the most a host keeps. Remove one below, then turn on.';
    }
    case 'endpoint_not_allowed': {
      return "This browser's push service isn't one the host accepts, so it can't get notifications.";
    }
    case 'invalid_keys': {
      return "This browser's push keys were refused. Try turning on again.";
    }
    case 'key_unusable': {
      return "The host can't open its push key right now. Reset the push key below.";
    }
    case 'stale_key': {
      return 'The host changed its push key. Try turning on again.';
    }
    case 'unconfigured':
    case 'misconfigured': {
      return unavailableText(answer);
    }
    default: {
      const _exhaustive: never = answer;
      return _exhaustive;
    }
  }
}

/** What a test push answered, as one plain sentence. */
export function testResultText(answer: PushSendTestResult): string {
  switch (answer.state) {
    case 'delivered': {
      return 'Test sent. It should appear in a few seconds.';
    }
    case 'gone': {
      return "That browser's push service no longer accepts it, so it was removed.";
    }
    case 'failed': {
      return `Test failed: ${answer.failure}.`;
    }
    case 'not_found': {
      return 'That browser is no longer in the list.';
    }
    case 'stale_key': {
      return 'That browser subscribed with an old push key. Remove it.';
    }
    case 'key_unusable': {
      return "The host can't open its push key right now.";
    }
    case 'unconfigured':
    case 'misconfigured': {
      return unavailableText(answer);
    }
    default: {
      const _exhaustive: never = answer;
      return _exhaustive;
    }
  }
}

/** Why a key reset changed nothing, as one sentence; undefined once it reset. */
export function resetRefusalText(answer: PushResetResult): string | undefined {
  switch (answer.state) {
    case 'reset': {
      return undefined;
    }
    default: {
      return unavailableText(answer);
    }
  }
}

const shortDay = (at: string) =>
  new Date(at).toLocaleDateString('en-US', { day: 'numeric', month: 'short' });

/** One subscribed browser's meta line, and whether it carries the old-key warning. */
export function deviceMeta(
  device: PushDevice,
  options: { thisDevice: boolean; now?: number },
): { text: string; oldKey: boolean } {
  const now = options.now ?? Date.now();
  const parts: string[] = [];
  if (options.thisDevice) {
    parts.push('This device');
  }
  if (!device.currentKey) {
    parts.push('Old key');
  }
  const failed = device.lastFailureAt;
  const delivered = device.lastSuccessAt;
  if (
    failed !== undefined &&
    (delivered === undefined || Date.parse(failed) > Date.parse(delivered))
  ) {
    parts.push(`failed ${shortDay(failed)}: ${device.lastFailure ?? 'unreachable'}`);
  } else if (delivered !== undefined) {
    parts.push(`delivered ${ago(delivered, now)}`);
  } else if (device.currentKey) {
    parts.push('no notification yet');
  }
  const muted = mutedText(device.muted);
  if (muted !== '') {
    parts.push(muted);
  }
  return { oldKey: !device.currentKey, text: parts.join(' · ') };
}

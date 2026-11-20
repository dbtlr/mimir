/*
 * The Web Push channel's tagged states (ADR 0045, the MMR-709 refinement),
 * shared by the console server and the console's device control: types, and
 * the plain constant lists they are built from. The console's server-function
 * module and the browser both read this file, so it imports nothing.
 */

/** A setting the Web Push channel depends on. */
export type PushSetting =
  | 'MIMIR_HOSTS'
  | 'MIMIR_PUSH_CONTACT'
  | 'MIMIR_SECRET_KEY'
  | 'MIMIR_SECRET_KEY_FILE'
  | 'MIMIR_URL';

/** What is wrong with that setting; never its value. */
export type PushProblem = 'malformed' | 'missing' | 'not HTTPS' | 'unreadable' | 'unset';

/** One configuration problem: the setting and the problem kind. */
export type PushMisconfiguration = { setting: PushSetting; problem: PushProblem };

/** The states every push server function answers before it touches a table. */
export type PushUnavailable =
  | { state: 'unconfigured' }
  | ({ state: 'misconfigured' } & PushMisconfiguration);

/** The status read: the key a browser subscribes with and the origin a push opens. */
export type PushStatus =
  | PushUnavailable
  | { state: 'key_unusable' }
  | { state: 'ready'; publicKey: string; consoleOrigin: string };

/** Why a subscribe wrote nothing. */
export const PUSH_SUBSCRIBE_REFUSALS = [
  'endpoint_not_allowed',
  'invalid_keys',
  'key_unusable',
  'stale_key',
  'too_many_devices',
  'wrong_origin',
] as const;
export type PushSubscribeRefusal = (typeof PUSH_SUBSCRIBE_REFUSALS)[number];

/** What a subscribe answers. */
export type PushSubscribeResult =
  | PushUnavailable
  | { state: 'subscribed' }
  | { state: PushSubscribeRefusal };

/** A failed push's record: the push service's status, no answer in time, or no answer. */
export type PushFailure = `HTTP ${number}` | 'timeout' | 'unreachable';

/** What a test push answers. */
export type PushSendTestResult =
  | PushUnavailable
  | { state: 'delivered' }
  | { state: 'gone' }
  | { state: 'failed'; failure: PushFailure }
  | { state: 'not_found' }
  | { state: 'stale_key' }
  | { state: 'key_unusable' };

/** The event kinds, in the order ADR 0045's event table lists them; a device may mute any of them. */
export const PUSH_EVENT_KINDS = [
  'delivery_stopped',
  'decisions',
  'task_blocked',
  'task_needs_answers',
] as const;
export type PushEventKind = (typeof PUSH_EVENT_KINDS)[number];

/** The known kinds among `names`, each once, in {@link PUSH_EVENT_KINDS} order. */
export function orderedKinds(names: readonly string[]): PushEventKind[] {
  return PUSH_EVENT_KINDS.filter((kind) => names.includes(kind));
}

/** `muted` with one kind's change applied, the others kept, in {@link PUSH_EVENT_KINDS} order. */
export function withKind(
  muted: readonly PushEventKind[],
  kind: PushEventKind,
  mutedNow: boolean,
): PushEventKind[] {
  const others = muted.filter((name) => name !== kind);
  return orderedKinds(mutedNow ? [...others, kind] : others);
}

/** One subscribed device, without its keys. Times are ISO 8601. */
export type PushDevice = {
  endpoint: string;
  label: string;
  createdAt: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastFailure?: PushFailure;
  /** Whether the row was made for the key the channel signs with now. */
  currentKey: boolean;
  /** The kinds no event push reaches this device for, in {@link PUSH_EVENT_KINDS} order. */
  muted: PushEventKind[];
};

/** What the device list answers, newest first. */
export type PushDeviceList = PushUnavailable | { state: 'listed'; devices: PushDevice[] };

/** What an unsubscribe answers; an endpoint with no row is not an error. */
export type PushUnsubscribeResult = PushUnavailable | { state: 'unsubscribed' };

/** What muting or unmuting one kind on a device answers. */
export type PushSetKindResult = PushUnavailable | { state: 'saved' } | { state: 'not_found' };

/** What a key reset answers: the new public key. */
export type PushResetResult = PushUnavailable | { state: 'reset'; publicKey: string };

import type { SecretKey, ServeConfig } from '@mimir/core';

import { isLoopbackHostname, isSecureOrigin } from './origin-settings';
import type { PushMisconfiguration } from './push-states';
import { readSecretKey, refuseBothSecretKeySettings } from './secret-key-settings';

/**
 * The Web Push channel's settings (ADR 0045, the MMR-709 refinement). Absent
 * without `MIMIR_PUSH_CONTACT`. Set, it carries every problem found, in the
 * refinement's order; none of them refuses startup, and the channel reads
 * `misconfigured` with the first until each is fixed.
 */
export type PushSettings =
  | { enabled: false }
  | {
      enabled: true;
      /** The VAPID subject (`MIMIR_PUSH_CONTACT`); absent when it is malformed. */
      contact: string | undefined;
      /** The console's public origin (`MIMIR_URL`), when set. */
      consoleUrl: string | undefined;
      /** The secret key, when one is usable. */
      key: SecretKey | undefined;
      problems: PushMisconfiguration[];
    };

/** One mail address: a nonempty local part and domain around one `@`, no list, no whitespace. */
const ONE_ADDRESS = /^[^\s,@]+@[^\s,@]+$/;

/** Whether a `mailto:` path names one address; a percent-encoding that does not decode is not one. */
function isOneAddress(path: string): boolean {
  try {
    return ONE_ADDRESS.test(decodeURIComponent(path));
  } catch {
    return false;
  }
}

/** An IPv4 address in 127.0.0.0/8, as the URL parser serializes one. */
const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Whether a parsed hostname names this machine, more broadly than
 * {@link isLoopbackHostname}: with a trailing dot, any `*.localhost` name,
 * any address in 127.0.0.0/8, and 0.0.0.0. Only the contact is held to this.
 */
function isLocalContactHost(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, '');
  return (
    isLoopbackHostname(name) ||
    name.endsWith('.localhost') ||
    LOOPBACK_IPV4.test(name) ||
    name === '0.0.0.0'
  );
}

/**
 * Whether a value is a contact the push services take as the VAPID subject:
 * a `mailto:` URL with one address and no header fields (which could add
 * more), or an `https:` URL whose host does not name this machine.
 */
function isPushContact(value: string): boolean {
  const url = URL.parse(value);
  if (url?.protocol === 'mailto:') {
    return url.search === '' && url.hash === '' && isOneAddress(url.pathname);
  }
  return url?.protocol === 'https:' && !isLocalContactHost(url.hostname);
}

/** The `MIMIR_URL` problem, if any: a push opens it, so it must be set and secure. */
function consoleUrlProblem(url: string | undefined): PushMisconfiguration | undefined {
  if (url === undefined) {
    return { problem: 'unset', setting: 'MIMIR_URL' };
  }
  return isSecureOrigin(url) ? undefined : { problem: 'not HTTPS', setting: 'MIMIR_URL' };
}

/**
 * Read the Web Push settings. Setting both key variables refuses startup, as
 * T3's settings do; with `MIMIR_PUSH_CONTACT` unset the key is otherwise not
 * read. `serve` is the already-validated Host filtering and public origin.
 */
export async function readPushSettings(
  env: NodeJS.ProcessEnv,
  serve: ServeConfig,
): Promise<PushSettings> {
  refuseBothSecretKeySettings(env);
  if (env.MIMIR_PUSH_CONTACT === undefined) {
    return { enabled: false };
  }
  const problems: PushMisconfiguration[] = [];
  const contact = isPushContact(env.MIMIR_PUSH_CONTACT) ? env.MIMIR_PUSH_CONTACT : undefined;
  if (contact === undefined) {
    problems.push({ problem: 'malformed', setting: 'MIMIR_PUSH_CONTACT' });
  }
  const urlProblem = consoleUrlProblem(serve.url);
  if (urlProblem !== undefined) {
    problems.push(urlProblem);
  }
  if (serve.hosts === undefined) {
    problems.push({ problem: 'unset', setting: 'MIMIR_HOSTS' });
  }
  const secret = await readSecretKey(env);
  if ('problem' in secret) {
    problems.push(secret.problem);
  }
  return {
    consoleUrl: serve.url,
    contact,
    enabled: true,
    key: 'key' in secret ? secret.key : undefined,
    problems,
  };
}

/** Whether the channel is set up with no problem, so the notifier sends through it. */
export function isPushReady(settings: PushSettings): boolean {
  return settings.enabled && settings.problems.length === 0;
}

/** The startup warnings for the Web Push settings: each problem's setting and kind, never a value. */
export function pushStartupWarnings(settings: PushSettings): string[] {
  if (!settings.enabled) {
    return [];
  }
  return settings.problems.map(
    ({ problem, setting }) =>
      `⚠ host: Web Push is not set up: ${setting} is ${problem}; the channel stays off until it is fixed`,
  );
}

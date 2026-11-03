import { readFile } from 'node:fs/promises';

import { normalizeServeUrl, parseSecretKey } from '@mimir/core';
import type { SecretKey, ServeConfig } from '@mimir/core';

import type { T3Misconfiguration } from './t3-states';

/**
 * The T3 integration's settings (ADR 0040, ADR 0035's 2026-11-03 addendum).
 * Disabled without `MIMIR_T3_URL`. Enabled, it carries every problem found;
 * none of them refuses startup, and the feature reads `misconfigured` until
 * each is fixed.
 */
export type T3Settings =
  | { enabled: false }
  | {
      enabled: true;
      /** The T3 origin, normalized; absent when `MIMIR_T3_URL` is malformed. */
      url: string | undefined;
      /** The console's public origin (`MIMIR_URL`), when set. */
      consoleUrl: string | undefined;
      /** The secret key, when one is usable. */
      key: SecretKey | undefined;
      problems: T3Misconfiguration[];
    };

/** Names a browser on this machine can reach the console or T3 by. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether a URL hostname is a loopback name. */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/** An origin T3 accepts as a redirect or the console accepts as T3's: HTTPS, or HTTP on loopback. */
function isSecureOrigin(origin: string): boolean {
  const url = new URL(origin);
  return url.protocol === 'https:' || isLoopbackHostname(url.hostname);
}

/**
 * Read the secret key from `MIMIR_SECRET_KEY` or `MIMIR_SECRET_KEY_FILE`; the
 * caller has already refused both. An unreadable file is an unusable key.
 */
async function readSecretKey(
  env: NodeJS.ProcessEnv,
): Promise<{ key: SecretKey } | { problem: T3Misconfiguration }> {
  if (env.MIMIR_SECRET_KEY_FILE !== undefined) {
    let text: string;
    try {
      text = await readFile(env.MIMIR_SECRET_KEY_FILE, 'utf8');
    } catch {
      return { problem: { problem: 'unreadable', setting: 'MIMIR_SECRET_KEY_FILE' } };
    }
    const key = parseSecretKey(text);
    return key === undefined
      ? { problem: { problem: 'malformed', setting: 'MIMIR_SECRET_KEY_FILE' } }
      : { key };
  }
  if (env.MIMIR_SECRET_KEY === undefined) {
    return { problem: { problem: 'missing', setting: 'MIMIR_SECRET_KEY' } };
  }
  const key = parseSecretKey(env.MIMIR_SECRET_KEY);
  return key === undefined
    ? { problem: { problem: 'malformed', setting: 'MIMIR_SECRET_KEY' } }
    : { key };
}

/**
 * Read the T3 settings. Setting both key variables refuses startup, as with
 * the database URL pair, whether or not T3 is enabled; with `MIMIR_T3_URL`
 * unset the key is otherwise not read. `serve` is the already-validated Host
 * filtering and public origin.
 */
export async function readT3Settings(
  env: NodeJS.ProcessEnv,
  serve: ServeConfig,
): Promise<T3Settings> {
  if (env.MIMIR_SECRET_KEY !== undefined && env.MIMIR_SECRET_KEY_FILE !== undefined) {
    throw new Error('MIMIR_SECRET_KEY and MIMIR_SECRET_KEY_FILE cannot both be set');
  }
  if (env.MIMIR_T3_URL === undefined) {
    return { enabled: false };
  }
  const problems: T3Misconfiguration[] = [];
  const origin = normalizeServeUrl(env.MIMIR_T3_URL);
  const url = origin !== undefined && isSecureOrigin(origin) ? origin : undefined;
  if (url === undefined) {
    problems.push({ problem: 'malformed', setting: 'MIMIR_T3_URL' });
  }
  if (serve.hosts === undefined) {
    problems.push({ problem: 'unset', setting: 'MIMIR_HOSTS' });
  }
  const secret = await readSecretKey(env);
  if ('problem' in secret) {
    problems.push(secret.problem);
  }
  if (serve.url !== undefined && !isSecureOrigin(serve.url)) {
    problems.push({ problem: 'not HTTPS', setting: 'MIMIR_URL' });
  }
  return {
    consoleUrl: serve.url,
    enabled: true,
    key: 'key' in secret ? secret.key : undefined,
    problems,
    url,
  };
}

/** The startup warnings for the T3 settings: each problem's setting and kind, never a value. */
export function t3StartupWarnings(settings: T3Settings): string[] {
  if (!settings.enabled) {
    return [];
  }
  return settings.problems.map(
    ({ problem, setting }) =>
      `⚠ host: T3 Code is not set up: ${setting} is ${problem}; the integration stays off until it is fixed`,
  );
}

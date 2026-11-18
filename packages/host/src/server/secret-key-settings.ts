import { readFile } from 'node:fs/promises';

import { parseSecretKey } from '@mimir/core';
import type { SecretKey } from '@mimir/core';

/*
 * The host secret key's settings (ADR 0040), read by whichever enabled
 * integration seals a host secret: T3 and the Web Push channel. The setting
 * and problem types are structural subsets of each integration's own
 * browser-importable misconfiguration type, so a problem found here joins
 * either integration's list unchanged.
 */

/** A setting that carries the secret key. */
export type SecretKeySetting = 'MIMIR_SECRET_KEY' | 'MIMIR_SECRET_KEY_FILE';

/** What is wrong with the secret key's setting; never its value. */
export type SecretKeyProblem = 'malformed' | 'missing' | 'unreadable';

/** One secret key problem: the setting and the problem kind. */
export type SecretKeyMisconfiguration = { setting: SecretKeySetting; problem: SecretKeyProblem };

/**
 * Refuse startup when both key variables are set, as with the database URL
 * pair, whether or not an integration that needs the key is enabled.
 */
export function refuseBothSecretKeySettings(env: NodeJS.ProcessEnv): void {
  if (env.MIMIR_SECRET_KEY !== undefined && env.MIMIR_SECRET_KEY_FILE !== undefined) {
    throw new Error('MIMIR_SECRET_KEY and MIMIR_SECRET_KEY_FILE cannot both be set');
  }
}

/**
 * Read the secret key from `MIMIR_SECRET_KEY` or `MIMIR_SECRET_KEY_FILE`; the
 * caller has already refused both. An unreadable file is an unusable key.
 */
export async function readSecretKey(
  env: NodeJS.ProcessEnv,
): Promise<{ key: SecretKey } | { problem: SecretKeyMisconfiguration }> {
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

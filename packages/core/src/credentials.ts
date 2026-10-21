/**
 * A remote CLI's device credentials (ADR 0038): `credentials.toml` beside
 * `config.toml`, under the same installation authority (ADR 0031). Pairing
 * writes it; every remote run reads it. The token is a bearer secret, so the
 * file is private to its owner and bound to the origin it was issued by.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { urlOrigin } from './config';
import { runtimePaths } from './env';
import { invariant } from './errors';

/** What one pairing grants: a token the host at `origin` issued to `device`. */
export type Credentials = {
  origin: string;
  device: string;
  token: string;
  /** ISO-8601 instant the host issued the token. */
  issuedAt: string;
};

/** Installation-bound path, beside `config.toml`. */
export function credentialsPath(): string {
  return join(runtimePaths().config, 'credentials.toml');
}

/** Any permission bit for group or others: the file is the owner's alone. */
const SHARED_BITS = 0o077;

/**
 * A TOML basic string. JSON's escapes are a subset of TOML's once the two
 * differences are closed: TOML forbids a raw DEL, and it has no escape for a
 * lone surrogate, which becomes U+FFFD.
 */
const tomlString = (value: string): string =>
  JSON.stringify(value.toWellFormed()).replaceAll('\x7f', String.raw`\u007f`);

/**
 * Write the credentials atomically: a private temporary file beside the
 * target, synced, then renamed over it. A reader sees the old file or the new
 * one, never a partial token, and the new file is 0600 whatever the umask.
 */
export function writeCredentials(credentials: Credentials, file: string = credentialsPath()): void {
  const text = [
    `origin = ${tomlString(credentials.origin)}`,
    `device = ${tomlString(credentials.device)}`,
    `token = ${tomlString(credentials.token)}`,
    `issued_at = ${tomlString(credentials.issuedAt)}`,
    '',
  ].join('\n');
  const temporary = join(
    dirname(file),
    `.credentials.toml.${String(process.pid)}.${randomBytes(6).toString('hex')}`,
  );
  // `wx` refuses an existing path, a planted symlink included.
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    try {
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, text);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function credentialsField(parsed: object, key: string): string | undefined {
  const value: unknown = Reflect.get(parsed, key);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Read the credentials for the host at `origin`. Refuses, before any request
 * is sent, a missing or unreadable file, one that group or others can access,
 * and one recorded for another origin. No refusal echoes the token.
 */
export function readCredentials(origin: string, file: string = credentialsPath()): Credentials {
  const pair = `mimir pair ${origin}`;
  if (!existsSync(file)) {
    throw invariant(`no device credentials at ${file}`, pair);
  }
  const mode = statSync(file).mode & 0o777;
  const octal = `0${mode.toString(8).padStart(3, '0')}`;
  if ((mode & SHARED_BITS) !== 0) {
    throw invariant(
      `${file} is accessible to group or others (mode ${octal})`,
      `chmod 600 ${file}`,
    );
  }
  if ((mode & 0o400) === 0) {
    throw invariant(`${file} is not readable by its owner (mode ${octal})`, `chmod 600 ${file}`);
  }
  let parsed: object;
  try {
    parsed = Bun.TOML.parse(readFileSync(file, 'utf8'));
  } catch {
    throw invariant(`${file} is not readable credentials`, pair);
  }
  const recorded = credentialsField(parsed, 'origin');
  const device = credentialsField(parsed, 'device');
  const token = credentialsField(parsed, 'token');
  const issuedAt = credentialsField(parsed, 'issued_at');
  if (
    recorded === undefined ||
    device === undefined ||
    token === undefined ||
    issuedAt === undefined
  ) {
    throw invariant(`${file} is missing origin, device, token, or issued_at`, pair);
  }
  // Compared as origins, so a hand-edited `https://Host/` still matches.
  if (urlOrigin(recorded) !== origin) {
    throw invariant(`${file} holds credentials for ${recorded}, not ${origin}`, pair);
  }
  return { device, issuedAt, origin, token };
}

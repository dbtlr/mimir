import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Sealing for host secrets (ADR 0040): AES-256-GCM under the host's secret
 * key, with the secret's name bound in as additional authenticated data, so a
 * row copied under another name or read as another version fails to open.
 */

const KEY_LENGTH = 32;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const VERSION = 'v1';
const AAD_PREFIX = Buffer.from('mimir.host_secret.v1', 'utf8');
/** 43 characters of one alphabet, then at most one pad: exactly 32 bytes. */
const KEY_TEXT = /^(?:[A-Za-z0-9+/]{43}|[A-Za-z0-9_-]{43})=?$/;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const KEY_LABEL = '[secret key]';

declare const secretKey: unique symbol;

/**
 * The 32-byte secret key, opaque. The bytes live outside the object, so
 * printing, serializing, or inspecting a key shows only a label.
 */
export type SecretKey = {
  readonly [secretKey]: true;
  toString: () => string;
  toJSON: () => string;
};

const keyBytes = new WeakMap<SecretKey, Buffer>();

/**
 * Read a secret key strictly: trim surrounding whitespace, then require 43
 * characters of the base64 or the base64url alphabet (not mixed), optionally
 * followed by one `=`, decoding to exactly 32 bytes. Anything else is
 * undefined.
 */
export function parseSecretKey(text: string): SecretKey | undefined {
  const trimmed = text.trim();
  if (!KEY_TEXT.test(trimmed)) {
    return undefined;
  }
  const bytes = Buffer.from(trimmed, /[-_]/.test(trimmed) ? 'base64url' : 'base64');
  if (bytes.length !== KEY_LENGTH) {
    return undefined;
  }
  const label = Object.freeze({ toJSON: () => KEY_LABEL, toString: () => KEY_LABEL });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the brand exists only at compile time; this is the one place a key is made.
  const key = label as unknown as SecretKey;
  keyBytes.set(key, bytes);
  return key;
}

/**
 * Seal plaintext under the key for the named secret, with a fresh random
 * 12-byte nonce on every call: `v1.<nonce>.<ciphertext and 16-byte tag>`, each
 * part base64url.
 */
export function sealSecret(key: SecretKey, name: string, plaintext: string): string {
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', bytesOf(key), nonce, {
    authTagLength: TAG_LENGTH,
  });
  cipher.setAAD(aadFor(name));
  const body = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `${VERSION}.${nonce.toString('base64url')}.${body.toString('base64url')}`;
}

/**
 * Open what {@link sealSecret} produced for the same key and name. Any failure
 * (a bad shape, another version, another key or name, altered bytes) is
 * undefined; this never throws.
 */
export function openSecret(key: SecretKey, name: string, sealed: string): string | undefined {
  const parts = sealed.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) {
    return undefined;
  }
  const nonce = decodeSegment(parts[1]);
  const body = decodeSegment(parts[2]);
  const bytes = keyBytes.get(key);
  if (
    bytes === undefined ||
    nonce?.length !== NONCE_LENGTH ||
    body === undefined ||
    body.length < TAG_LENGTH
  ) {
    return undefined;
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', bytes, nonce, { authTagLength: TAG_LENGTH });
    decipher.setAAD(aadFor(name));
    decipher.setAuthTag(body.subarray(body.length - TAG_LENGTH));
    const plaintext = Buffer.concat([
      decipher.update(body.subarray(0, body.length - TAG_LENGTH)),
      decipher.final(),
    ]);
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  } catch {
    return undefined;
  }
}

function bytesOf(key: SecretKey): Buffer {
  const bytes = keyBytes.get(key);
  if (bytes === undefined) {
    throw new TypeError('not a secret key from parseSecretKey');
  }
  return bytes;
}

// The name is bound to the ciphertext: the version label, a zero byte, the name.
function aadFor(name: string): Buffer {
  return Buffer.concat([AAD_PREFIX, Buffer.from([0]), Buffer.from(name, 'utf8')]);
}

// Canonical unpadded base64url only, so one sealed value has one spelling.
function decodeSegment(segment: string | undefined): Buffer | undefined {
  if (segment === undefined || !SEGMENT.test(segment)) {
    return undefined;
  }
  const bytes = Buffer.from(segment, 'base64url');
  return bytes.toString('base64url') === segment ? bytes : undefined;
}

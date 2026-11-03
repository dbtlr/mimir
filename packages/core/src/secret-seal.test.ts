import { describe, expect, test } from 'bun:test';
import { createCipheriv, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';

import { openSecret, parseSecretKey, sealSecret } from './secret-seal';
import type { SecretKey } from './secret-seal';

const KEY_BYTES = Buffer.from(Array.from({ length: 32 }, (_, index) => index * 8 + 3));

function keyOf(bytes: Buffer = randomBytes(32)): SecretKey {
  const key = parseSecretKey(bytes.toString('base64url'));
  if (key === undefined) {
    throw new Error('a 32-byte base64url key must parse');
  }
  return key;
}

/** Flip one bit of the decoded bytes of a sealed segment, keeping its encoding. */
function flipSegment(sealed: string, segment: 1 | 2, at: number): string {
  const parts = sealed.split('.');
  const bytes = Buffer.from(parts[segment] ?? '', 'base64url');
  bytes[at] = (bytes[at] ?? 0) ^ 0x01;
  parts[segment] = bytes.toString('base64url');
  return parts.join('.');
}

describe('parseSecretKey', () => {
  test('accepts a 32-byte key in base64 or base64url, padded or not, around surrounding whitespace', () => {
    // These bytes encode with '+' and '/' in base64, so the two alphabets differ.
    const bytes = Buffer.alloc(32, 251);
    const base64 = bytes.toString('base64');
    const base64url = bytes.toString('base64url');
    expect(base64).toContain('+');
    expect(base64url).toContain('-');
    for (const text of [
      base64,
      base64.replace(/=$/, ''),
      base64url,
      `${base64url}=`,
      `  ${base64}\n`,
      `\t${base64url}\r\n`,
    ]) {
      const key = parseSecretKey(text);
      expect(key).toBeDefined();
      if (key !== undefined) {
        const sealed = sealSecret(key, 'n', 'value');
        expect(openSecret(keyOf(bytes), 'n', sealed)).toBe('value');
      }
    }
  });

  test('refuses a key that does not decode to exactly 32 bytes', () => {
    for (const length of [0, 16, 31, 33, 48]) {
      const bytes = randomBytes(length);
      expect(parseSecretKey(bytes.toString('base64'))).toBeUndefined();
      expect(parseSecretKey(bytes.toString('base64url'))).toBeUndefined();
    }
  });

  test('refuses mixed alphabets, inner whitespace, two pads, and stray characters', () => {
    const base64url = Buffer.alloc(32, 251).toString('base64url');
    const mixed = `+${base64url.slice(1)}`;
    expect(mixed).toContain('-');
    for (const text of [
      mixed,
      `${base64url.slice(0, 20)} ${base64url.slice(20)}`,
      `${base64url.slice(0, 20)}\n${base64url.slice(21)}`,
      `${base64url}==`,
      `${base64url.slice(0, 42)}.`,
      `${base64url.slice(0, 42)}=`,
      `=${base64url}`,
      '',
      '   ',
    ]) {
      expect(parseSecretKey(text)).toBeUndefined();
    }
  });

  test('a parsed key never prints its bytes', () => {
    const key = keyOf(KEY_BYTES);
    const hex = KEY_BYTES.toString('hex');
    const encodings = [KEY_BYTES.toString('base64'), KEY_BYTES.toString('base64url'), hex];
    for (const printed of [
      String(key),
      JSON.stringify(key),
      JSON.stringify({ key }),
      inspect(key, { depth: 10, showHidden: true }),
      Object.keys(key).join(','),
    ]) {
      for (const encoding of encodings) {
        expect(printed).not.toContain(encoding);
      }
      expect(printed).not.toMatch(/Buffer|Uint8Array/);
    }
  });
});

/**
 * Seal bytes the way the format documents, independently of sealSecret:
 * AES-256-GCM, AAD `mimir.host_secret.v1\0<name>`, `v1.<nonce>.<ciphertext+tag>`.
 */
function sealBytes(key: Buffer, nonce: Buffer, name: string, plaintext: Buffer): string {
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`mimir.host_secret.v1\0${name}`, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return `v1.${nonce.toString('base64url')}.${body.toString('base64url')}`;
}

const KNOWN_NONCE = Buffer.from('000102030405060708090a0b', 'hex');
/** `{"accessToken":"kat"}` sealed as `t3.oauth` under KEY_BYTES with KNOWN_NONCE. */
const KNOWN_SEALED = 'v1.AAECAwQFBgcICQoL.mpVToQtgSGaCdDp-IIRcity4sz-rQTiQsQvpGeB--NIBbq58HA';

/** The decoded bytes of a sealed value's ciphertext segment. */
const bodyOf = (sealed: string) => Buffer.from(sealed.split('.')[2] ?? '', 'base64url');

describe('the sealed format', () => {
  test('a known-answer vector opens to its plaintext', () => {
    const plaintext = '{"accessToken":"kat"}';
    expect(sealBytes(KEY_BYTES, KNOWN_NONCE, 't3.oauth', Buffer.from(plaintext))).toBe(
      KNOWN_SEALED,
    );
    expect(openSecret(keyOf(KEY_BYTES), 't3.oauth', KNOWN_SEALED)).toBe(plaintext);
  });

  test('a segment spelled other than canonical base64url opens to nothing', () => {
    // The body is 37 bytes, so its last character carries four unused bits.
    const respelled = `${KNOWN_SEALED.slice(0, -1)}B`;
    expect(bodyOf(respelled)).toEqual(bodyOf(KNOWN_SEALED));
    expect(openSecret(keyOf(KEY_BYTES), 't3.oauth', respelled)).toBeUndefined();
  });

  test('a seal whose plaintext is not UTF-8 opens to nothing', () => {
    // `{`, a two-byte sequence broken in its second byte, then `}`.
    const sealed = sealBytes(KEY_BYTES, KNOWN_NONCE, 'n', Buffer.from('7bc3287d', 'hex'));
    expect(openSecret(keyOf(KEY_BYTES), 'n', sealed)).toBeUndefined();
    const valid = sealBytes(KEY_BYTES, KNOWN_NONCE, 'n', Buffer.from('{}'));
    expect(openSecret(keyOf(KEY_BYTES), 'n', valid)).toBe('{}');
  });
});

describe('sealSecret and openSecret', () => {
  test('a sealed value opens under the same key and name', () => {
    const key = keyOf();
    for (const plaintext of ['', 'access-token', '{"refresh":"r","expires":1}', 'snow ☃ 雪']) {
      const sealed = sealSecret(key, 't3.oauth', plaintext);
      expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
      expect(sealed).not.toContain(plaintext === '' ? '\u0000' : plaintext);
      expect(openSecret(key, 't3.oauth', sealed)).toBe(plaintext);
    }
  });

  test('the ciphertext segment carries the plaintext length plus a 16-byte tag', () => {
    const sealed = sealSecret(keyOf(), 'n', 'twelve bytes');
    const [, nonce, body] = sealed.split('.');
    expect(Buffer.from(nonce ?? '', 'base64url')).toHaveLength(12);
    expect(Buffer.from(body ?? '', 'base64url')).toHaveLength(12 + 16);
  });

  test('two seals of the same input differ', () => {
    const key = keyOf();
    const first = sealSecret(key, 'n', 'same');
    const second = sealSecret(key, 'n', 'same');
    expect(first).not.toBe(second);
    expect(first.split('.')[1]).not.toBe(second.split('.')[1]);
    expect(openSecret(key, 'n', first)).toBe('same');
    expect(openSecret(key, 'n', second)).toBe('same');
  });

  test('a seal opens to nothing under another key or another name', () => {
    const key = keyOf();
    const sealed = sealSecret(key, 't3.oauth', 'value');
    expect(openSecret(keyOf(), 't3.oauth', sealed)).toBeUndefined();
    expect(openSecret(key, 't3.oauth2', sealed)).toBeUndefined();
    expect(openSecret(key, 't3', sealed)).toBeUndefined();
    expect(openSecret(key, '', sealed)).toBeUndefined();
  });

  test('an altered, truncated, or misshapen seal opens to nothing and never throws', () => {
    const key = keyOf();
    const sealed = sealSecret(key, 'n', 'a value long enough to alter');
    const [, nonce = '', body = ''] = sealed.split('.');
    const bodyLength = Buffer.from(body, 'base64url').length;
    const altered = [
      flipSegment(sealed, 1, 0),
      flipSegment(sealed, 1, 11),
      flipSegment(sealed, 2, 0),
      flipSegment(sealed, 2, bodyLength - 17),
      flipSegment(sealed, 2, bodyLength - 1),
      sealed.slice(0, -1),
      sealed.slice(0, -4),
      `v1.${nonce}.${Buffer.from(body, 'base64url')
        .subarray(0, bodyLength - 16)
        .toString('base64url')}`,
      `v1.${nonce.slice(0, -2)}.${body}`,
      `v1.${nonce}.`,
      `v1.${nonce}`,
      `v1..${body}`,
      'v1',
      '',
      sealed.replace(/^v1\./, 'v2.'),
      sealed.replace(/^v1\./, 'V1.'),
      sealed.replace(/^v1\./, ''),
      `${sealed}.extra`,
      `${sealed}.`,
      `v1.${nonce}.${body}=`,
      `v1.${nonce}.${body.slice(0, 4)}+${body.slice(5)}`,
      `v1.${nonce}.${body.slice(0, 4)} ${body.slice(4)}`,
      ` ${sealed}`,
    ];
    for (const candidate of altered) {
      expect(candidate).not.toBe(sealed);
      expect(openSecret(key, 'n', candidate)).toBeUndefined();
    }
  });
});

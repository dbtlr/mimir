import { describe, expect, test } from 'bun:test';

import { decryptPushBody, makeBrowserKeys, readBodyHeader, verifyJwt } from './push-fixtures';
import {
  PUSH_PLAINTEXT_LIMIT,
  buildPushRequest,
  encryptPushPayload,
  generateVapidKeys,
  isUsableSubscriptionKeys,
  readVapidKeys,
  vapidJwt,
} from './push-protocol';

const encoder = new TextEncoder();
const bytes = (text: string) => Buffer.from(text, 'base64url');
const ENDPOINT = 'https://web.push.apple.com/QGuQyavXutnMH4Hp2s';
const CONTACT = 'mailto:operator@example.net';
const NOW = Date.parse('2026-11-18T12:00:00.000Z');

describe('the test decryptor', () => {
  test('decrypts the RFC 8291 Appendix A example', async () => {
    const uaPublic =
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
    const point = bytes(uaPublic);
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      {
        crv: 'P-256',
        d: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
        kty: 'EC',
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33, 65).toString('base64url'),
      },
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    );
    const body = bytes(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
    const browser = { auth: 'BTBZMqHH6r4Tts7J_aSIgg', p256dh: uaPublic, privateKey };
    expect(await decryptPushBody(body, browser)).toBe('When I grow up, I want to be a watermelon');
  });
});

describe('encryptPushPayload', () => {
  test('a browser decrypts the body to the payload', async () => {
    const browser = await makeBrowserKeys();
    const payload = '{"web_push":8030,"notification":{"title":"Décision ✓"}}';
    const body = await encryptPushPayload(browser, encoder.encode(payload));
    expect(await decryptPushBody(body, browser)).toBe(payload);
  });

  test('writes one record with a 4096-byte record size and the sender key as key id', async () => {
    const browser = await makeBrowserKeys();
    const body = await encryptPushPayload(browser, encoder.encode('hello'));
    const header = readBodyHeader(body);
    expect(header.recordSize).toBe(4096);
    expect(header.keyId).toHaveLength(65);
    expect(header.keyId[0]).toBe(4);
    // The payload, its delimiter, and the 16-byte tag.
    expect(header.records).toHaveLength(5 + 1 + 16);
  });

  test('uses a fresh salt and sender key on every push', async () => {
    const browser = await makeBrowserKeys();
    const first = readBodyHeader(await encryptPushPayload(browser, encoder.encode('a')));
    const second = readBodyHeader(await encryptPushPayload(browser, encoder.encode('a')));
    expect(first.salt).not.toEqual(second.salt);
    expect(first.keyId).not.toEqual(second.keyId);
  });

  test('fills a 4096-byte body at the plaintext limit and refuses one byte more', async () => {
    const browser = await makeBrowserKeys();
    const largest = 'x'.repeat(PUSH_PLAINTEXT_LIMIT);
    const body = await encryptPushPayload(browser, encoder.encode(largest));
    expect(body).toHaveLength(4096);
    expect(await decryptPushBody(body, browser)).toBe(largest);
    // oxlint-disable-next-line typescript/await-thenable -- Bun awaits async matchers at runtime.
    await expect(encryptPushPayload(browser, encoder.encode(`${largest}x`))).rejects.toThrow(
      RangeError,
    );
  });
});

describe('generateVapidKeys', () => {
  test('answers a raw uncompressed public point and the private scalar, unpadded base64url', async () => {
    const keys = await generateVapidKeys();
    expect(keys.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(bytes(keys.publicKey)[0]).toBe(4);
    expect(keys.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await generateVapidKeys()).not.toEqual(keys);
  });
});

describe('readVapidKeys', () => {
  test('answers a stored pair that signs for its public key', async () => {
    const keys = await generateVapidKeys();
    expect(await readVapidKeys(structuredClone(keys))).toEqual(keys);
  });

  test('refuses a value that is not a valid pair', async () => {
    const keys = await generateVapidKeys();
    const other = await generateVapidKeys();
    for (const value of [
      null,
      'text',
      {},
      { publicKey: keys.publicKey },
      { privateKey: keys.privateKey, publicKey: 7 },
      { privateKey: other.privateKey, publicKey: keys.publicKey },
      { privateKey: keys.privateKey, publicKey: keys.publicKey.slice(1) },
      { privateKey: 'AAAA', publicKey: keys.publicKey },
    ]) {
      expect(await readVapidKeys(value)).toBeUndefined();
    }
  });
});

describe('vapidJwt', () => {
  test('signs ES256 claims for the endpoint origin, twelve hours ahead, with the contact', async () => {
    const keys = await generateVapidKeys();
    const jwt = await vapidJwt({ contact: CONTACT, endpoint: ENDPOINT, now: NOW, vapid: keys });
    const { claims, header } = await verifyJwt(jwt, keys.publicKey);
    expect(header).toEqual({ alg: 'ES256', typ: 'JWT' });
    expect(claims).toEqual({
      aud: 'https://web.push.apple.com',
      exp: Date.parse('2026-11-19T00:00:00.000Z') / 1000,
      sub: CONTACT,
    });
  });

  test('takes whole seconds from the clock', async () => {
    const keys = await generateVapidKeys();
    const jwt = await vapidJwt({
      contact: CONTACT,
      endpoint: ENDPOINT,
      now: NOW + 999,
      vapid: keys,
    });
    const { claims } = await verifyJwt(jwt, keys.publicKey);
    expect(claims).toMatchObject({ exp: Date.parse('2026-11-19T00:00:00.000Z') / 1000 });
  });
});

describe('buildPushRequest', () => {
  test('carries exactly the push headers and a body the browser decrypts', async () => {
    const vapid = await generateVapidKeys();
    const browser = await makeBrowserKeys();
    const request = await buildPushRequest({
      contact: CONTACT,
      endpoint: ENDPOINT,
      keys: browser,
      now: NOW,
      payload: encoder.encode('{"web_push":8030}'),
      vapid,
    });
    expect(request.endpoint).toBe(ENDPOINT);
    const { Authorization: authorization, ...rest } = request.headers;
    expect(rest).toEqual({
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'high',
    });
    const match = /^vapid t=([^,]+), k=([A-Za-z0-9_-]+)$/.exec(authorization ?? '');
    expect(match?.[2]).toBe(vapid.publicKey);
    const { claims } = await verifyJwt(match?.[1] ?? '', vapid.publicKey);
    expect(claims).toMatchObject({ aud: 'https://web.push.apple.com', sub: CONTACT });
    expect(await decryptPushBody(request.body, browser)).toBe('{"web_push":8030}');
  });
});

describe('isUsableSubscriptionKeys', () => {
  test('accepts a browser P-256 point and a 16-byte auth secret', async () => {
    const { auth, p256dh } = await makeBrowserKeys();
    expect(await isUsableSubscriptionKeys({ auth, p256dh })).toBe(true);
  });

  test('refuses an auth secret that is not 16 bytes, or not base64url', async () => {
    const { p256dh } = await makeBrowserKeys();
    for (const length of [0, 15, 17, 32]) {
      const auth = Buffer.alloc(length, 1).toString('base64url');
      expect(await isUsableSubscriptionKeys({ auth, p256dh })).toBe(false);
    }
    const auth = Buffer.alloc(16, 1).toString('base64url');
    expect(await isUsableSubscriptionKeys({ auth: `${auth}!`, p256dh })).toBe(false);
    expect(await isUsableSubscriptionKeys({ auth: auth.replace('A', '+'), p256dh })).toBe(false);
  });

  test('refuses a public key that is not a raw uncompressed P-256 point', async () => {
    const { auth, p256dh } = await makeBrowserKeys();
    const point = bytes(p256dh);
    const offCurve = Buffer.from(point);
    offCurve[64]! ^= 1;
    const compressed = Buffer.concat([Buffer.from([2 + (point[64]! & 1)]), point.subarray(1, 33)]);
    for (const key of [
      '',
      'not base64url!',
      point.subarray(0, 64).toString('base64url'),
      Buffer.concat([point, Buffer.from([0])]).toString('base64url'),
      offCurve.toString('base64url'),
      compressed.toString('base64url'),
      Buffer.concat([Buffer.from([5]), point.subarray(1)]).toString('base64url'),
    ]) {
      expect(await isUsableSubscriptionKeys({ auth, p256dh: key })).toBe(false);
    }
  });
});

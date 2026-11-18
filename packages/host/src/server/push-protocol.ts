/*
 * The Web Push wire protocol (ADR 0045, the MMR-709 refinement), on WebCrypto
 * alone: RFC 8291 `aes128gcm` message encryption and RFC 8292 VAPID (ES256).
 * It builds a request; the caller sends it. The VAPID private scalar never
 * leaves this module's callers' memory and appears in no error or log.
 */

const subtle = crypto.subtle;
const encoder = new TextEncoder();

/** A VAPID key pair: the raw uncompressed P-256 point, and the private scalar `d`, both unpadded base64url. */
export type VapidKeys = { publicKey: string; privateKey: string };

/** A browser subscription's keys, as `PushSubscription.toJSON` names them, base64url. */
export type SubscriptionKeys = { p256dh: string; auth: string };

/** The record size the body declares (RFC 8188); one record carries the whole payload. */
const RECORD_SIZE = 4096;
/** The largest body a push service must accept (RFC 8291 section 4). */
const BODY_LIMIT = 4096;
/** The body header: salt (16), record size (4), key id length (1), and the sender's 65-byte point. */
const HEADER_LENGTH = 16 + 4 + 1 + 65;
/** The last-record delimiter and the AES-GCM tag. */
const RECORD_OVERHEAD = 1 + 16;
/**
 * The longest plaintext one push carries: 3993 bytes, so the whole body is at
 * most 4096 bytes and its one record well within its declared size.
 */
export const PUSH_PLAINTEXT_LIMIT = BODY_LIMIT - HEADER_LENGTH - RECORD_OVERHEAD;

/** How long a VAPID JWT is good for. Apple refuses an `exp` more than a day ahead. */
const JWT_LIFETIME_SECONDS = 12 * 60 * 60;

/** A push service holds an undelivered push for a day. */
const PUSH_TTL_SECONDS = 86_400;

const P256_POINT_LENGTH = 65;
const P256_SCALAR_LENGTH = 32;
const AUTH_SECRET_LENGTH = 16;
const UNCOMPRESSED_POINT = 4;

const BASE64URL = /^[A-Za-z0-9_-]*$/;

const toBase64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

/**
 * Decode base64url strictly: the URL-safe alphabet with optional padding, and
 * only the canonical encoding of its bytes. Anything else is undefined.
 */
function fromBase64url(text: string): Uint8Array<ArrayBuffer> | undefined {
  const unpadded = text.replace(/={1,2}$/, '');
  if (!BASE64URL.test(unpadded)) {
    return undefined;
  }
  const decoded = Buffer.from(unpadded, 'base64url');
  return decoded.toString('base64url') === unpadded ? new Uint8Array(decoded) : undefined;
}

/** A raw uncompressed P-256 point's bytes, or undefined when the text is not one by shape. */
function pointBytes(text: string): Uint8Array<ArrayBuffer> | undefined {
  const bytes = fromBase64url(text);
  return bytes?.length === P256_POINT_LENGTH && bytes[0] === UNCOMPRESSED_POINT ? bytes : undefined;
}

const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Buffer.concat(parts));

async function hkdf(
  ikm: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await subtle.deriveBits({ hash: 'SHA-256', info, name: 'HKDF', salt }, key, length * 8),
  );
}

/** Import a raw point as an ECDH public key; rejects a point not on the curve. */
const importEcdhPublic = (point: Uint8Array<ArrayBuffer>): Promise<CryptoKey> =>
  subtle.importKey('raw', point, { name: 'ECDH', namedCurve: 'P-256' }, false, []);

/** Import a VAPID pair's private half for signing. */
function importSigningKey(point: Uint8Array, privateKey: string): Promise<CryptoKey> {
  const jwk: JsonWebKey = {
    crv: 'P-256',
    d: privateKey,
    kty: 'EC',
    x: toBase64url(point.subarray(1, 33)),
    y: toBase64url(point.subarray(33, 65)),
  };
  return subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** Make a new VAPID key pair. */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const point = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const { d } = await subtle.exportKey('jwk', pair.privateKey);
  if (d === undefined) {
    throw new Error('the generated VAPID key exported no private scalar');
  }
  return { privateKey: d, publicKey: toBase64url(point) };
}

/**
 * Read a stored VAPID pair: an object whose `publicKey` is a raw P-256 point
 * and whose `privateKey` is a 32-byte scalar that signs for that point.
 * Anything else is undefined.
 */
export async function readVapidKeys(value: unknown): Promise<VapidKeys | undefined> {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('publicKey' in value) ||
    !('privateKey' in value)
  ) {
    return undefined;
  }
  const { privateKey, publicKey } = value;
  if (typeof publicKey !== 'string' || typeof privateKey !== 'string') {
    return undefined;
  }
  const point = pointBytes(publicKey);
  if (point === undefined || fromBase64url(privateKey)?.length !== P256_SCALAR_LENGTH) {
    return undefined;
  }
  try {
    const signing = await importSigningKey(point, privateKey);
    const verifying = await subtle.importKey(
      'raw',
      point,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const probe = encoder.encode('mimir vapid pair');
    const algorithm = { hash: 'SHA-256', name: 'ECDSA' };
    const signature = await subtle.sign(algorithm, signing, probe);
    return (await subtle.verify(algorithm, verifying, signature, probe))
      ? { privateKey, publicKey }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a subscription's keys are usable: `p256dh` decodes to a raw
 * uncompressed point on P-256, and `auth` to exactly 16 bytes.
 */
export async function isUsableSubscriptionKeys(keys: SubscriptionKeys): Promise<boolean> {
  const point = pointBytes(keys.p256dh);
  if (point === undefined || fromBase64url(keys.auth)?.length !== AUTH_SECRET_LENGTH) {
    return false;
  }
  try {
    await importEcdhPublic(point);
    return true;
  } catch {
    return false;
  }
}

/** Decode keys the caller has validated; a failure here is a programming error. */
function subscriptionBytes(keys: SubscriptionKeys) {
  const point = pointBytes(keys.p256dh);
  const auth = fromBase64url(keys.auth);
  if (point === undefined || auth?.length !== AUTH_SECRET_LENGTH) {
    throw new TypeError('the subscription keys are not usable');
  }
  return { auth, point };
}

/**
 * Encrypt a payload for a subscription (RFC 8291): the whole `aes128gcm`
 * body, its header and one record. A payload over
 * {@link PUSH_PLAINTEXT_LIMIT} bytes is refused with a `RangeError`.
 */
export async function encryptPushPayload(
  keys: SubscriptionKeys,
  plaintext: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.length > PUSH_PLAINTEXT_LIMIT) {
    throw new RangeError(
      `a push payload is at most ${String(PUSH_PLAINTEXT_LIMIT)} bytes, not ${String(plaintext.length)}`,
    );
  }
  const browser = subscriptionBytes(keys);
  const browserKey = await importEcdhPublic(browser.point);
  const sender = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const senderPoint = new Uint8Array(await subtle.exportKey('raw', sender.publicKey));
  const shared = new Uint8Array(
    await subtle.deriveBits({ name: 'ECDH', public: browserKey }, sender.privateKey, 256),
  );
  const keyInfo = concat(encoder.encode('WebPush: info\0'), browser.point, senderPoint);
  const ikm = await hkdf(shared, browser.auth, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, encoder.encode('Content-Encoding: nonce\0'), 12);
  const aesKey = await subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const record = concat(plaintext, new Uint8Array([2])); // 2: the last record's delimiter
  const cipher = new Uint8Array(
    await subtle.encrypt({ iv: nonce, name: 'AES-GCM' }, aesKey, record),
  );
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, RECORD_SIZE);
  return concat(salt, recordSize, new Uint8Array([senderPoint.length]), senderPoint, cipher);
}

/** What signs a VAPID JWT: the endpoint it is for, the pair, the contact, and the clock's now (ms). */
export type VapidJwtInput = { endpoint: string; vapid: VapidKeys; contact: string; now: number };

/**
 * The VAPID JWT (RFC 8292, ES256): `aud` the endpoint's origin, `exp` twelve
 * hours after `now`, and `sub` the contact.
 */
export async function vapidJwt({ contact, endpoint, now, vapid }: VapidJwtInput): Promise<string> {
  const point = pointBytes(vapid.publicKey);
  if (point === undefined) {
    throw new TypeError('the VAPID public key is not a raw P-256 point');
  }
  const key = await importSigningKey(point, vapid.privateKey);
  const part = (value: object) => toBase64url(encoder.encode(JSON.stringify(value)));
  const claims = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + JWT_LIFETIME_SECONDS,
    sub: contact,
  };
  const input = `${part({ alg: 'ES256', typ: 'JWT' })}.${part(claims)}`;
  // WebCrypto's ECDSA signature is the raw r || s that ES256 takes.
  const signature = await subtle.sign(
    { hash: 'SHA-256', name: 'ECDSA' },
    key,
    encoder.encode(input),
  );
  return `${input}.${toBase64url(new Uint8Array(signature))}`;
}

/** One push, ready to `POST`: the endpoint, its headers, and the encrypted body. */
export type PushRequest = {
  endpoint: string;
  headers: Record<string, string>;
  body: Uint8Array<ArrayBuffer>;
};

/** What a push is built from: the subscription, the payload's bytes, and the signer. */
export type PushRequestInput = VapidJwtInput & { keys: SubscriptionKeys; payload: Uint8Array };

/** Build one push: the payload encrypted for the keys, signed for the endpoint. No `Topic` is sent. */
export async function buildPushRequest(input: PushRequestInput): Promise<PushRequest> {
  const body = await encryptPushPayload(input.keys, input.payload);
  const jwt = await vapidJwt(input);
  return {
    body,
    endpoint: input.endpoint,
    headers: {
      Authorization: `vapid t=${jwt}, k=${input.vapid.publicKey}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(PUSH_TTL_SECONDS),
      Urgency: 'high',
    },
  };
}

/*
 * Test-only stand-ins for a browser's side of Web Push: a subscription's key
 * pair and auth secret, and the RFC 8291 decryption a browser performs. The
 * channel itself only encrypts.
 */

const subtle = crypto.subtle;
const encoder = new TextEncoder();

const fromBase64url = (text: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Buffer.from(text, 'base64url'));
const toBase64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

/** A browser's subscription keys, with the private half a real browser keeps to itself. */
export type BrowserKeys = { p256dh: string; auth: string; privateKey: CryptoKey };

/** Make a browser's P-256 key pair and 16-byte auth secret, as `PushSubscription.toJSON` names them. */
export async function makeBrowserKeys(): Promise<BrowserKeys> {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const publicKey = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return {
    auth: toBase64url(crypto.getRandomValues(new Uint8Array(16))),
    p256dh: toBase64url(publicKey),
    privateKey: pair.privateKey,
  };
}

async function hkdf(
  ikm: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  bytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await subtle.deriveBits({ hash: 'SHA-256', info, name: 'HKDF', salt }, key, bytes * 8),
  );
}

const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Buffer.concat(parts));

/** The parts of an `aes128gcm` body's header (RFC 8188 section 2.1). */
export function readBodyHeader(body: Uint8Array): {
  salt: Uint8Array<ArrayBuffer>;
  recordSize: number;
  keyId: Uint8Array<ArrayBuffer>;
  records: Uint8Array<ArrayBuffer>;
} {
  const idLength = body[20]!;
  return {
    keyId: new Uint8Array(body.slice(21, 21 + idLength)),
    recordSize: new DataView(body.buffer, body.byteOffset).getUint32(16),
    records: new Uint8Array(body.slice(21 + idLength)),
    salt: new Uint8Array(body.slice(0, 16)),
  };
}

/**
 * Decrypt a one-record `aes128gcm` push body as the browser would (RFC 8291
 * section 3), and strip its padding up to the last-record delimiter.
 */
export async function decryptPushBody(body: Uint8Array, browser: BrowserKeys): Promise<string> {
  const { keyId: senderPublic, records, salt } = readBodyHeader(body);
  const browserPublic = fromBase64url(browser.p256dh);
  const senderKey = await subtle.importKey(
    'raw',
    senderPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = new Uint8Array(
    await subtle.deriveBits({ name: 'ECDH', public: senderKey }, browser.privateKey, 256),
  );
  const info = concat(encoder.encode('WebPush: info\0'), browserPublic, senderPublic);
  const ikm = await hkdf(shared, fromBase64url(browser.auth), info, 32);
  const cek = await hkdf(ikm, salt, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, encoder.encode('Content-Encoding: nonce\0'), 12);
  const aesKey = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const padded = new Uint8Array(
    await subtle.decrypt({ iv: nonce, name: 'AES-GCM' }, aesKey, records),
  );
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) {
    end -= 1;
  }
  if (padded[end] !== 2) {
    throw new Error('the record has no last-record delimiter');
  }
  return new TextDecoder().decode(padded.slice(0, end));
}

const jsonPart = (part: string): unknown => JSON.parse(Buffer.from(part, 'base64url').toString());

/** Verify a compact ES256 JWT with a raw public key, and answer its header and claims. */
export async function verifyJwt(
  jwt: string,
  publicKey: string,
): Promise<{ header: unknown; claims: unknown }> {
  const [header, claims, signature] = jwt.split('.');
  if (header === undefined || claims === undefined || signature === undefined) {
    throw new Error('not a compact JWT');
  }
  const key = await subtle.importKey(
    'raw',
    fromBase64url(publicKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const valid = await subtle.verify(
    { hash: 'SHA-256', name: 'ECDSA' },
    key,
    fromBase64url(signature),
    encoder.encode(`${header}.${claims}`),
  );
  if (!valid) {
    throw new Error('the JWT signature does not verify');
  }
  return { claims: jsonPart(claims), header: jsonPart(header) };
}

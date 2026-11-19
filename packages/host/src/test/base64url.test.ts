import { describe, expect, it } from 'vitest';

import { decodeBase64Url, encodeBase64Url } from '../lib/base64url';

describe('base64url', () => {
  it('round-trips bytes unpadded and URL-safe', () => {
    const bytes = new Uint8Array([251, 255, 191, 0, 1]);
    const text = encodeBase64Url(bytes);
    expect(text).toBe('-_-_AAE');
    expect(decodeBase64Url(text)).toStrictEqual(bytes);
  });

  it('encodes a buffer like its bytes', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(encodeBase64Url(bytes.buffer)).toBe(encodeBase64Url(bytes));
  });
});

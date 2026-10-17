import { describe, expect, test } from 'bun:test';

import { acceptedHosts, isHostName, normalizeServeUrl } from './address';

/** `MIMIR_HOSTS` and `MIMIR_URL`: the Host names the host answers and its public origin. */

describe('normalizeServeUrl', () => {
  test('keeps an http or https origin, dropping a bare trailing slash', () => {
    expect(normalizeServeUrl('https://box.tailnet.ts.net/')).toBe('https://box.tailnet.ts.net');
    expect(normalizeServeUrl('http://192.168.1.10:64647')).toBe('http://192.168.1.10:64647');
    expect(normalizeServeUrl('HTTPS://Mimir.Example')).toBe('https://mimir.example');
  });

  test('refuses other schemes, paths, queries, fragments, credentials, and non-URLs', () => {
    for (const bad of [
      'ftp://box',
      'https://box/mimir',
      'https://box/?a=1',
      'https://box/#x',
      'https://u:p@box',
      'box.tailnet.ts.net',
      '',
      7,
    ]) {
      expect(normalizeServeUrl(bad)).toBeUndefined();
    }
  });
});

describe('acceptedHosts', () => {
  test('without hosts, url does not turn the Host check on', () => {
    expect(acceptedHosts({ url: 'https://box.tailnet.ts.net' })).toBeUndefined();
    expect(acceptedHosts({})).toBeUndefined();
  });

  test("with hosts, url's host joins them", () => {
    expect(acceptedHosts({ hosts: ['box'], url: 'https://box.tailnet.ts.net:8443' })).toEqual([
      'box',
      'box.tailnet.ts.net',
    ]);
    expect(acceptedHosts({ hosts: [], url: 'http://[fd7a::1]:64647' })).toEqual(['[fd7a::1]']);
    expect(acceptedHosts({ hosts: ['box'] })).toEqual(['box']);
  });
});

describe('isHostName', () => {
  test('accepts bare hostnames and bracketed IPv6 literals', () => {
    for (const ok of ['localhost', 'box.tailnet.ts.net', '192.168.1.10', '[fd7a::1]']) {
      expect(isHostName(ok)).toBe(true);
    }
  });

  test('refuses a port, a scheme, a path, an unbracketed IPv6 literal, and non-strings', () => {
    for (const bad of ['box:8080', 'https://box', 'box/path', 'fd7a::1', '', 5]) {
      expect(isHostName(bad)).toBe(false);
    }
  });
});

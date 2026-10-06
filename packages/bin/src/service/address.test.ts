import { describe, expect, test } from 'bun:test';

import type { NetworkInterfaceInfo } from 'node:os';

import {
  acceptedHosts,
  consoleUrl,
  isBindAddress,
  isLocalAddress,
  listenUrl,
  normalizeServeUrl,
  probeHost,
} from './address';

/** `[serve] bind` and `[serve] url` (MMR-433): where serve listens, and the address it hands out. */

describe('isBindAddress', () => {
  test('accepts IPv4 and IPv6 literals, wildcards included', () => {
    for (const ok of ['127.0.0.1', '0.0.0.0', '100.64.1.2', '::', '::1', 'fd7a:115c:a1e0::1']) {
      expect(isBindAddress(ok)).toBe(true);
    }
  });

  test('refuses hostnames, bracketed or ported literals, and non-strings', () => {
    for (const bad of ['localhost', 'box.tailnet.ts.net', '[::1]', '127.0.0.1:80', '', 5]) {
      expect(isBindAddress(bad)).toBe(false);
    }
  });
});

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

describe('probeHost', () => {
  test('loopback and wildcard binds are probed over loopback', () => {
    expect(probeHost(undefined)).toBe('127.0.0.1');
    expect(probeHost('127.0.0.1')).toBe('127.0.0.1');
    expect(probeHost('0.0.0.0')).toBe('127.0.0.1');
    expect(probeHost('::')).toBe('[::1]');
  });

  test('a specific address is probed at that address, IPv6 bracketed', () => {
    expect(probeHost('100.64.1.2')).toBe('100.64.1.2');
    expect(probeHost('::1')).toBe('[::1]');
    expect(probeHost('fd7a:115c:a1e0::1')).toBe('[fd7a:115c:a1e0::1]');
  });
});

test('listenUrl names the bound address, loopback by default', () => {
  expect(listenUrl(undefined, 64647)).toBe('http://127.0.0.1:64647');
  expect(listenUrl('0.0.0.0', 64647)).toBe('http://0.0.0.0:64647');
  expect(listenUrl('::', 64647)).toBe('http://[::]:64647');
});

test('consoleUrl prefers the configured url over the bound address', () => {
  expect(consoleUrl({ url: 'https://box.tailnet.ts.net' }, 64647)).toBe(
    'https://box.tailnet.ts.net',
  );
  expect(consoleUrl({ bind: '0.0.0.0' }, 64647)).toBe('http://0.0.0.0:64647');
  expect(consoleUrl({}, 64647)).toBe('http://127.0.0.1:64647');
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

describe('isLocalAddress', () => {
  const nic = (address: string): NetworkInterfaceInfo =>
    address.includes(':')
      ? { address, cidr: null, family: 'IPv6', internal: false, mac: '', netmask: '', scopeid: 0 }
      : { address, cidr: null, family: 'IPv4', internal: false, mac: '', netmask: '' };
  const interfaces = { lo0: [nic('127.0.0.1'), nic('::1')], utun4: [nic('100.64.1.2')] };

  test('wildcards and addresses on an interface are local', () => {
    for (const ok of ['0.0.0.0', '::', '127.0.0.1', '100.64.1.2', '::1']) {
      expect(isLocalAddress(ok, interfaces)).toBe(true);
    }
  });

  test('an address on no interface is not local', () => {
    expect(isLocalAddress('192.0.2.55', interfaces)).toBe(false);
    expect(isLocalAddress('fd7a::9', interfaces)).toBe(false);
  });
});

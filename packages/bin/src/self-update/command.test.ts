import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { protocolCandidate } from '@mimir/core/testing';

import { fakeIo } from '../cli/testing';
import { cmdSelfUpdate } from './command';
import type { SelfUpdateDeps } from './command';
import { assetName } from './release';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mimir-self-update-'));
});
afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

function deps(extra: Partial<SelfUpdateDeps> = {}): SelfUpdateDeps {
  return {
    binPath: join(dir, 'mimir'),
    fetcher: () => Promise.reject(new Error('no network in tests')),
    version: '0.5.0',
    ...extra,
  };
}

/** The releases/latest redirect to `tag`, the way resolveLatestTag reads it. */
const latestRedirect = (tag: string): Response =>
  new Response(null, {
    headers: { location: `https://github.com/dbtlr/mimir/releases/tag/${tag}` },
    status: 302,
  });

/** A release feed whose only entry is `tag`. */
const feedOf = (tag: string): Response =>
  new Response(
    `<entry><link rel="alternate" href="https://github.com/dbtlr/mimir/releases/tag/${tag}"/></entry>`,
  );

/** A fetcher serving the latest-tag redirect plus the platform asset and its sums for `tag`. */
function releaseFetcher(tag: string, body: Uint8Array): SelfUpdateDeps['fetcher'] {
  const sha256 = new Bun.CryptoHasher('sha256').update(body).digest('hex');
  const asset = assetName();
  return (url) => {
    if (url.includes('/releases/latest')) {
      return Promise.resolve(latestRedirect(tag));
    }
    if (url.includes(`/download/${tag}/SHA256SUMS`)) {
      return Promise.resolve(new Response(`${sha256}  ${asset}\n`, { status: 200 }));
    }
    if (url.includes(`/download/${tag}/${asset}`)) {
      return Promise.resolve(new Response(body, { status: 200 }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  };
}

test('already up to date is a clean no-op', async () => {
  const io = fakeIo();
  const d = deps({ fetcher: () => Promise.resolve(latestRedirect('v0.5.0')) });
  expect(await cmdSelfUpdate(io, d)).toBe(0);
  expect(io.out.join('\n')).toContain('up to date');
});

test('refuses when not a compiled binary', async () => {
  const io = fakeIo();
  const d = deps({ binPath: '/opt/homebrew/bin/bun' });
  let thrown: unknown;
  try {
    await cmdSelfUpdate(io, d);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeDefined();
  expect(thrown instanceof Error && thrown.message).toMatch(/installed binary/);
});

test('a newer release replaces the binary and says so', async () => {
  const body = new TextEncoder().encode(protocolCandidate);
  const io = fakeIo();
  const d = deps({ fetcher: releaseFetcher('v0.6.0', body) });
  expect(await cmdSelfUpdate(io, d)).toBe(0);
  expect(readFileSync(d.binPath)).toEqual(Buffer.from(body));
  expect(io.out.join('\n')).toContain('updated 0.5.0 -> 0.6.0');
});

test('--tag is a no-op when already on that exact tag', async () => {
  const io = fakeIo();
  const d = deps({ version: '0.6.0-next.5' });
  expect(await cmdSelfUpdate(io, d, { tag: 'v0.6.0-next.5' })).toBe(0);
  expect(io.out.join('\n')).toMatch(/already/i);
});

test('--tag installs that exact tag, past the latest-release lookup', async () => {
  const body = new TextEncoder().encode(protocolCandidate);
  const tag = 'v0.7.0-next.2';
  const sha256 = new Bun.CryptoHasher('sha256').update(body).digest('hex');
  const asset = assetName();
  const io = fakeIo();
  const d = deps({
    fetcher: (url) => {
      if (url.includes(`/download/${tag}/SHA256SUMS`)) {
        return Promise.resolve(new Response(`${sha256}  ${asset}\n`));
      }
      if (url.includes(`/download/${tag}/${asset}`)) {
        return Promise.resolve(new Response(body));
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    },
  });
  expect(await cmdSelfUpdate(io, d, { tag: '0.7.0-next.2' })).toBe(0);
  expect(readFileSync(d.binPath)).toEqual(Buffer.from(body));
  expect(io.out.join('\n')).toContain('0.5.0 -> 0.7.0-next.2');
});

test('--next reports up to date when running the latest prerelease', async () => {
  const d = deps({
    fetcher: () => Promise.resolve(feedOf('v0.6.0-next.5')),
    version: '0.6.0-next.5',
  });
  const io = fakeIo();
  expect(await cmdSelfUpdate(io, d, { next: true })).toBe(0);
  expect(io.out.join('\n')).toMatch(/up to date/i);
});

// Regression (MMR-285): a machine on a `-next` prerelease could never reach
// the official release with the same numeric triple via plain self-update,
// because the old comparator parsed only the numeric triple and treated
// `0.15.0-next.1` as equal to `0.15.0`.
test('stable channel proceeds past a prerelease onto the matching official release', async () => {
  const body = new TextEncoder().encode(protocolCandidate);
  const io = fakeIo();
  const d = deps({ fetcher: releaseFetcher('v0.15.0', body), version: '0.15.0-next.1' });
  expect(await cmdSelfUpdate(io, d)).toBe(0);
  expect(io.out.join('\n')).not.toMatch(/up to date/i);
  expect(io.out.join('\n')).toContain('0.15.0-next.1 -> 0.15.0');
});

// Regression (MMR-285): --next resolved the atom feed's publish-order head
// rather than the semver max, so it could move sideways or backwards. Guard
// against a downgrade explicitly, same as the stable channel now does.
test('--next refuses to downgrade when the feed max is behind the running prerelease', async () => {
  const d = deps({ fetcher: () => Promise.resolve(feedOf('v0.15.0')), version: '0.16.0-next.1' });
  const io = fakeIo();
  expect(await cmdSelfUpdate(io, d, { next: true })).toBe(0);
  expect(io.out.join('\n')).toMatch(/up to date/i);
});

test('the default selection uses official latest and the semver compare', async () => {
  const d = deps({ fetcher: () => Promise.resolve(latestRedirect('v0.6.0')), version: '0.6.0' });
  const io = fakeIo();
  expect(await cmdSelfUpdate(io, d, {})).toBe(0);
  expect(io.out.join('\n')).toMatch(/up to date/i);
});

test('emits the json result envelope when format is json', async () => {
  const io = fakeIo();
  const d = deps({ fetcher: () => Promise.resolve(latestRedirect('v0.5.0')) });
  expect(await cmdSelfUpdate(io, d, {}, 'json')).toBe(0);
  expect(JSON.parse(io.out.join('\n'))).toMatchObject({ from: '0.5.0', updated: false });
});

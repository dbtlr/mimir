import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assetName,
  compareSemver,
  downloadAsset,
  downloadSums,
  replaceBinary,
  resolveLatestTag,
  resolveNextChannelTag,
  verifyChecksum,
} from './self-update';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mimir-selfupdate-'));
});
afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

test('compareSemver orders triples numerically', () => {
  expect(compareSemver('0.5.0', '0.6.0')).toBeLessThan(0);
  expect(compareSemver('0.10.0', '0.9.9')).toBeGreaterThan(0);
  expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  expect(compareSemver('v0.6.0', '0.6.0')).toBe(0); // tolerates the tag's v prefix
});

test('compareSemver ranks a release above a prerelease of the same triple', () => {
  expect(compareSemver('0.15.0', '0.15.0-next.12')).toBeGreaterThan(0);
  expect(compareSemver('0.15.0-next.12', '0.15.0')).toBeLessThan(0);
});

test('compareSemver compares prerelease numeric identifiers numerically, not lexically', () => {
  expect(compareSemver('0.15.0-next.2', '0.15.0-next.10')).toBeLessThan(0);
  expect(compareSemver('0.15.0-next.1', '0.15.0-next.1.1')).toBeLessThan(0);
  expect(compareSemver('0.15.0-alpha', '0.15.0-next')).toBeLessThan(0); // alphanumeric, lexical
});

test('compareSemver still lets the numeric triple win over a prerelease suffix', () => {
  expect(compareSemver('0.15.0', '0.16.0-next.1')).toBeLessThan(0);
});

test('resolveLatestTag follows the releases/latest redirect', async () => {
  const tag = await resolveLatestTag(() =>
    Promise.resolve(
      new Response(null, {
        headers: { location: 'https://github.com/dbtlr/mimir/releases/tag/v0.6.0' },
        status: 302,
      }),
    ),
  );
  expect(tag).toBe('v0.6.0');
});

test('resolveLatestTag rejects a non-redirect answer', async () => {
  let thrown: unknown;
  try {
    await resolveLatestTag(() => Promise.resolve(new Response('nope', { status: 200 })));
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toMatch(/latest release/);
});

test('assetName maps this platform', () => {
  expect(assetName()).toMatch(/^mimir-(darwin|linux)-(arm64|x64)$/);
});

test('verifyChecksum accepts the matching SHA256SUMS line and rejects a tampered body', () => {
  const body = new TextEncoder().encode('the binary');
  const hash = new Bun.CryptoHasher('sha256').update(body).digest('hex');
  const sums = `${hash}  mimir-darwin-arm64\nother  mimir-linux-x64\n`;
  expect(() => verifyChecksum(body, sums, 'mimir-darwin-arm64')).not.toThrow();
  expect(() => verifyChecksum(body, sums, 'mimir-linux-x64')).toThrow(/checksum/);
  expect(() => verifyChecksum(body, '', 'mimir-darwin-arm64')).toThrow(/SHA256SUMS/);
});

test('replaceBinary atomically swaps and preserves executability', () => {
  const target = join(dir, 'mimir');
  writeFileSync(target, 'old');
  chmodSync(target, 0o755);
  replaceBinary(target, new TextEncoder().encode('new'));
  expect(readFileSync(target, 'utf8')).toBe('new');
  expect(statSync(target).mode & 0o111).not.toBe(0);
});

const redirectingFetcher = (url: string): Promise<Response> => {
  if (url.endsWith('/SHA256SUMS')) {
    return Promise.resolve(new Response('abc  mimir-darwin-arm64\n', { status: 200 }));
  }
  if (url.includes('cdn.example')) {
    return Promise.resolve(new Response('BINARY', { status: 200 }));
  }
  return Promise.resolve(
    new Response(null, { headers: { location: 'https://cdn.example/blob' }, status: 302 }),
  );
};

test('downloadAsset follows download redirects and downloadSums returns text', async () => {
  const body = await downloadAsset('v0.6.0', redirectingFetcher);
  expect(new TextDecoder().decode(body)).toBe('BINARY');
  expect(await downloadSums('v0.6.0', redirectingFetcher)).toBe('abc  mimir-darwin-arm64\n');
});

test('resolveNextChannelTag picks the semver max, not the publish-order head', async () => {
  // Publish order (head first) does not match semver order — an official
  // 0.15.0 lands after 0.15.0-next.12 in the feed, which itself is published
  // after the head entry 0.15.0-next.1. Each entry mentions its tag twice
  // (id + link), as a real GitHub atom entry does.
  const atom = `<?xml version="1.0"?><feed>
    <entry>
      <id>https://github.com/dbtlr/mimir/releases/tag/v0.15.0-next.1</id>
      <link rel="alternate" href="https://github.com/dbtlr/mimir/releases/tag/v0.15.0-next.1"/>
    </entry>
    <entry>
      <id>https://github.com/dbtlr/mimir/releases/tag/v0.15.0-next.12</id>
      <link rel="alternate" href="https://github.com/dbtlr/mimir/releases/tag/v0.15.0-next.12"/>
    </entry>
    <entry>
      <id>https://github.com/dbtlr/mimir/releases/tag/v0.15.0</id>
      <link rel="alternate" href="https://github.com/dbtlr/mimir/releases/tag/v0.15.0"/>
    </entry>
  </feed>`;
  const tag = await resolveNextChannelTag(() =>
    Promise.resolve(new Response(atom, { status: 200 })),
  );
  expect(tag).toBe('v0.15.0');
});

test('resolveNextChannelTag throws when the feed names no release', async () => {
  let thrown: unknown;
  try {
    await resolveNextChannelTag(() => Promise.resolve(new Response('<feed></feed>')));
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toMatch(/prerelease|release/i);
});

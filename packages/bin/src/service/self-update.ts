/**
 * Self-update (MMR-47): resolve the latest tag from the releases/latest
 * redirect (no GitHub API dependency), download the platform asset, verify
 * it against SHA256SUMS, atomically replace our own binary. Latest only —
 * no channels, no --force. Orchestration (version gate, service restart,
 * event log) lives in the command layer; this module is the engine.
 */
import { chmodSync, renameSync, writeFileSync } from 'node:fs';

import { MimirError } from '../core';

export type Fetcher = (url: string) => Promise<Response>;

export const RELEASE_BASE = 'https://github.com/dbtlr/mimir/releases';

/** Default fetcher: never auto-follow — the redirect Location IS the answer. */
export const manualFetch: Fetcher = (url) => fetch(url, { redirect: 'manual' });

const parseSemverParts = (v: string): number[] =>
  v
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);

/** Numeric triple compare; tolerates a leading `v`. <0 means a older than b. */
export function compareSemver(a: string, b: string): number {
  const [a0 = 0, a1 = 0, a2 = 0] = parseSemverParts(a);
  const [b0 = 0, b1 = 0, b2 = 0] = parseSemverParts(b);
  return a0 - b0 || a1 - b1 || a2 - b2;
}

export async function resolveLatestTag(fetcher: Fetcher = manualFetch): Promise<string> {
  const res = await fetcher(`${RELEASE_BASE}/latest`);
  const location = res.headers.get('location') ?? '';
  const m = /\/releases\/tag\/(v[\d.]+)$/.exec(location);
  if (m?.[1] === undefined) {
    throw new MimirError(
      'validation',
      'could not resolve the latest release tag',
      'check network access to github.com',
    );
  }
  return m[1];
}

export const ATOM_FEED = 'https://github.com/dbtlr/mimir/releases.atom';

/**
 * The most recent release INCLUDING prereleases (the `--next` channel). GitHub's
 * `/releases/latest` excludes prereleases, so we read the atom feed instead —
 * newest-first, no auth, no REST rate limit. The first `/releases/tag/<tag>`
 * occurrence is the newest entry.
 */
export async function resolveLatestPrereleaseTag(fetcher: Fetcher = manualFetch): Promise<string> {
  const res = await fetcher(ATOM_FEED);
  const text = await res.text();
  const m = /\/releases\/tag\/([^"<]+)/.exec(text);
  if (m?.[1] === undefined) {
    throw new MimirError(
      'validation',
      'could not resolve a prerelease tag from the release feed',
      'check network access to github.com',
    );
  }
  return m[1];
}

/** The release asset for this machine — same names install.sh downloads. */
export function assetName(): string {
  const os = process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return `mimir-${os}-${arch}`;
}

export function verifyChecksum(body: Uint8Array, sums: string, asset: string): void {
  const line = sums.split('\n').find((l) => l.trim().endsWith(`  ${asset}`));
  if (line === undefined) {
    throw new MimirError('validation', `no SHA256SUMS entry for ${asset}`);
  }
  const expected = line.trim().split(/\s+/)[0];
  const actual = new Bun.CryptoHasher('sha256').update(body).digest('hex');
  if (expected !== actual) {
    throw new MimirError(
      'validation',
      `checksum mismatch for ${asset}`,
      'the download is corrupt or tampered with — not installed',
    );
  }
}

/** Write-beside + rename: the swap is atomic on the same filesystem. */
export function replaceBinary(targetPath: string, body: Uint8Array): void {
  const staging = `${targetPath}.self-update`;
  writeFileSync(staging, body);
  chmodSync(staging, 0o755);
  renameSync(staging, targetPath);
}

export async function downloadAsset(
  tag: string,
  fetcher: Fetcher = manualFetch,
): Promise<Uint8Array> {
  const asset = assetName();
  const res = await fetcher(`${RELEASE_BASE}/download/${tag}/${asset}`);
  const followed = await followDownload(res, fetcher);
  return new Uint8Array(await followed.arrayBuffer());
}

export async function downloadSums(tag: string, fetcher: Fetcher = manualFetch): Promise<string> {
  const res = await fetcher(`${RELEASE_BASE}/download/${tag}/SHA256SUMS`);
  return (await followDownload(res, fetcher)).text();
}

/** Release downloads 302 to a CDN URL; follow a few hops manually. */
async function followDownload(res: Response, fetcher: Fetcher): Promise<Response> {
  let current = res;
  for (let hops = 0; current.status >= 300 && current.status < 400 && hops < 5; hops++) {
    const next = current.headers.get('location');
    if (next === null) {
      break;
    }
    current = await fetcher(next);
  }
  if (!current.ok) {
    throw new MimirError('validation', `release download failed (${String(current.status)})`);
  }
  return current;
}

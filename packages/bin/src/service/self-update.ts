/**
 * Self-update (MMR-47): resolve the latest tag from the releases/latest
 * redirect (no GitHub API dependency), download the platform asset, verify
 * it against SHA256SUMS, atomically replace our own binary. Two channels —
 * stable (default) and prerelease (`--next`) — plus an explicit `--tag`
 * escape hatch. Orchestration (version gate, service restart, event log)
 * lives in the command layer; this module is the engine.
 */
import { chmodSync, renameSync, writeFileSync } from 'node:fs';

import { MimirError } from '../core';

export type Fetcher = (url: string) => Promise<Response>;

export const RELEASE_BASE = 'https://github.com/dbtlr/mimir/releases';

/** Default fetcher: never auto-follow — the redirect Location IS the answer. */
export const manualFetch: Fetcher = (url) => fetch(url, { redirect: 'manual' });

/** A parsed SemVer: numeric triple plus optional dot-separated prerelease identifiers. */
type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

const parseSemver = (v: string): ParsedSemver => {
  // Strip a leading `v` and any build metadata (`+...`) before splitting off
  // the prerelease suffix (`-...`).
  const [main, ...prereleaseParts] = v.replace(/^v/, '').replace(/\+.*$/, '').split('-');
  const [major = 0, minor = 0, patch = 0] = (main ?? '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  const prerelease = prereleaseParts.length === 0 ? [] : prereleaseParts.join('-').split('.');
  return { major, minor, patch, prerelease };
};

const isNumericIdentifier = (id: string): boolean => /^\d+$/.test(id);

/** SemVer §11 precedence for a single dot-separated prerelease identifier pair. */
function compareIdentifier(a: string, b: string): number {
  const aNum = isNumericIdentifier(a);
  const bNum = isNumericIdentifier(b);
  if (aNum && bNum) {
    return Number.parseInt(a, 10) - Number.parseInt(b, 10);
  }
  if (aNum !== bNum) {
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    return aNum ? -1 : 1;
  }
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/**
 * Full SemVer §11 precedence compare; tolerates a leading `v` and ignores
 * build metadata. <0 means a older than b. A release outranks a prerelease
 * of the same triple (`0.15.0` > `0.15.0-next.12`); between two prereleases,
 * shared identifiers compare left to right (numeric identifiers numerically,
 * alphanumeric ones lexically, numeric always lower than alphanumeric), and
 * if all shared identifiers tie, the longer identifier list wins.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  const coreDiff = pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
  if (coreDiff !== 0) {
    return coreDiff;
  }
  if (pa.prerelease.length === 0 || pb.prerelease.length === 0) {
    // No prerelease beats having one; two non-prereleases tie here.
    return (pa.prerelease.length === 0 ? 1 : 0) - (pb.prerelease.length === 0 ? 1 : 0);
  }
  const len = Math.min(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < len; i++) {
    const d = compareIdentifier(pa.prerelease[i] ?? '', pb.prerelease[i] ?? '');
    if (d !== 0) {
      return d;
    }
  }
  return pa.prerelease.length - pb.prerelease.length;
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
 * The newest release across BOTH channels — official and prerelease — by
 * SemVer precedence (the `--next` channel's target). GitHub's
 * `/releases/latest` excludes prereleases, so we read the atom feed instead —
 * no auth, no REST rate limit — and reduce every tag it mentions with
 * `compareSemver`, since the feed's publish order is not semver order (an
 * official release cut from an older base can publish after a newer
 * prerelease, or vice versa).
 */
export async function resolveNextChannelTag(fetcher: Fetcher = manualFetch): Promise<string> {
  const res = await fetcher(ATOM_FEED);
  const text = await res.text();
  const tags = new Set<string>();
  for (const m of text.matchAll(/\/releases\/tag\/([^"<]+)/g)) {
    if (m[1] !== undefined) {
      tags.add(m[1]);
    }
  }
  if (tags.size === 0) {
    throw new MimirError(
      'validation',
      'could not resolve a prerelease tag from the release feed',
      'check network access to github.com',
    );
  }
  return [...tags].reduce((best, tag) => (compareSemver(tag, best) > 0 ? tag : best));
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

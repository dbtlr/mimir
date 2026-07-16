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

/**
 * Full SemVer §11 precedence compare, delegated to the runtime's
 * implementation; tolerates a leading `v`. <0 means a older than b; a release
 * outranks a prerelease of the same triple (`0.15.0` > `0.15.0-next.12`).
 * Strict: throws on a non-SemVer input — every internal caller passes a known
 * version, and the one untrusted source (the release feed) filters through
 * `isSemverTag` first.
 */
export function compareSemver(a: string, b: string): number {
  return Bun.semver.order(a, b);
}

/** Whether the runtime's SemVer parser accepts `tag` (leading `v` tolerated). */
export function isSemverTag(tag: string): boolean {
  try {
    Bun.semver.order(tag, tag);
    return true;
  } catch {
    return false;
  }
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
 * Entry tag-page links in the atom feed: a literal-quoted href under this
 * repo's `/releases/tag/`. Entry bodies (`<content type="html">`) are
 * HTML-escaped — no literal quotes — so a tag-shaped link pasted into
 * someone's release notes can never match; only the feed's own `<link>`
 * elements do.
 */
const TAG_HREF = new RegExp(
  `href="${RELEASE_BASE.replaceAll('.', String.raw`\.`)}/tag/([^"]+)"`,
  'g',
);

/**
 * The newest release across BOTH channels — official and prerelease — by
 * SemVer precedence (the `--next` channel's target). GitHub's
 * `/releases/latest` excludes prereleases, so we read the atom feed instead —
 * no auth, no REST rate limit — and keep the semver max of the entry tags,
 * since the feed's publish order is not semver order (an official release cut
 * from an older base can publish after a newer prerelease, or vice versa).
 * Non-SemVer tags in the feed are skipped, not fatal.
 */
export async function resolveNextChannelTag(fetcher: Fetcher = manualFetch): Promise<string> {
  const res = await fetcher(ATOM_FEED);
  if (!res.ok) {
    throw new MimirError(
      'validation',
      `release feed request failed (${String(res.status)})`,
      'check network access to github.com',
    );
  }
  const text = await res.text();
  let best: string | undefined;
  for (const m of text.matchAll(TAG_HREF)) {
    const tag = m[1];
    if (
      tag !== undefined &&
      isSemverTag(tag) &&
      (best === undefined || compareSemver(tag, best) > 0)
    ) {
      best = tag;
    }
  }
  if (best === undefined) {
    throw new MimirError(
      'validation',
      'could not resolve a release tag from the release feed',
      'check network access to github.com',
    );
  }
  return best;
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

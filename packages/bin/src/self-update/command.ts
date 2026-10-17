/**
 * The `self-update` command layer (MMR-47): the version gate and output over
 * the release engine. All effects flow through SelfUpdateDeps so tests drive
 * the layer with fakes; main wires the real edges.
 *
 * Output conforms to the CLI contract (MMR-59): the result renders as the
 * `json`/`jsonl` envelope (./format) or human prose. The picked format is
 * supplied by the dispatcher (pickFormat's "report" kind); the param defaults
 * to human for direct/test callers.
 */
import { basename } from 'node:path';

import { MimirError } from '@mimir/core';

import type { Format, Io } from '../presentation';
import { arrow, ok } from '../presentation';
import { formatSelfUpdateJson } from './format';
import type { SelfUpdateResult } from './format';
import {
  assetName,
  compareSemver,
  downloadAsset,
  downloadSums,
  replaceBinary,
  resolveLatestTag,
  resolveNextChannelTag,
  verifyChecksum,
} from './release';
import type { Fetcher } from './release';

export type UpdateSelection = {
  /** Include prereleases — resolve the newest build on the next-version line (--next). */
  next?: boolean;
  /** Install this exact tag (official or prerelease); wins over `next` (--tag). */
  tag?: string;
};

export type SelfUpdateDeps = {
  /** The binary self-update replaces (process.execPath). */
  binPath: string;
  /** This invocation's version (build-injected tag, or package.json) — the on-disk version by definition. */
  version: string;
  fetcher: Fetcher;
};

const stripV = (t: string): string => t.replace(/^v/, '');

export async function cmdSelfUpdate(
  io: Io,
  deps: SelfUpdateDeps,
  sel: UpdateSelection = {},
  format: Format = 'records',
): Promise<number> {
  if (basename(deps.binPath).startsWith('bun')) {
    throw new MimirError(
      'validation',
      'self-update needs an installed binary',
      'running from source — use git pull / bun run instead',
    );
  }
  const structured = format === 'json' || format === 'jsonl';
  const asset = assetName();
  let targetTag: string;
  let alreadyCurrent: boolean;
  if (sel.tag !== undefined) {
    targetTag = sel.tag.startsWith('v') ? sel.tag : `v${sel.tag}`;
    alreadyCurrent = stripV(targetTag) === deps.version;
  } else if (sel.next === true) {
    targetTag = await resolveNextChannelTag(deps.fetcher);
    alreadyCurrent = compareSemver(targetTag, deps.version) <= 0;
  } else {
    targetTag = await resolveLatestTag(deps.fetcher);
    alreadyCurrent = compareSemver(targetTag, deps.version) <= 0;
  }
  const target = stripV(targetTag);
  if (alreadyCurrent) {
    report(io, format, { asset, from: deps.version, to: target, updated: false }, () =>
      ok(io, `already up to date (${deps.version})`),
    );
    return 0;
  }
  if (!structured) {
    io.write(`updating ${deps.version} ${arrow(io.plain)} ${target} (${asset})`);
  }
  const [body, sums] = await Promise.all([
    downloadAsset(targetTag, deps.fetcher),
    downloadSums(targetTag, deps.fetcher),
  ]);
  verifyChecksum(body, sums, asset);
  replaceBinary(deps.binPath, body);
  report(io, format, { asset, from: deps.version, to: target, updated: true }, () =>
    ok(io, `updated ${deps.version} ${arrow(io.plain)} ${target}`),
  );
  return 0;
}

/** Render the result: structured envelope, else human prose. */
function report(io: Io, format: Format, result: SelfUpdateResult, human: () => void): void {
  if (format === 'json' || format === 'jsonl') {
    io.write(formatSelfUpdateJson(result, format === 'json'));
  } else {
    human();
  }
}

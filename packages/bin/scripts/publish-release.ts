/**
 * Release publisher — stage a GitHub Release as a draft, upload the built
 * assets with bounded retries, verify every remote asset against the local
 * bytes, and publish only when the remote asset set is exactly the expected
 * one (MMR-387).
 *
 * Why not a marketplace action: the previous publisher created the release
 * public first and uploaded afterwards, so a transient upload failure (GitHub
 * returned HTTP 500 on two consecutive releases) exposed an incomplete
 * release, then hung. Recovery meant re-uploading by hand. This script makes
 * the failure modes explicit:
 *
 * - Every API call has a request deadline. Transient failures (5xx, dropped
 *   connections, deadlines, a body that stalls mid-transfer, an upload that
 *   completed server-side after the client gave up) retry with backoff, up to
 *   `maxAttempts` per operation and `budgetMs` overall, without rebuilding.
 * - An asset already present and verified (state uploaded, size and SHA-256
 *   match) is preserved; a partial or mismatched one is deleted and re-sent.
 * - Exhausted retries leave the draft in place and exit non-zero with a
 *   per-asset diagnosis; re-running the job resumes from the draft.
 * - A release that is already public is never modified: complete → success
 *   (idempotent re-run), incomplete → refusal with the diff.
 *
 * Run from the publish job: `bun packages/bin/scripts/publish-release.ts
 * --tag vX.Y.Z --notes release-notes.md [--prerelease] <asset>...`.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { z } from 'zod';

const Asset = z.object({
  digest: z.string().nullable().optional(),
  id: z.number(),
  name: z.string(),
  size: z.number(),
  state: z.string(),
  url: z.string(),
});
const Release = z.object({
  assets: z.array(Asset),
  draft: z.boolean(),
  html_url: z.string(),
  id: z.number(),
  prerelease: z.boolean(),
  tag_name: z.string(),
  upload_url: z.string(),
});
type RemoteAsset = z.infer<typeof Asset>;
type RemoteRelease = z.infer<typeof Release>;

export type PublishOptions = {
  apiUrl: string;
  repository: string;
  token: string;
  tag: string;
  body: string;
  prerelease: boolean;
  /** Local asset paths; the basename is the asset name. */
  assets: string[];
  /** Attempts per operation (lookup, upload of one asset, publish, …). */
  maxAttempts: number;
  /** First backoff; doubles per attempt, capped at 8× this value. */
  retryDelayMs: number;
  /** Deadline for any single HTTP request, headers and body included. */
  requestTimeoutMs: number;
  /** Once this much time has passed, no further retries are started. */
  budgetMs: number;
  log: (line: string) => void;
};

export type PublishOutcome =
  | { status: 'published'; url: string }
  | { status: 'already-published'; url: string }
  /** Retries exhausted or verification failed; the draft (if any) survives for a re-run. */
  | { status: 'incomplete'; url: string | null; problems: string[] }
  /** Nothing was touched; the request itself is unsafe to carry out. */
  | { status: 'refused'; problems: string[] };

type LocalAsset = { name: string; path: string; size: number; sha256: string };

type Init = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> };

/**
 * A failure worth retrying: 5xx, a dropped connection, a hit deadline, or a
 * rate limit. `waitMs` is the minimum pause GitHub asked for before the
 * next attempt, when it said.
 */
class TransientError extends Error {
  override name = 'TransientError';
  readonly waitMs: number;
  constructor(message: string, waitMs = 0) {
    super(message);
    this.waitMs = waitMs;
  }
}

/**
 * GitHub signals a primary or secondary rate limit with 429, or 403 plus a
 * message naming the limit. The documented wait is `retry-after` seconds,
 * else the `x-ratelimit-reset` epoch when `x-ratelimit-remaining` is 0,
 * else at least one minute.
 */
function rateLimitWait(response: Response, text: string): number | null {
  const limited = response.status === 429 || (response.status === 403 && /rate limit/i.test(text));
  if (!limited) {
    return null;
  }
  const retryAfter = Number(response.headers.get('retry-after'));
  if (retryAfter > 0) {
    return retryAfter * 1000;
  }
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (response.headers.get('x-ratelimit-remaining') === '0' && reset > 0) {
    return Math.max(0, reset * 1000 - Date.now());
  }
  return 60_000;
}

/** One operation's retries ran out (attempts or the overall budget). */
class GaveUpError extends Error {
  override name = 'GaveUpError';
  constructor(label: string, attempts: number, failures: string[]) {
    super(`${label}: gave up after ${attempts} attempt(s)\n  ${failures.join('\n  ')}`);
  }
}

function readLocalAssets(paths: string[]): LocalAsset[] {
  const assets = paths.map((path) => {
    const bytes = readFileSync(path);
    return {
      name: basename(path),
      path,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.byteLength,
    };
  });
  const names = new Set<string>();
  for (const asset of assets) {
    if (names.has(asset.name)) {
      throw new Error(`duplicate asset name: ${asset.name}`);
    }
    names.add(asset.name);
  }
  return assets;
}

/**
 * The checksum manifest, when it ships as an asset, must describe exactly the
 * binaries being shipped beside it. The workflow generates it from the same
 * files in the same job, so this only bites a hand-assembled asset list — but
 * that is precisely the manual-recovery path this script replaces.
 */
function checkManifest(assets: LocalAsset[]): string[] {
  const manifest = assets.find((asset) => asset.name === 'SHA256SUMS');
  if (!manifest) {
    return [];
  }
  const expected = new Map<string, string>();
  for (const line of readFileSync(manifest.path, 'utf8').split('\n')) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (match?.[1] && match[2]) {
      expected.set(match[2], match[1]);
    }
  }
  const problems: string[] = [];
  for (const asset of assets) {
    if (asset.name === 'SHA256SUMS') {
      continue;
    }
    const digest = expected.get(asset.name);
    if (digest === undefined) {
      problems.push(`SHA256SUMS has no entry for ${asset.name}`);
    } else if (digest !== asset.sha256) {
      problems.push(`SHA256SUMS digest differs for ${asset.name}`);
    }
    expected.delete(asset.name);
  }
  for (const name of expected.keys()) {
    problems.push(`SHA256SUMS lists ${name}, which is not an asset`);
  }
  return problems;
}

/** Bounded retry of one operation: attempts, backoff, and the overall budget. */
class Retrier {
  private readonly options: PublishOptions;
  private readonly deadline: number;

  constructor(options: PublishOptions) {
    this.options = options;
    this.deadline = Date.now() + options.budgetMs;
  }

  async run<T>(label: string, operation: (attempt: number) => Promise<T>): Promise<T> {
    const failures: string[] = [];
    let attempts = 0;
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
      attempts = attempt;
      try {
        return await operation(attempt);
      } catch (error) {
        if (!(error instanceof TransientError)) {
          throw error;
        }
        failures.push(`attempt ${attempt}: ${error.message}`);
        this.options.log(`${label}: ${error.message}`);
        if (attempt === this.options.maxAttempts) {
          break;
        }
        const backoff = Math.min(
          this.options.retryDelayMs * 2 ** (attempt - 1),
          this.options.retryDelayMs * 8,
        );
        const delay = Math.max(backoff, error.waitMs);
        if (Date.now() + delay > this.deadline) {
          failures.push(`time budget of ${this.options.budgetMs} ms exhausted; not retrying`);
          break;
        }
        await Bun.sleep(delay);
      }
    }
    throw new GaveUpError(label, attempts, failures);
  }
}

/** Single-shot GitHub REST calls. Every failure that is worth a retry is a TransientError. */
class GitHub {
  private readonly options: PublishOptions;
  /** Digests computed by downloading, keyed by asset id — an asset never changes bytes. */
  private readonly downloaded = new Map<number, string>();

  constructor(options: PublishOptions) {
    this.options = options;
  }

  private headers(extra: Record<string, string> = {}) {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.options.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...extra,
    };
  }

  private get base() {
    return `${this.options.apiUrl}/repos/${this.options.repository}`;
  }

  /** One request with a hard deadline that also covers reading the body. */
  private async request(url: string, init: Init) {
    const method = init.method ?? 'GET';
    let response: Response;
    let body: Uint8Array;
    try {
      response = await fetch(url, {
        ...init,
        headers: this.headers(init.headers),
        signal: AbortSignal.timeout(this.options.requestTimeoutMs),
      });
      body = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new TransientError(`${method} ${url}: ${reason}`);
    }
    if (response.status >= 500) {
      throw new TransientError(`${method} ${url}: HTTP ${response.status}`);
    }
    const text = () => new TextDecoder().decode(body);
    const waitMs = rateLimitWait(response, text());
    if (waitMs !== null) {
      const seconds = Math.ceil(waitMs / 1000);
      throw new TransientError(
        `${method} ${url}: HTTP ${response.status} rate limited, wait ${seconds}s`,
        waitMs,
      );
    }
    return { body, response, text };
  }

  private async json<S extends z.ZodType>(url: string, schema: S, init: Init = {}) {
    const { response, text } = await this.request(url, init);
    if (!response.ok) {
      throw new Error(`${init.method ?? 'GET'} ${url}: HTTP ${response.status} ${text()}`);
    }
    return schema.parse(JSON.parse(text()));
  }

  async publishedRelease(tag: string): Promise<RemoteRelease | null> {
    const url = `${this.base}/releases/tags/${encodeURIComponent(tag)}`;
    const { response, text } = await this.request(url, {});
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`lookup ${tag}: HTTP ${response.status}`);
    }
    return Release.parse(JSON.parse(text()));
  }

  /** Drafts are invisible to the by-tag lookup; scan every page of the list. */
  async draftReleases(tag: string) {
    const drafts: RemoteRelease[] = [];
    for (let page = 1; ; page++) {
      const url = `${this.base}/releases?per_page=100&page=${page}`;
      const releases = await this.json(url, z.array(Release));
      drafts.push(...releases.filter((release) => release.draft && release.tag_name === tag));
      if (releases.length < 100) {
        return drafts;
      }
    }
  }

  createDraft(tag: string, body: string, prerelease: boolean) {
    return this.json(`${this.base}/releases`, Release, {
      body: JSON.stringify({ body, draft: true, name: tag, prerelease, tag_name: tag }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
  }

  publish(release: RemoteRelease, body: string, prerelease: boolean) {
    return this.json(`${this.base}/releases/${release.id}`, Release, {
      body: JSON.stringify({ body, draft: false, prerelease }),
      headers: { 'Content-Type': 'application/json' },
      method: 'PATCH',
    });
  }

  assets(release: RemoteRelease) {
    return this.json(`${this.base}/releases/${release.id}/assets?per_page=100`, z.array(Asset));
  }

  asset(id: number) {
    return this.json(`${this.base}/releases/assets/${id}`, Asset);
  }

  async deleteAsset(asset: RemoteAsset) {
    const { response } = await this.request(`${this.base}/releases/assets/${asset.id}`, {
      method: 'DELETE',
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`delete ${asset.name}: HTTP ${response.status}`);
    }
  }

  /**
   * Upload one asset. A 422 "already_exists" means an earlier attempt that the
   * client gave up on completed server-side; that is transient — the next
   * attempt re-lists, finds it, and verifies or replaces it.
   */
  async upload(release: RemoteRelease, asset: LocalAsset) {
    const target = new URL(release.upload_url.replace(/\{.*\}$/, ''));
    target.searchParams.set('name', asset.name);
    const url = target.toString();
    const { response, text } = await this.request(url, {
      body: readFileSync(asset.path),
      headers: { 'Content-Type': 'application/octet-stream' },
      method: 'POST',
    });
    if (response.status === 422 && text().includes('already_exists')) {
      throw new TransientError(`POST ${url}: asset already exists (a previous attempt completed)`);
    }
    if (!response.ok) {
      throw new Error(`POST ${url}: HTTP ${response.status} ${text()}`);
    }
    return Asset.parse(JSON.parse(text()));
  }

  /** The API's own digest when it has one; otherwise hash a download (once). */
  async digest(asset: RemoteAsset) {
    const match = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? '');
    if (match?.[1]) {
      return match[1];
    }
    const cached = this.downloaded.get(asset.id);
    if (cached) {
      return cached;
    }
    const { body, response } = await this.request(asset.url, {
      headers: { Accept: 'application/octet-stream' },
    });
    if (!response.ok) {
      throw new Error(`download ${asset.name}: HTTP ${response.status}`);
    }
    const digest = createHash('sha256').update(body).digest('hex');
    this.downloaded.set(asset.id, digest);
    return digest;
  }
}

/** Why a remote asset does not match its local counterpart, or null when it does. */
async function mismatch(github: GitHub, remote: RemoteAsset, local: LocalAsset) {
  if (remote.state !== 'uploaded') {
    return `state is ${remote.state}`;
  }
  if (remote.size !== local.size) {
    return `size ${remote.size} != ${local.size}`;
  }
  const digest = await github.digest(remote);
  if (digest !== local.sha256) {
    return `sha256 ${digest} != ${local.sha256}`;
  }
  return null;
}

/** Compare a release's asset set with the expected one; empty means exact. */
async function verify(github: GitHub, release: RemoteRelease, expected: LocalAsset[]) {
  const remote = await github.assets(release);
  const problems: string[] = [];
  for (const local of expected) {
    const found = remote.filter((asset) => asset.name === local.name);
    if (found.length === 0) {
      problems.push(`${local.name}: missing`);
    } else if (found.length > 1) {
      problems.push(`${local.name}: ${found.length} assets share this name`);
    }
    for (const asset of found) {
      const reason = await mismatch(github, asset, local);
      if (reason) {
        problems.push(`${local.name}: ${reason}`);
      }
    }
  }
  for (const asset of remote) {
    if (!expected.some((local) => local.name === asset.name)) {
      problems.push(`${asset.name}: unexpected asset`);
    }
  }
  return problems;
}

/**
 * One attempt at bringing an asset to a verified state: keep it if it already
 * matches, else delete whatever is there, upload, and re-read the stored asset
 * to verify. Throws TransientError for anything the Retrier should repeat.
 */
async function ensureAssetOnce(
  github: GitHub,
  release: RemoteRelease,
  local: LocalAsset,
  attempt: number,
  options: PublishOptions,
) {
  const present = (await github.assets(release)).filter((asset) => asset.name === local.name);
  const [only] = present;
  if (present.length === 1 && only) {
    const reason = await mismatch(github, only, local);
    if (reason === null) {
      options.log(`${local.name}: already uploaded and verified, keeping`);
      return;
    }
    options.log(`${local.name}: replacing remote asset (${reason})`);
  }
  for (const stale of present) {
    await github.deleteAsset(stale);
  }
  options.log(`${local.name}: uploading (attempt ${attempt}/${options.maxAttempts})`);
  const uploaded = await github.upload(release, local);
  // Verify what GitHub stored, not what the upload response claims.
  const stored = await github.asset(uploaded.id);
  const reason = await mismatch(github, stored, local);
  if (reason !== null) {
    throw new TransientError(`verification after upload: ${reason}`);
  }
  options.log(`${local.name}: uploaded and verified`);
}

export async function publishRelease(options: PublishOptions): Promise<PublishOutcome> {
  const { log, tag } = options;
  const expected = readLocalAssets(options.assets);
  const manifestProblems = checkManifest(expected);
  if (manifestProblems.length > 0) {
    return { problems: manifestProblems, status: 'refused' };
  }
  const github = new GitHub(options);
  const retry = new Retrier(options);
  let release: RemoteRelease | null = null;

  try {
    const published = await retry.run('lookup', () => github.publishedRelease(tag));
    if (published) {
      const problems = await retry.run('verify', () => verify(github, published, expected));
      if (problems.length === 0) {
        log(`${tag} is already published with the exact asset set; nothing to do`);
        return { status: 'already-published', url: published.html_url };
      }
      return {
        problems: [
          `${tag} is already public but its asset set is wrong; refusing to modify it`,
          ...problems,
        ],
        status: 'refused',
      };
    }

    const drafts = await retry.run('list drafts', () => github.draftReleases(tag));
    if (drafts.length > 1) {
      return {
        problems: [`${tag} has ${drafts.length} drafts; delete the surplus before re-running`],
        status: 'refused',
      };
    }
    const [draft] = drafts;
    if (draft) {
      release = draft;
      log(`resuming existing draft for ${tag}`);
    } else {
      release = await retry.run('create draft', () =>
        github.createDraft(tag, options.body, options.prerelease),
      );
      log(`created draft for ${tag}`);
    }
    const staged = release;

    const problems: string[] = [];
    for (const local of expected) {
      try {
        await retry.run(local.name, (attempt) =>
          ensureAssetOnce(github, staged, local, attempt, options),
        );
      } catch (error) {
        if (!(error instanceof GaveUpError)) {
          throw error;
        }
        problems.push(error.message);
      }
    }
    if (problems.length > 0) {
      return { problems, status: 'incomplete', url: staged.html_url };
    }

    const remaining = await retry.run('verify', () => verify(github, staged, expected));
    if (remaining.length > 0) {
      return { problems: remaining, status: 'incomplete', url: staged.html_url };
    }
    const final = await retry.run('publish', () =>
      github.publish(staged, options.body, options.prerelease),
    );
    log(`published ${tag} (${expected.length} assets)`);
    return { status: 'published', url: final.html_url };
  } catch (error) {
    if (!(error instanceof GaveUpError)) {
      throw error;
    }
    return { problems: [error.message], status: 'incomplete', url: release?.html_url ?? null };
  }
}

function usage(): never {
  console.error(
    'usage: publish-release --tag <tag> --notes <file> [--prerelease] <asset>...\n' +
      '  env: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL (optional)',
  );
  process.exit(2);
}

function env(name: string) {
  const value = process.env[name];
  if (!value) {
    console.error(`missing environment variable ${name}`);
    process.exit(2);
  }
  return value;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const assets: string[] = [];
  let tag: string | undefined;
  let notes: string | undefined;
  let prerelease = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--tag') {
      tag = args[++index];
    } else if (arg === '--notes') {
      notes = args[++index];
    } else if (arg === '--prerelease') {
      prerelease = true;
    } else if (arg?.startsWith('--')) {
      usage();
    } else if (arg) {
      assets.push(arg);
    }
  }
  if (!tag || !notes || assets.length === 0) {
    usage();
  }

  // Worst case stays under release.yml's publish timeout-minutes: the budget
  // stops new retries, and one in-flight request can overrun it by at most
  // requestTimeoutMs.
  const minute = 60 * 1000;
  try {
    const outcome = await publishRelease({
      apiUrl: process.env.GITHUB_API_URL ?? 'https://api.github.com',
      assets,
      body: readFileSync(notes, 'utf8'),
      budgetMs: 60 * minute,
      log: (line) => console.log(line),
      maxAttempts: 5,
      prerelease,
      repository: env('GITHUB_REPOSITORY'),
      requestTimeoutMs: 3 * minute,
      retryDelayMs: 10_000,
      tag,
      token: env('GITHUB_TOKEN'),
    });
    switch (outcome.status) {
      case 'published':
      case 'already-published': {
        console.log(`${outcome.status}: ${outcome.url}`);
        break;
      }
      case 'incomplete': {
        const where = outcome.url ? `draft left at ${outcome.url}` : 'no draft was created';
        console.error(`::error::release ${tag} is incomplete; ${where}`);
        for (const problem of outcome.problems) {
          console.error(problem);
        }
        console.error('re-run this job to resume; no rebuild is needed');
        process.exitCode = 1;
        break;
      }
      case 'refused': {
        console.error(`::error::refusing to publish ${tag}`);
        for (const problem of outcome.problems) {
          console.error(problem);
        }
        process.exitCode = 1;
        break;
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`::error::publishing ${tag} failed unexpectedly: ${reason}`);
    console.error('check the release drafts before re-running; nothing was published');
    process.exitCode = 1;
  }
}

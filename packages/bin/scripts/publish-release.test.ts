import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { publishRelease } from './publish-release';

/**
 * A minimal in-process stand-in for the GitHub Releases REST API: enough
 * surface for the publisher (releases by tag, drafts, asset upload/list/
 * delete/download) plus fault injection on the upload endpoint. Every
 * mutation is recorded in `events` so a test can assert ordering — in
 * particular that publication never precedes the last upload.
 */
type FakeAsset = {
  id: number;
  name: string;
  size: number;
  state: 'uploaded' | 'starter';
  digest: string | null;
  bytes: Uint8Array;
};
type FakeRelease = {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  name: string;
  body: string;
  assets: FakeAsset[];
};
type SeedRelease = Omit<FakeRelease, 'id' | 'assets'> & { assets?: Omit<FakeAsset, 'id'>[] };
type UploadFault = { mode: '500' | 'hang' | 'ghost'; remaining: number };

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

const encode = (text: string) => new TextEncoder().encode(text);

class FakeGitHub {
  readonly releases: FakeRelease[] = [];
  readonly events: string[] = [];
  readonly faults = new Map<string, UploadFault>();
  /** Asset listings that omit assets stored after the marker (eventual consistency). */
  staleListings = 0;
  /** Remaining PATCH /releases/{id} calls to answer with HTTP 500. */
  failPatches = 0;
  private hiddenFrom = Number.MAX_SAFE_INTEGER;
  private nextId = 1;
  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly hung: (() => void)[] = [];

  constructor() {
    this.server = Bun.serve({ fetch: (request) => this.handle(request), port: 0 });
  }

  get url() {
    return `http://127.0.0.1:${this.server.port}`;
  }

  stop() {
    for (const release of this.hung) {
      release();
    }
    void this.server.stop(true);
  }

  /** Seed a release the way GitHub would hold it before the publisher runs. */
  seed(release: SeedRelease) {
    const assets: FakeAsset[] = [];
    for (const asset of release.assets ?? []) {
      assets.push({ ...asset, id: this.nextId++ });
    }
    const created: FakeRelease = { ...release, assets, id: this.nextId++ };
    this.releases.push(created);
    return created;
  }

  /** Fail the next `count` uploads of `name` (HTTP 500, leaving a partial asset). */
  failUploads(name: string, count: number, mode: UploadFault['mode'] = '500') {
    this.faults.set(name, { mode, remaining: count });
  }

  private view(release: FakeRelease) {
    return {
      assets: release.assets.map((asset) => this.assetView(asset)),
      body: release.body,
      draft: release.draft,
      html_url: `${this.url}/releases/${release.tag_name}`,
      id: release.id,
      name: release.name,
      prerelease: release.prerelease,
      tag_name: release.tag_name,
      upload_url: `${this.url}/uploads/releases/${release.id}/assets{?name,label}`,
    };
  }

  private assetView(asset: FakeAsset) {
    return {
      digest: asset.digest,
      id: asset.id,
      name: asset.name,
      size: asset.size,
      state: asset.state,
      url: `${this.url}/repos/o/r/releases/assets/${asset.id}`,
    };
  }

  private json(data: unknown, status = 200) {
    return Response.json(data, { status });
  }

  private release(id: string | undefined) {
    return this.releases.find((release) => release.id === Number(id));
  }

  private async handle(request: Request): Promise<Response> {
    const { method } = request;
    const url = new URL(request.url);
    const path = url.pathname;

    const byTag = /^\/repos\/o\/r\/releases\/tags\/(.+)$/.exec(path);
    if (method === 'GET' && byTag) {
      const release = this.releases.find((r) => !r.draft && r.tag_name === byTag[1]);
      return release ? this.json(this.view(release)) : this.json({ message: 'Not Found' }, 404);
    }
    if (method === 'GET' && path === '/repos/o/r/releases') {
      return this.json(this.releases.toReversed().map((r) => this.view(r)));
    }
    if (method === 'POST' && path === '/repos/o/r/releases') {
      const body = (await request.json()) as Partial<FakeRelease>;
      const release = this.seed({
        body: body.body ?? '',
        draft: body.draft ?? false,
        name: body.name ?? body.tag_name ?? '',
        prerelease: body.prerelease ?? false,
        tag_name: body.tag_name ?? '',
      });
      this.events.push(
        `create-release:${release.tag_name}:draft=${release.draft}:prerelease=${release.prerelease}`,
      );
      return this.json(this.view(release), 201);
    }
    const byId = /^\/repos\/o\/r\/releases\/(\d+)$/.exec(path);
    if (byId) {
      const release = this.release(byId[1]);
      if (!release) {
        return this.json({ message: 'Not Found' }, 404);
      }
      if (method === 'GET') {
        return this.json(this.view(release));
      }
      if (method === 'PATCH') {
        if (this.failPatches > 0) {
          this.failPatches -= 1;
          this.events.push('patch-fail');
          return this.json({ message: 'Server Error' }, 500);
        }
        const body = (await request.json()) as Partial<FakeRelease>;
        Object.assign(release, body);
        this.events.push(
          `patch-release:${release.tag_name}:draft=${release.draft}:prerelease=${release.prerelease}`,
        );
        return this.json(this.view(release));
      }
    }
    const assetList = /^\/repos\/o\/r\/releases\/(\d+)\/assets$/.exec(path);
    if (method === 'GET' && assetList) {
      const release = this.release(assetList[1]);
      if (!release) {
        return this.json({ message: 'Not Found' }, 404);
      }
      let listed = release.assets;
      if (this.staleListings > 0 && this.hiddenFrom !== Number.MAX_SAFE_INTEGER) {
        this.staleListings -= 1;
        listed = listed.filter((asset) => asset.id < this.hiddenFrom);
      }
      return this.json(listed.map((asset) => this.assetView(asset)));
    }
    const oneAsset = /^\/repos\/o\/r\/releases\/assets\/(\d+)$/.exec(path);
    if (oneAsset) {
      const id = Number(oneAsset[1]);
      const release = this.releases.find((r) => r.assets.some((a) => a.id === id));
      const asset = release?.assets.find((a) => a.id === id);
      if (!release || !asset) {
        return this.json({ message: 'Not Found' }, 404);
      }
      if (method === 'DELETE') {
        release.assets = release.assets.filter((a) => a.id !== id);
        this.events.push(`delete-asset:${asset.name}`);
        return new Response(null, { status: 204 });
      }
      if (method === 'GET') {
        if (request.headers.get('accept') === 'application/octet-stream') {
          return new Response(asset.bytes);
        }
        return this.json(this.assetView(asset));
      }
    }
    const upload = /^\/uploads\/releases\/(\d+)\/assets$/.exec(path);
    if (method === 'POST' && upload) {
      const release = this.release(upload[1]);
      const name = url.searchParams.get('name') ?? '';
      if (!release) {
        return this.json({ message: 'Not Found' }, 404);
      }
      if (release.assets.some((a) => a.name === name)) {
        const errors = [{ code: 'already_exists' }];
        return this.json({ errors, message: 'Validation Failed' }, 422);
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      const fault = this.faults.get(name);
      if (fault && fault.remaining > 0) {
        fault.remaining -= 1;
        this.events.push(`upload-fail:${name}`);
        if (fault.mode === 'ghost') {
          // The upload completed server-side but the client never learned it.
          this.hiddenFrom = this.nextId;
          release.assets.push(this.stored(name, bytes));
          return this.json({ message: 'Server Error' }, 500);
        }
        // GitHub leaves a partial asset behind when the upload dies midway.
        const partial: FakeAsset = {
          bytes,
          digest: null,
          id: this.nextId++,
          name,
          size: 0,
          state: 'starter',
        };
        release.assets.push(partial);
        if (fault.mode === 'hang') {
          const { promise, resolve } = Promise.withResolvers<void>();
          this.hung.push(resolve);
          await promise;
        }
        return this.json({ message: 'Server Error' }, 500);
      }
      const asset = this.stored(name, bytes);
      release.assets.push(asset);
      this.events.push(`upload:${name}`);
      return this.json(this.assetView(asset), 201);
    }
    // A hard 4xx: a wrong endpoint must surface as a bug, not as a retried 5xx.
    return this.json({ message: `unhandled ${method} ${path}` }, 400);
  }

  private stored(name: string, bytes: Uint8Array): FakeAsset {
    return {
      bytes,
      digest: `sha256:${sha256(bytes)}`,
      id: this.nextId++,
      name,
      size: bytes.byteLength,
      state: 'uploaded',
    };
  }
}

let github: FakeGitHub;
let dir: string;
let assets: string[];
const FILES = {
  'mimir-darwin-arm64': 'darwin binary bytes',
  'mimir-linux-x64': 'linux binary bytes',
};
const ASSET_NAMES = ['SHA256SUMS', 'mimir-darwin-arm64', 'mimir-linux-x64'];

beforeEach(() => {
  github = new FakeGitHub();
  dir = mkdtempSync(join(tmpdir(), 'publish-release-'));
  const sums: string[] = [];
  for (const [name, content] of Object.entries(FILES)) {
    writeFileSync(join(dir, name), content);
    sums.push(`${sha256(encode(content))}  ${name}`);
  }
  writeFileSync(join(dir, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  assets = [...Object.keys(FILES), 'SHA256SUMS'].map((name) => join(dir, name));
});

afterEach(() => {
  github.stop();
  rmSync(dir, { force: true, recursive: true });
});

async function run(overrides: Partial<Parameters<typeof publishRelease>[0]> = {}) {
  const log: string[] = [];
  const outcome = await publishRelease({
    apiUrl: github.url,
    assets,
    body: 'release notes',
    budgetMs: 60_000,
    log: (line) => log.push(line),
    maxAttempts: 3,
    prerelease: false,
    repository: 'o/r',
    requestTimeoutMs: 5_000,
    retryDelayMs: 1,
    tag: 'v1.2.3',
    token: 'token',
    ...overrides,
  });
  return { log, outcome };
}

function remoteNames(release: FakeRelease | undefined) {
  return (release?.assets ?? []).map((a) => a.name).toSorted();
}

/** A seeded draft for v1.2.3 holding the given assets. */
function draft(seeded: Omit<FakeAsset, 'id'>[]) {
  return github.seed({
    assets: seeded,
    body: 'stale notes',
    draft: true,
    name: 'v1.2.3',
    prerelease: false,
    tag_name: 'v1.2.3',
  });
}

function uploadedAsset(name: string, bytes: Uint8Array): Omit<FakeAsset, 'id'> {
  return {
    bytes,
    digest: `sha256:${sha256(bytes)}`,
    name,
    size: bytes.byteLength,
    state: 'uploaded',
  };
}

function problemsOf(outcome: Awaited<ReturnType<typeof run>>['outcome']) {
  if (outcome.status !== 'incomplete' && outcome.status !== 'refused') {
    throw new Error(`expected problems, got ${outcome.status}`);
  }
  return outcome.problems;
}

describe('publishRelease', () => {
  test('stages a draft, uploads every asset, verifies, then publishes', async () => {
    const { outcome } = await run();

    expect(outcome.status).toBe('published');
    const [release] = github.releases;
    expect(release?.draft).toBe(false);
    expect(release?.body).toBe('release notes');
    expect(remoteNames(release)).toEqual(ASSET_NAMES);
    expect(release?.assets.every((a) => a.state === 'uploaded')).toBe(true);
    // The release object is a draft from creation until after the last upload.
    expect(github.events[0]).toBe('create-release:v1.2.3:draft=true:prerelease=false');
    expect(github.events.at(-1)).toBe('patch-release:v1.2.3:draft=false:prerelease=false');
  });

  test('retries a transient upload failure without touching the other assets', async () => {
    github.failUploads('mimir-linux-x64', 2);

    const { log, outcome } = await run();

    expect(outcome.status).toBe('published');
    expect(github.events.filter((e) => e === 'upload-fail:mimir-linux-x64')).toHaveLength(2);
    expect(github.events.filter((e) => e === 'upload:mimir-linux-x64')).toHaveLength(1);
    expect(github.events.filter((e) => e === 'upload:mimir-darwin-arm64')).toHaveLength(1);
    const linux = github.releases[0]?.assets.find((a) => a.name === 'mimir-linux-x64');
    expect(linux?.digest).toBe(`sha256:${sha256(encode(FILES['mimir-linux-x64']))}`);
    expect(log).toContain('mimir-linux-x64: uploading (attempt 3/3)');
  });

  test('leaves a draft with the verified assets and a diagnosis when retries run out', async () => {
    github.failUploads('mimir-linux-x64', 3);

    const { outcome } = await run();

    expect(outcome.status).toBe('incomplete');
    const [release] = github.releases;
    expect(release?.draft).toBe(true);
    expect(github.events.some((e) => e.startsWith('patch-release:'))).toBe(false);
    const kept = release?.assets.filter((a) => a.state === 'uploaded').map((a) => a.name);
    expect(kept?.toSorted()).toEqual(['SHA256SUMS', 'mimir-darwin-arm64']);
    const problems = problemsOf(outcome);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('mimir-linux-x64: gave up after 3 attempt(s)');
    expect(problems[0]).toContain('attempt 3: ');
    expect(problems[0]).toContain('HTTP 500');
  });

  test('resumes an existing draft: keeps verified assets, replaces partial ones', async () => {
    draft([
      uploadedAsset('mimir-darwin-arm64', encode(FILES['mimir-darwin-arm64'])),
      {
        bytes: new Uint8Array(),
        digest: null,
        name: 'mimir-linux-x64',
        size: 0,
        state: 'starter',
      },
    ]);

    const { log, outcome } = await run();

    expect(outcome.status).toBe('published');
    expect(github.releases).toHaveLength(1);
    expect(github.events).not.toContain('upload:mimir-darwin-arm64');
    expect(github.events).toContain('delete-asset:mimir-linux-x64');
    expect(github.events).toContain('upload:mimir-linux-x64');
    expect(log).toContain('mimir-darwin-arm64: already uploaded and verified, keeping');
    expect(log).toContain('mimir-linux-x64: replacing remote asset (state is starter)');
    expect(remoteNames(github.releases[0])).toEqual(ASSET_NAMES);
    expect(github.releases[0]?.body).toBe('release notes');
  });

  test('verifies by downloading when the API reports no digest', async () => {
    const bytes = encode(FILES['mimir-darwin-arm64']);
    draft([
      {
        bytes,
        digest: null,
        name: 'mimir-darwin-arm64',
        size: bytes.byteLength,
        state: 'uploaded',
      },
    ]);

    const { outcome } = await run();

    expect(outcome.status).toBe('published');
    expect(github.events).not.toContain('upload:mimir-darwin-arm64');
  });

  test('replaces a remote asset whose bytes differ from the local build', async () => {
    draft([uploadedAsset('mimir-darwin-arm64', encode('bytes from some other build'))]);

    const { outcome } = await run();

    expect(outcome.status).toBe('published');
    expect(github.events).toContain('delete-asset:mimir-darwin-arm64');
    expect(github.events).toContain('upload:mimir-darwin-arm64');
  });

  test('is idempotent for a release that is already public and complete', async () => {
    const seeded = github.seed({
      assets: assets.map((path) =>
        uploadedAsset(basename(path), new Uint8Array(readFileSync(path))),
      ),
      body: 'notes',
      draft: false,
      name: 'v1.2.3',
      prerelease: false,
      tag_name: 'v1.2.3',
    });

    const { outcome } = await run();

    expect(outcome.status).toBe('already-published');
    expect(github.events).toEqual([]);
    expect(github.releases).toEqual([seeded]);
  });

  test('refuses to touch a public release whose asset set is wrong', async () => {
    github.seed({
      assets: [
        { bytes: new Uint8Array(), digest: null, name: 'SHA256SUMS', size: 0, state: 'uploaded' },
      ],
      body: 'notes',
      draft: false,
      name: 'v1.2.3',
      prerelease: false,
      tag_name: 'v1.2.3',
    });

    const { outcome } = await run();

    expect(outcome.status).toBe('refused');
    const problems = problemsOf(outcome);
    expect(problems[0]).toContain('already public');
    expect(problems).toContain('mimir-darwin-arm64: missing');
    expect(github.events).toEqual([]);
    expect(github.releases[0]?.draft).toBe(false);
  });

  test('aborts a hung upload at the request deadline and retries', async () => {
    github.failUploads('mimir-darwin-arm64', 1, 'hang');

    const { log, outcome } = await run({ requestTimeoutMs: 250 });

    expect(outcome.status).toBe('published');
    const aborted = log.filter((line) => line.startsWith('mimir-darwin-arm64: POST '));
    expect(aborted).toHaveLength(1);
    expect(github.events).toContain('upload:mimir-darwin-arm64');
  });

  test('refuses before any API call when SHA256SUMS disagrees with the binaries', async () => {
    writeFileSync(join(dir, 'mimir-linux-x64'), 'rebuilt bytes');

    const { outcome } = await run();

    expect(outcome.status).toBe('refused');
    expect(problemsOf(outcome)).toEqual(['SHA256SUMS digest differs for mimir-linux-x64']);
    expect(github.releases).toEqual([]);
  });
  test('publishes a prerelease as a prerelease, from draft to public', async () => {
    const { outcome } = await run({ prerelease: true });

    expect(outcome.status).toBe('published');
    expect(github.events[0]).toBe('create-release:v1.2.3:draft=true:prerelease=true');
    expect(github.events.at(-1)).toBe('patch-release:v1.2.3:draft=false:prerelease=true');
    expect(github.releases[0]?.prerelease).toBe(true);
  });

  test('recovers an upload that completed server-side after the client gave up', async () => {
    github.failUploads('mimir-linux-x64', 1, 'ghost');
    github.staleListings = 1;

    const { log, outcome } = await run();

    expect(outcome.status).toBe('published');
    // Attempt 2 saw a stale listing, re-sent, and hit 422; attempt 3 found and kept it.
    expect(log).toContain('mimir-linux-x64: uploading (attempt 2/3)');
    expect(log.some((line) => line.includes('asset already exists'))).toBe(true);
    expect(log).toContain('mimir-linux-x64: already uploaded and verified, keeping');
    expect(github.events.filter((e) => e === 'upload:mimir-linux-x64')).toHaveLength(0);
    expect(remoteNames(github.releases[0])).toEqual(ASSET_NAMES);
  });

  test('retries a transient failure of the final publish call', async () => {
    github.failPatches = 1;

    const { outcome } = await run();

    expect(outcome.status).toBe('published');
    expect(github.events).toContain('patch-fail');
    expect(github.releases[0]?.draft).toBe(false);
  });

  test('stops retrying when the overall time budget is spent', async () => {
    github.failUploads('mimir-linux-x64', 3);

    const { outcome } = await run({ budgetMs: 0, retryDelayMs: 5 });

    expect(outcome.status).toBe('incomplete');
    const [problem] = problemsOf(outcome);
    expect(problem).toContain('gave up after 2 attempt(s)');
    expect(problem).toContain('time budget of 0 ms exhausted');
    expect(github.events.filter((e) => e === 'upload-fail:mimir-linux-x64')).toHaveLength(1);
  });

  test('refuses when the tag already has more than one draft', async () => {
    draft([]);
    draft([]);

    const { outcome } = await run();

    expect(outcome.status).toBe('refused');
    expect(problemsOf(outcome)[0]).toContain('has 2 drafts');
    expect(github.events).toEqual([]);
  });
});

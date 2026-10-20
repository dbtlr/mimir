import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EngineInput } from '@mimir/contract';
import { RemoteEngine } from '@mimir/wire/client';

import { assertPrecache } from '../scripts/assert-precache';
import { pairFixtureDevice } from '../scripts/pairing-client';

const HOST_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

/** The project the fixture's host holds, so a cached read has something to show. */
export const FIXTURE_PROJECT = { key: 'PWA', name: 'Offline-ready operator project' };

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

/** The routes the host answers itself rather than the app shell. */
const SERVER_ROUTE = /^\/(api|trpc|_serverFn|auth\/pairing)(\/|$)/;

/** Request headers the proxy does not forward: the host checks them against its own origin. */
const UNFORWARDED = new Set(['connection', 'host', 'origin', 'referer']);

function extension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot);
}

/** Build the console, then copy its public files (and, for `host`, the whole server) out. */
async function build(root: string, version: string, host?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('bun', [resolvePath(HOST_ROOT, 'node_modules/vite/bin/vite.js'), 'build'], {
      cwd: HOST_ROOT,
      env: { ...process.env, MIMIR_BUILD_VERSION: version },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`PWA fixture ${version} build exited ${String(code)}`));
      }
    });
  });
  await cp(resolvePath(HOST_ROOT, '.output/public'), root, { recursive: true });
  if (host !== undefined) {
    await cp(resolvePath(HOST_ROOT, '.output'), host, { recursive: true });
  }
  await assertPrecache(root);
}

/** A loopback port nothing is listening on. */
async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (address === null || typeof address === 'string') {
    throw new Error('no free loopback port');
  }
  return address.port;
}

/** A request's body as text: every server route the console calls carries JSON. */
async function bodyOf(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return chunks.length === 0 ? undefined : Buffer.concat(chunks).toString('utf8');
}

/**
 * Two console builds served from one origin, the way an upgraded host serves
 * its new build to a tab still running the old one. The app shell and assets
 * come from whichever build is current. The server routes (`/api`, `/trpc`,
 * and the server functions) reach a real host built from build A, over a
 * scratch store holding {@link FIXTURE_PROJECT}. `/health` is answered here,
 * so a case can report a host version that differs from the bundle's.
 */
export class PwaFixture {
  readonly buildA: string;
  readonly buildB: string;
  origin = '';
  private hostOnline = true;
  private healthVersion: string;
  private host: ChildProcess | undefined;
  private readonly hostLines: string[] = [];
  private hostOrigin = '';
  private token = '';
  private storeFile = '';
  private root: string;
  private readonly server: Server;
  private readonly temporaryRoot: string;

  private constructor(temporaryRoot: string, buildA: string, buildB: string) {
    this.temporaryRoot = temporaryRoot;
    this.buildA = buildA;
    this.buildB = buildB;
    this.root = buildA;
    this.healthVersion = '0.26.0-next.1';
    this.server = createServer(async (request, response) => {
      try {
        await this.respond(request, response);
      } catch (error) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(error instanceof Error ? error.message : String(error));
      }
    });
  }

  static async create(): Promise<PwaFixture> {
    const temporaryRoot = await mkdtemp(resolvePath(tmpdir(), 'mimir-pwa-'));
    const buildA = resolvePath(temporaryRoot, 'build-a');
    const buildB = resolvePath(temporaryRoot, 'build-b');
    const hostA = resolvePath(temporaryRoot, 'host-a');
    let fixture: PwaFixture | undefined;
    try {
      await build(buildA, '0.26.0-next.1', hostA);
      await build(buildB, '0.26.0-next.2');
      fixture = new PwaFixture(temporaryRoot, buildA, buildB);
      await fixture.startHost(hostA);
      await fixture.start();
      return fixture;
    } catch (error) {
      fixture?.stopHost();
      await rm(temporaryRoot, { force: true, recursive: true });
      throw error;
    }
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    this.server.close();
    this.server.unref();
    this.stopHost();
    await rm(this.temporaryRoot, { force: true, recursive: true });
  }

  setHostOnline(online: boolean): void {
    this.hostOnline = online;
  }

  setHealthVersion(version: string): void {
    this.healthVersion = version;
  }

  useBuildB(): void {
    this.root = this.buildB;
    this.healthVersion = '0.26.0-next.2';
  }

  /** Start build A's host over a scratch store and file the fixture project. */
  private async startHost(hostRoot: string): Promise<void> {
    const port = await freePort();
    const dataDirectory = resolvePath(this.temporaryRoot, 'data');
    await mkdir(dataDirectory, { recursive: true });
    this.storeFile = resolvePath(dataDirectory, 'store.sqlite');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MIMIR_DATA_DIR: dataDirectory,
      MIMIR_PORT: String(port),
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: String(port),
    };
    delete env.TSS_PRERENDERING;
    delete env.MIMIR_DATABASE_URL;
    delete env.MIMIR_DATABASE_URL_FILE;
    this.host = spawn('bun', [resolvePath(hostRoot, 'server/index.mjs')], {
      env,
      stdio: ['ignore', 'inherit', 'pipe'],
    });
    // The host logs to stderr; keep its lines for a case to read, and echo them.
    this.host.stderr?.setEncoding('utf8');
    this.host.stderr?.on('data', (chunk: string) => {
      process.stderr.write(chunk);
      this.hostLines.push(...chunk.split('\n').filter((line) => line !== ''));
    });
    this.hostOrigin = `http://127.0.0.1:${String(port)}`;
    await this.waitForHost();
    // The fixture approves as the operator would, through a script over the host's store.
    this.token = await pairFixtureDevice(
      this.hostOrigin,
      'PWA fixture',
      (code) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn('bun', [resolvePath(HOST_ROOT, 'scripts/pairing-fixture.ts'), code], {
            env,
            stdio: ['ignore', 'ignore', 'inherit'],
          });
          child.once('error', reject);
          child.once('exit', (exit) => {
            if (exit === 0) {
              resolve();
            } else {
              reject(new Error(`PWA fixture pairing approval exited ${String(exit)}`));
            }
          });
        }),
    );
    await this.create({ ...FIXTURE_PROJECT, type: 'project' });
  }

  /** What the host has logged to stderr so far, a line per entry. */
  hostLog(): readonly string[] {
    return [...this.hostLines];
  }

  /** File a record on the host through its Engine, and answer its id. */
  async create(input: EngineInput<'create'>): Promise<{ id: string }> {
    const engine = new RemoteEngine({
      headers: { authorization: `Bearer ${this.token}` },
      url: `${this.hostOrigin}/trpc`,
      version: '0.26.0-next.1',
    });
    const created = await engine.create(input);
    return { id: created.id };
  }

  /**
   * Write one statement straight into the host's store, as damage a host
   * could find there: the one way a case can make a read fault inside the host.
   */
  async damageStore(sql: string, ...params: string[]): Promise<void> {
    const script =
      "const { Database } = require('bun:sqlite');" +
      'const [file, sql, ...params] = process.argv.slice(1);' +
      'const db = new Database(file);' +
      'db.exec("PRAGMA busy_timeout = 5000");' +
      'db.query(sql).run(...params);' +
      'db.close();';
    await new Promise<void>((resolve, reject) => {
      const child = spawn('bun', ['-e', script, this.storeFile, sql, ...params], {
        stdio: 'inherit',
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`store damage exited ${String(code)}`));
        }
      });
    });
  }

  private async waitForHost(): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (this.host?.exitCode !== null) {
        throw new Error('PWA fixture host exited before it answered');
      }
      try {
        if ((await fetch(`${this.hostOrigin}/health`)).ok) {
          return;
        }
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('PWA fixture host did not answer within 30s');
  }

  private stopHost(): void {
    this.host?.kill();
    this.host = undefined;
  }

  /** Forward a server-route request to the host and relay its answer. */
  private async proxy(request: IncomingMessage, url: URL, response: ServerResponse) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (!UNFORWARDED.has(name) && value !== undefined) {
        headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
    }
    const method = request.method ?? 'GET';
    const answer = await fetch(`${this.hostOrigin}${url.pathname}${url.search}`, {
      body: method === 'GET' || method === 'HEAD' ? undefined : await bodyOf(request),
      headers,
      method,
    });
    const relayed: Record<string, string> = {};
    answer.headers.forEach((value, name) => {
      if (name !== 'content-encoding' && name !== 'content-length') {
        relayed[name] = value;
      }
    });
    response.writeHead(answer.status, relayed);
    response.end(Buffer.from(await answer.arrayBuffer()));
  }

  private async respond(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', this.origin);
    if (url.pathname === '/health') {
      response.writeHead(this.hostOnline ? 200 : 503, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(
        this.hostOnline
          ? JSON.stringify({
              minClient: '0.26.0-next',
              schema: 10,
              status: 'ok',
              version: this.healthVersion,
            })
          : 'offline',
      );
      return;
    }
    if (SERVER_ROUTE.test(url.pathname)) {
      if (!this.hostOnline) {
        response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('offline');
        return;
      }
      await this.proxy(request, url, response);
      return;
    }

    const requestPath =
      url.pathname === '/' ? '_shell.html' : decodeURIComponent(url.pathname.slice(1));
    let filePath = resolvePath(this.root, requestPath);
    if (!filePath.startsWith(`${this.root}/`)) {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    let body: Buffer;
    try {
      body = await readFile(filePath);
    } catch {
      filePath = resolvePath(this.root, '_shell.html');
      body = await readFile(filePath);
    }
    const immutable = url.pathname.startsWith('/assets/');
    response.writeHead(200, {
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'content-type': CONTENT_TYPES[extension(filePath)] ?? 'application/octet-stream',
    });
    response.end(body);
  }

  private async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('fixture has no TCP port');
    }
    this.origin = `http://127.0.0.1:${String(address.port)}`;
  }
}

export async function precacheUrls(buildRoot: string): Promise<string[]> {
  return assertPrecache(buildRoot);
}

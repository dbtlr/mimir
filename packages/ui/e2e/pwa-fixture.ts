import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

function extension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot);
}

async function build(root: string, version: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('bun', ['run', 'vite', 'build', '--outDir', root], {
      cwd: UI_ROOT,
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
}

export class PwaFixture {
  readonly buildA: string;
  readonly buildB: string;
  origin = '';
  private apiOnline = true;
  private healthVersion: string;
  private root: string;
  private readonly server: Server;
  private readonly temporaryRoot: string;

  private constructor(temporaryRoot: string, buildA: string, buildB: string) {
    this.temporaryRoot = temporaryRoot;
    this.buildA = buildA;
    this.buildB = buildB;
    this.root = buildA;
    this.healthVersion = 'build-a';
    this.server = createServer(async (request, response) => {
      try {
        await this.respond(request.url ?? '/', response);
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
    await build(buildA, 'build-a');
    await build(buildB, 'build-b');
    const fixture = new PwaFixture(temporaryRoot, buildA, buildB);
    await fixture.start();
    return fixture;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    this.server.close();
    this.server.unref();
    await rm(this.temporaryRoot, { force: true, recursive: true });
  }

  setApiOnline(online: boolean): void {
    this.apiOnline = online;
  }

  setHealthVersion(version: string): void {
    this.healthVersion = version;
  }

  useBuildB(): void {
    this.root = this.buildB;
    this.healthVersion = 'build-b';
  }

  private api(path: string): { body: string; status: number } {
    if (!this.apiOnline) {
      return { body: 'offline', status: 503 };
    }
    if (path === '/api/health') {
      return {
        body: JSON.stringify({ schema: 10, status: 'ok', version: this.healthVersion }),
        status: 200,
      };
    }
    if (path === '/api/doctor') {
      return {
        body: JSON.stringify({
          dropped_total: 0,
          groups: [],
          scanned_at: '2026-08-06T12:00:00.000Z',
        }),
        status: 200,
      };
    }
    return { body: JSON.stringify({ items: [], total: 0 }), status: 200 };
  }

  private async respond(pathWithQuery: string, response: ServerResponse) {
    const url = new URL(pathWithQuery, this.origin);
    if (url.pathname.startsWith('/api/')) {
      const result = this.api(url.pathname);
      response.writeHead(result.status, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(result.body);
      return;
    }

    const requestPath =
      url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
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
      filePath = resolvePath(this.root, 'index.html');
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
  const worker = await readFile(resolvePath(buildRoot, 'sw.js'), 'utf8');
  const start = worker.indexOf('precacheAndRoute([');
  const end = worker.indexOf('],{})', start);
  if (start === -1 || end === -1) {
    throw new Error('generated worker has no precache manifest');
  }
  return [...worker.slice(start, end).matchAll(/\{url:"([^"]+)"/g)].map((match) => match[1]);
}

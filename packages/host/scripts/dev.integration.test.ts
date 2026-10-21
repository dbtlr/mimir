/// <reference types="bun" />

import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MIN_CLIENT } from '@mimir/contract';
import { RemoteEngine } from '@mimir/wire/client';
import { chromium } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { z } from 'zod';

import { runHostCli } from './host-cli';

const clientVersion = MIN_CLIENT;

const hostRoot = fileURLToPath(new URL('..', import.meta.url));
const viteEntry = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const generatedRoutes = new URL('../src/routeTree.gen.ts', import.meta.url);

test('the development host serves and renders the kit with an isolated store', async () => {
  const routesBefore = await Bun.file(generatedRoutes).text();
  const directory = await mkdtemp(join(tmpdir(), 'mimir-dev-test-'));
  try {
    // Vite treats port 0 as its default. Reserve an OS-assigned port first.
    const reservation = Bun.serve({
      fetch: () => new Response(null, { status: 503 }),
      hostname: '127.0.0.1',
      port: 0,
    });
    const port = reservation.port;
    await reservation.stop(true);
    const base = `http://127.0.0.1:${String(port)}`;
    const child = Bun.spawn(
      ['bun', viteEntry, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      {
        cwd: hostRoot,
        env: {
          ...process.env,
          FORCE_COLOR: undefined,
          MIMIR_DATABASE_URL: undefined,
          MIMIR_DATABASE_URL_FILE: undefined,
          MIMIR_DATA_DIR: directory,
          MIMIR_HOSTS: '',
          MIMIR_URL: undefined,
          NODE_ENV: 'development',
          NO_COLOR: '1',
          VITEST: undefined,
        },
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      },
    );
    let diagnostics = '';
    let browser: Browser | undefined;
    const capture = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        diagnostics = `${diagnostics}${decoder.decode(chunk, { stream: true })}`.slice(-16_000);
      }
    };
    const output = [capture(child.stdout), capture(child.stderr)];
    try {
      let readiness = 'no listener';
      let ready = false;
      for (let attempt = 0; attempt < 150; attempt++) {
        if (child.exitCode !== null) {
          throw new Error(`Vite exited before readiness (${child.exitCode}): ${diagnostics}`);
        }
        try {
          const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
          readiness = `${health.status} ${health.headers.get('content-type') ?? 'no content type'}`;
          if (health.ok && health.headers.get('content-type')?.includes('application/json')) {
            expect(await health.json()).toMatchObject({ status: 'ok' });
            ready = true;
            break;
          }
        } catch {
          // The listener can open before Start has loaded the server route.
        }
        await Bun.sleep(100);
      }
      if (!ready) {
        throw new Error(`development host did not become ready (${readiness}): ${diagnostics}`);
      }
      const unauthorized = await fetch(`${base}/trpc/projects`, {
        headers: { 'x-mimir-version': clientVersion },
      });
      expect(unauthorized.status).toBe(401);
      expect(await unauthorized.json()).toMatchObject({
        error: { json: { data: { code: 'UNAUTHORIZED' }, message: 'unauthorized' } },
      });
      for (const path of ['/auth/pairing/requests', '/auth/pairing/poll']) {
        for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) {
          const unsupported = await fetch(`${base}${path}`, { method });
          expect(unsupported.status, `${method} ${path}`).toBe(405);
          expect(unsupported.headers.get('allow'), `${method} ${path}`).toBe('POST');
          expect(unsupported.headers.get('cache-control'), `${method} ${path}`).toBe('no-store');
        }
      }
      // The host-minted code exchange is gone; unknown /auth paths answer a JSON 404, never the shell.
      for (const [path, method] of [
        ['/auth/pairing/redeem', 'POST'],
        ['/auth/pairing/redeem', 'GET'],
        ['/auth', 'GET'],
      ] as const) {
        const unknown = await fetch(`${base}${path}`, { method });
        expect(unknown.status, `${method} ${path}`).toBe(404);
        expect(unknown.headers.get('cache-control'), `${method} ${path}`).toBe('no-store');
        expect(await unknown.json(), `${method} ${path}`).toMatchObject({
          error: { code: 'not_found' },
        });
      }
      // Pairing is a host route: neither a client version nor an existing token is needed.
      const post = (path: string, body: unknown) =>
        fetch(`${base}/auth/pairing/${path}`, {
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        });
      const filed = await post('requests', { device: 'development fixture' });
      expect(filed.status).toBe(200);
      expect(filed.headers.get('cache-control')).toBe('no-store');
      const request = z
        .object({ interval: z.number(), poll_secret: z.string(), user_code: z.string() })
        .parse(await filed.json());
      const pollOnce = async () =>
        (await post('poll', { poll_secret: request.poll_secret })).json();
      expect(await pollOnce()).toEqual({ status: 'pending' });
      expect(
        JSON.parse(await runHostCli(['approve', request.user_code], { MIMIR_DATA_DIR: directory })),
      ).toEqual({ device: 'development fixture', rotates: false });
      const paired = z
        .object({ device: z.string(), status: z.literal('approved'), token: z.string() })
        .parse(await pollOnce());
      expect(paired.device).toBe('development fixture');
      expect(paired.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await pollOnce()).toEqual({ status: 'expired' });
      const remote = new RemoteEngine({
        headers: { authorization: `Bearer ${paired.token}` },
        url: `${base}/trpc`,
        version: clientVersion,
      });
      expect(await remote.projects({})).toEqual([]);
      expect(await Bun.file(join(directory, 'store.sqlite')).exists()).toBe(true);

      await remote.create({ key: 'TST', name: 'Start Engine fixture', type: 'project' });
      await remote.create({ parent: 'TST', title: 'Start Engine', type: 'initiative' });
      await remote.create({ parent: 'TST-1', title: 'Complete through Start', type: 'task' });
      const task = await remote.getNode({ id: 'TST-2' });
      expect(task).toMatchObject({ lifecycle: 'todo', title: 'Complete through Start' });
      expect(task.createdAt).toBeInstanceOf(Date);
      for (const path of ['/trpc/getNode', '/trpc/done']) {
        const crossOrigin = await fetch(`${base}${path}`, {
          headers: { origin: 'https://other.example' },
          method: 'POST',
        });
        expect(crossOrigin.status, path).toBe(403);
        expect(await crossOrigin.json()).toMatchObject({ error: { code: 'forbidden_origin' } });
      }
      expect((await remote.getNode({ id: 'TST-2' })).lifecycle).toBe('todo');
      const completed = await remote.done({ id: 'TST-2' });
      expect(completed.lifecycle).toBe('done');
      expect(completed.completedAt).toBeInstanceOf(Date);
      expect(await remote.getNode({ id: 'TST-2' })).toMatchObject({
        id: 'TST-2',
        lifecycle: 'done',
      });

      const document = await fetch(`${base}/kit`);
      expect(document.status).toBe(200);
      expect(document.headers.get('content-type')).toContain('text/html');
      const html = await document.text();
      expect(html).toMatch(/<script[^>]*type="module"/);
      const entry = /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(html)?.[1];
      if (entry === undefined) {
        throw new Error('the development document has no module entry');
      }
      const module = await fetch(new URL(entry, base));
      expect(module.status).toBe(200);
      expect(module.headers.get('content-type')).toMatch(/(?:application|text)\/javascript/);
      const kit = await fetch(`${base}/src/routes/kit.tsx`);
      expect(kit.status).toBe(200);
      expect(kit.headers.get('content-type')).toMatch(/(?:application|text)\/javascript/);
      expect(await kit.text()).toContain('Meridian kit');

      browser = await chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      });
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${base}/kit`, { timeout: 20_000 });
      await page
        .getByRole('heading', { exact: true, name: 'Meridian kit' })
        .waitFor({ timeout: 20_000 });
      expect(errors).toEqual([]);
    } finally {
      await browser?.close().catch(() => undefined);
      const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        child.kill('SIGTERM');
        await child.exited;
        await Promise.all(output);
      } finally {
        clearTimeout(deadline);
      }
      expect(await Bun.file(generatedRoutes).text()).toBe(routesBefore);
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 90_000);

test('the development host refuses an occupied MIMIR_PORT instead of choosing another port', async () => {
  const reservation = Bun.serve({
    fetch: () => new Response('reserved'),
    hostname: '127.0.0.1',
    port: 0,
  });
  const directory = await mkdtemp(join(tmpdir(), 'mimir-dev-port-'));
  const child = Bun.spawn(
    [process.execPath, fileURLToPath(new URL('dev.ts', import.meta.url)), '--host', '127.0.0.1'],
    {
      cwd: hostRoot,
      detached: true,
      env: {
        ...process.env,
        MIMIR_DATABASE_URL: undefined,
        MIMIR_DATABASE_URL_FILE: undefined,
        MIMIR_DATA_DIR: directory,
        MIMIR_PORT: String(reservation.port),
        VITEST: undefined,
      },
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    },
  );
  let timedOut = false;
  const stop = () => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, 8000);
  try {
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(timedOut, `${stdout}\n${stderr}`).toBe(false);
    expect(exit).not.toBe(0);
    expect(`${stdout}\n${stderr}`).toContain('already in use');
  } finally {
    clearTimeout(timer);
    stop();
    await child.exited;
    await reservation.stop(true);
    await rm(directory, { force: true, recursive: true });
  }
}, 15_000);

test('the development launcher exits when Postgres authority is missing', async () => {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('dev.ts', import.meta.url))], {
    cwd: hostRoot,
    detached: true,
    env: {
      ...process.env,
      MIMIR_DATABASE_URL: 'postgres://live:secret@production.invalid/live',
      MIMIR_DATABASE_URL_FILE: undefined,
      MIMIR_SANDBOX_AUTHORITY: undefined,
      VITEST: undefined,
    },
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  const stop = () => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, 5000);
  try {
    const [exit, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    expect(timedOut).toBe(false);
    expect(exit).not.toBe(0);
    expect(stderr).toContain('registered live installation');
  } finally {
    clearTimeout(timer);
    stop();
    await child.exited;
  }
}, 10_000);

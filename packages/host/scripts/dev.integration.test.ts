/// <reference types="bun" />

import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';
import type { Browser } from '@playwright/test';

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
          const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
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
        throw new Error(`development API did not become ready (${readiness}): ${diagnostics}`);
      }
      const projects = await fetch(`${base}/api/projects`);
      expect(projects.status).toBe(200);
      expect(await projects.json()).toMatchObject({ items: [], total: 0 });
      expect(await Bun.file(join(directory, 'store.sqlite')).exists()).toBe(true);

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

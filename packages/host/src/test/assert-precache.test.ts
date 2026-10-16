// This build-tool regression intentionally exercises a temporary filesystem.
// oxlint-disable-next-line import/no-nodejs-modules
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
// oxlint-disable-next-line import/no-nodejs-modules
import { tmpdir } from 'node:os';
// oxlint-disable-next-line import/no-nodejs-modules
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assertPrecache } from '../../scripts/assert-precache';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('precache assertion (MMR-369)', () => {
  it('rejects a unique manifest that omits required app-shell assets', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'mimir-precache-test-'));
    temporaryRoots.push(root);
    await mkdir(resolve(root, 'assets'));
    await writeFile(resolve(root, 'workbox-test.js'), 'define([]);');
    await writeFile(
      resolve(root, 'sw.js'),
      String.raw`define(["./workbox-test"],()=>{});precacheAndRoute([{url:"_shell.html",revision:"1"}],{});denylist:[/^\/api\//]`,
    );

    await expect(assertPrecache(root)).rejects.toThrow(
      'precache manifest is missing application JavaScript',
    );
  });
});

async function completeShell(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'mimir-precache-test-'));
  temporaryRoots.push(root);
  await mkdir(resolve(root, 'assets'));
  await mkdir(resolve(root, 'icons'));
  const urls = [
    '_shell.html',
    'assets/app.js',
    'assets/app.css',
    'assets/font.woff2',
    'manifest.webmanifest',
    'icons/mimir.svg',
    'icons/mimir-maskable.svg',
  ];
  await Promise.all(urls.map((url) => writeFile(resolve(root, url), 'asset')));
  await writeFile(resolve(root, 'workbox-test.js'), 'define([]);');
  await writeFile(
    resolve(root, 'sw.js'),
    `define(["./workbox-test"],()=>{});precacheAndRoute([${urls.map((url) => `{url:"${url}",revision:"1"}`).join(',')}],{});${String.raw`createHandlerBoundToURL("/_shell.html");denylist:[/^\/(api|trpc|_serverFn|health)([/?]|$)/]`}`,
  );
  return root;
}

test('rejects a manifest that omits an emitted application chunk', async () => {
  const root = await completeShell();
  await writeFile(resolve(root, 'assets/lazy-page.js'), 'export {};');
  await expect(assertPrecache(root)).rejects.toThrow(
    'precache manifest is missing assets/lazy-page.js',
  );
});

test('accepts the complete final public shell and its emitted files', async () => {
  const root = await completeShell();
  const urls = await assertPrecache(root);
  expect(urls).toContain('_shell.html');
  expect(urls).toHaveLength(7);
});

test('rejects a precached file absent from the final public output', async () => {
  const root = await completeShell();
  await rm(resolve(root, 'assets/app.js'));
  await expect(assertPrecache(root)).rejects.toThrow('precached file is missing: assets/app.js');
});

test('rejects navigation fallback to any HTML other than the prerendered shell', async () => {
  const root = await completeShell();
  const worker = await readFile(resolve(root, 'sw.js'), 'utf8');
  await writeFile(
    resolve(root, 'sw.js'),
    worker.replace(
      'createHandlerBoundToURL("/_shell.html")',
      'createHandlerBoundToURL("/index.html")',
    ),
  );
  await expect(assertPrecache(root)).rejects.toThrow('navigation fallback must use /_shell.html');
});

test.each(['api', 'trpc', '_serverFn', 'health'])(
  'rejects navigation fallback that leaves the exact /%s server route unprotected',
  async (prefix) => {
    const root = await completeShell();
    const worker = await readFile(resolve(root, 'sw.js'), 'utf8');
    const exclusions = ['api', 'trpc', '_serverFn', 'health']
      .map((name) => (name === prefix ? `${name}\\/` : `${name}([/?]|$)`))
      .join('|');
    await writeFile(
      resolve(root, 'sw.js'),
      worker.replace(String.raw`/^\/(api|trpc|_serverFn|health)([/?]|$)/`, `/^\\/(${exclusions})/`),
    );
    await expect(assertPrecache(root)).rejects.toThrow(`no longer excludes /${prefix}`);
  },
);

test('rejects directories in place of precached files', async () => {
  const root = await completeShell();
  await rm(resolve(root, 'assets/app.js'));
  await mkdir(resolve(root, 'assets/app.js'));
  await expect(assertPrecache(root)).rejects.toThrow('precached file is missing: assets/app.js');
});

test('rejects navigation fallback that admits an exact server path with query parameters', async () => {
  const root = await completeShell();
  const worker = await readFile(resolve(root, 'sw.js'), 'utf8');
  await writeFile(resolve(root, 'sw.js'), worker.replace('([/?]|$)', String.raw`(\/|$)`));
  await expect(assertPrecache(root)).rejects.toThrow('no longer excludes /api?probe=1');
});

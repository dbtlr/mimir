/// <reference types="bun" />

import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export const PRECACHE_ASSERTION = 'complete app-shell coverage';

export async function assertPrecache(dist: string): Promise<string[]> {
  const workerPath = resolve(dist, 'sw.js');
  const worker = await readFile(workerPath, 'utf8');
  const manifestStart = worker.indexOf('precacheAndRoute([');
  const manifestEnd = worker.indexOf('],{})', manifestStart);
  if (manifestStart === -1 || manifestEnd === -1) {
    throw new Error(`could not find the precache manifest in ${workerPath}`);
  }
  const manifest = worker.slice(manifestStart, manifestEnd);
  const urls = [...manifest.matchAll(/\{url:"([^"]+)"/g)].map((match) => match[1]);
  if (urls.length === 0) {
    throw new Error('precache manifest contains no URLs');
  }

  const duplicates = [...new Set(urls.filter((url, index) => urls.indexOf(url) !== index))];
  if (duplicates.length > 0) {
    throw new Error(`duplicate precache URLs: ${duplicates.join(', ')}`);
  }

  const required = [
    ['prerendered shell', (url: string) => url === '_shell.html'],
    ['application JavaScript', (url: string) => url.startsWith('assets/') && url.endsWith('.js')],
    ['application CSS', (url: string) => url.startsWith('assets/') && url.endsWith('.css')],
    ['font', (url: string) => url.startsWith('assets/') && url.endsWith('.woff2')],
    ['web manifest', (url: string) => url === 'manifest.webmanifest'],
    ['standard icon', (url: string) => url === 'icons/mimir.svg'],
    ['maskable icon', (url: string) => url === 'icons/mimir-maskable.svg'],
  ] as const;
  for (const [label, predicate] of required) {
    if (!urls.some(predicate)) {
      throw new Error(`precache manifest is missing ${label}`);
    }
  }

  const workboxMatch = /define\(\["\.\/([^"']*workbox[^"']*)"\]/.exec(worker);
  if (workboxMatch?.[1] === undefined) {
    throw new Error('generated Workbox runtime is missing');
  }
  try {
    if (!(await stat(resolve(dist, `${workboxMatch[1]}.js`))).isFile()) {
      throw new Error('generated Workbox runtime is missing');
    }
  } catch {
    throw new Error('generated Workbox runtime is missing');
  }
  const emitted = await readdir(dist, { recursive: true });
  const appAssets = emitted.filter(
    (path) => path.startsWith('assets/') && /\.(css|html|js|woff2)$/.test(path),
  );
  for (const asset of appAssets) {
    if (!urls.includes(asset)) {
      throw new Error(`precache manifest is missing ${asset}`);
    }
  }
  for (const url of urls) {
    try {
      if (!(await stat(resolve(dist, url))).isFile()) {
        throw new Error(`precached file is missing: ${url}`);
      }
    } catch {
      throw new Error(`precached file is missing: ${url}`);
    }
  }
  if (!worker.includes('createHandlerBoundToURL("/_shell.html")')) {
    throw new Error('service worker navigation fallback must use /_shell.html');
  }
  const denylist = /denylist:\[((?:\[[^\]]*\]|[^\]])*)\]/.exec(worker)?.[1] ?? '';
  const exclusions = [...denylist.matchAll(/\/((?:\\.|\[[^\]]*\]|[^/])*)\/([dgimsuvy]*)/g)].map(
    (match) => new RegExp(match[1] ?? '', match[2]),
  );
  const denied = (path: string) => exclusions.some((pattern) => pattern.test(path));
  for (const prefix of ['api', 'trpc', '_serverFn', 'health']) {
    for (const path of [`/${prefix}`, `/${prefix}?probe=1`, `/${prefix}/probe`]) {
      if (!denied(path)) {
        throw new Error(`service worker navigation fallback no longer excludes ${path}`);
      }
    }
    if (denied(`/${prefix}-page`)) {
      throw new Error(`service worker navigation fallback also excludes /${prefix}-page`);
    }
  }

  return urls;
}

if (import.meta.main) {
  const urls = await assertPrecache(process.argv[2] ?? '.output/public');
  console.log(`precache: ${urls.length} unique URLs with ${PRECACHE_ASSERTION}`);
}

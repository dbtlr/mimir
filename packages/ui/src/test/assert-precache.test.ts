// This build-tool regression intentionally exercises a temporary filesystem.
// oxlint-disable-next-line import/no-nodejs-modules
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
      String.raw`define(["./workbox-test"],()=>{});precacheAndRoute([{url:"index.html",revision:"1"}],{});denylist:[/^\/api\//]`,
    );

    await expect(assertPrecache(root)).rejects.toThrow(
      'precache manifest is missing application JavaScript',
    );
  });
});

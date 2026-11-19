/// <reference types="bun" />

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPushWorker } from './push-worker';

/*
 * The push worker's build (MMR-710), against a stand-in host package in a
 * temporary directory, so the test's working directory is never the root.
 */

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'mimir-push-worker-'));
  await mkdir(join(root, 'src/sw'), { recursive: true });
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

async function buildWith(source: string): Promise<string> {
  await writeFile(join(root, 'src/sw/push-entry.ts'), source);
  return buildPushWorker({ root });
}

test('writes a content-named script under the given root, wherever the process runs', async () => {
  expect(process.cwd()).not.toBe(root);
  const name = await buildWith("self.addEventListener('push', () => {});\n");
  expect(name).toMatch(/^sw-push-[\w-]{6,}\.js$/);
  const script = await readFile(join(root, '.output/public', name), 'utf8');
  expect(script).toContain('addEventListener');
});

test('renames the script when the handlers change, and only then', async () => {
  const first = await buildWith("self.addEventListener('push', () => {});\n");
  const again = await buildWith("self.addEventListener('push', () => {});\n");
  const changed = await buildWith("self.addEventListener('notificationclick', () => {});\n");
  expect(again).toBe(first);
  expect(changed).not.toBe(first);
});

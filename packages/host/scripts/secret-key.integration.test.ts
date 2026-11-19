/// <reference types="bun" />

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MIN_CLIENT } from '@mimir/contract';
import { openSecret, parseSecretKey } from '@mimir/core';
import { RemoteEngine } from '@mimir/wire/client';
import { z } from 'zod';

import { readVapidKeys } from '../src/server/push-protocol';
import { runHostCli } from './host-cli';

const hostRoot = fileURLToPath(new URL('..', import.meta.url));
const viteEntry = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const launcher = fileURLToPath(new URL('start.ts', import.meta.url));

/** The sealed VAPID pair the push channel stores, if any, read from the host's SQLite store. */
function sealedPushKey(directory: string): string | undefined {
  const store = new Database(join(directory, 'store.sqlite'), { readonly: true });
  try {
    const row = store
      .query<{ ciphertext: string }, [string]>('SELECT ciphertext FROM host_secrets WHERE name = ?')
      .get('push.vapid');
    return row?.ciphertext;
  } finally {
    store.close();
  }
}

/** Every host setting the test does not choose, cleared so the shell's own cannot leak in. */
const unset = {
  MIMIR_DATABASE_URL: undefined,
  MIMIR_DATABASE_URL_FILE: undefined,
  MIMIR_SANDBOX_AUTHORITY: undefined,
  MIMIR_SECRET_KEY_FILE: undefined,
  TSS_PRERENDERING: undefined,
  VITEST: undefined,
};

/** Run a child to its exit within the deadline; answer its exit code and output. */
async function run(argv: string[], env: Record<string, string | undefined>, deadline: number) {
  const child = Bun.spawn(argv, {
    cwd: hostRoot,
    env: { ...process.env, ...unset, ...env },
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), deadline);
  try {
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exit, output: `${stdout}\n${stderr}`.slice(-16_000) };
  } finally {
    clearTimeout(timer);
  }
}

/** An OS-assigned port, released for the host to take. */
async function freePort(): Promise<number> {
  const reservation = Bun.serve({
    fetch: () => new Response(null, { status: 503 }),
    hostname: '127.0.0.1',
    port: 0,
  });
  const { port } = reservation;
  await reservation.stop(true);
  if (port === undefined) {
    throw new Error('the reservation listened on no port');
  }
  return port;
}

/**
 * The launcher parses the secret key in its own bundle and hands it to the
 * server bundle through the shared host configuration. The server bundle's
 * push channel seals its VAPID pair under that key when it first delivers, so
 * a task blocked on the operator makes the seal happen there.
 */
test('a host started by its launcher seals with the secret key the launcher read', async () => {
  const built = await run(
    [process.execPath, viteEntry, 'build'],
    { MIMIR_DATA_DIR: undefined, MIMIR_HOSTS: undefined, MIMIR_URL: undefined },
    150_000,
  );
  expect(built.exit, built.output).toBe(0);

  const directory = await mkdtemp(join(tmpdir(), 'mimir-secret-key-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${String(port)}`;
  const secretKey = randomBytes(32).toString('base64');
  const host = Bun.spawn([process.execPath, launcher], {
    cwd: hostRoot,
    env: {
      ...process.env,
      ...unset,
      MIMIR_DATA_DIR: directory,
      MIMIR_HOSTS: '',
      MIMIR_PORT: String(port),
      MIMIR_PUSH_CONTACT: 'mailto:test@example.net',
      MIMIR_SECRET_KEY: secretKey,
      MIMIR_URL: base,
      NODE_ENV: 'production',
    },
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  let diagnostics = '';
  const capture = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      diagnostics = `${diagnostics}${decoder.decode(chunk, { stream: true })}`.slice(-16_000);
    }
  };
  const output = [capture(host.stdout), capture(host.stderr)];
  try {
    let ready = false;
    for (let attempt = 0; attempt < 150 && !ready; attempt++) {
      if (host.exitCode !== null) {
        throw new Error(`the host exited before readiness (${host.exitCode}): ${diagnostics}`);
      }
      try {
        ready = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok;
      } catch {
        // The listener is not open yet.
      }
      if (!ready) {
        await Bun.sleep(100);
      }
    }
    expect(ready, `the host did not become ready: ${diagnostics}`).toBe(true);

    // Pair a device, so its block is another actor's and the operator is told.
    const post = async (path: string, body: unknown) =>
      (
        await fetch(`${base}/auth/pairing/${path}`, {
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        })
      ).json();
    const request = z
      .object({ poll_secret: z.string(), user_code: z.string() })
      .parse(await post('requests', { device: 'secret key fixture' }));
    await runHostCli(['approve', request.user_code], { MIMIR_DATA_DIR: directory });
    const { token } = z
      .object({ token: z.string() })
      .parse(await post('poll', { poll_secret: request.poll_secret }));
    const remote = new RemoteEngine({
      headers: { authorization: `Bearer ${token}` },
      url: `${base}/trpc`,
      version: MIN_CLIENT,
    });
    await remote.create({ key: 'KEY', name: 'Secret key', type: 'project' });
    await remote.create({ parent: 'KEY', title: 'Seal', type: 'initiative' });
    await remote.create({ parent: 'KEY-1', title: 'Needs the operator', type: 'task' });
    await remote.block({ id: 'KEY-2', on: 'you', reason: 'Seal the push key' });

    // The notification window closes at most 10 seconds after it opens.
    let sealed: string | undefined;
    for (let attempt = 0; attempt < 300 && sealed === undefined; attempt++) {
      expect(diagnostics).not.toContain('needs_you_channel_fault');
      sealed = sealedPushKey(directory);
      if (sealed === undefined) {
        await Bun.sleep(100);
      }
    }
    expect(diagnostics).toContain('"event":"needs_you_event"');
    expect(diagnostics).not.toContain('needs_you_channel_fault');
    expect(sealed, `no push key was sealed: ${diagnostics}`).toBeDefined();

    // The row opens under the key the launcher was given, to a VAPID pair.
    const key = parseSecretKey(secretKey);
    expect(key).toBeDefined();
    const opened = key === undefined ? undefined : openSecret(key, 'push.vapid', sealed ?? '');
    expect(opened, diagnostics).toBeDefined();
    expect(await readVapidKeys(JSON.parse(opened ?? 'null'))).toBeDefined();
  } finally {
    const deadline = setTimeout(() => host.kill('SIGKILL'), 5000);
    try {
      host.kill('SIGTERM');
      await host.exited;
      await Promise.all(output);
    } finally {
      clearTimeout(deadline);
    }
    await rm(directory, { force: true, recursive: true });
  }
}, 210_000);

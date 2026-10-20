/// <reference types="bun" />

import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RemoteEngine } from '@mimir/wire/client';
import { z } from 'zod';

import { POSTGRES_IMAGE } from '../../sandbox/src/workflow';

const repository = fileURLToPath(new URL('../../..', import.meta.url));

/** Capture Docker diagnostics without streaming the image build into test output. */
async function docker(args: string[], timeout = 20_000): Promise<string> {
  const child = Bun.spawn(['docker', ...args], {
    cwd: repository,
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exit !== 0) {
      throw new Error(`docker ${args[0]} failed (${exit}): ${stderr.slice(-4000)}`);
    }
    return (args[0] === 'logs' ? `${stdout}\n${stderr}` : stdout).trim();
  } finally {
    clearTimeout(timer);
  }
}

/** GET a JSON route of the running host. */
async function getJson(base: string, path: string): Promise<unknown> {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) });
  expect(response.status, `GET ${path}`).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  return response.json();
}

async function ready(container: string, port = 64647): Promise<string> {
  const address = await docker(['port', container, `${port}/tcp`]);
  if (!/^127\.0\.0\.1:\d+$/.test(address)) {
    throw new Error(`expected one ephemeral loopback port, got ${JSON.stringify(address)}`);
  }
  const base = `http://${address}`;
  let health = 'no response';
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
      const contentType = response.headers.get('content-type') ?? 'no content type';
      health = `${response.status} ${contentType}`;
      if (response.ok && contentType.includes('application/json')) {
        return base;
      }
    } catch {
      // Docker publishes the port before the host has opened its SQLite store.
    }
    await Bun.sleep(100);
  }
  throw new Error(
    `container health did not become ready (${health}): ${await docker(['logs', container])}`,
  );
}

/** Require Docker's own probe result, since an HTTP listener alone is insufficient. */
async function healthy(container: string) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const status = await docker([
      'inspect',
      '--format',
      '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}',
      container,
    ]);
    if (status !== 'starting') {
      expect(status, `Docker health for ${container}`).toBe('healthy');
      return;
    }
    await Bun.sleep(250);
  }
  throw new Error(`Docker health stayed starting: ${await docker(['logs', container])}`);
}

test('the host image reports its stamped version rather than runtime overrides', async () => {
  const name = `mimir-host-version-${randomUUID()}`;
  const image = `${name}:test`;
  const version = '0.0.0-next.533';
  try {
    await docker(
      ['build', '--quiet', '--build-arg', `MIMIR_BUILD_VERSION=${version}`, '--tag', image, '.'],
      120_000,
    );
    await docker([
      'run',
      '--detach',
      '--name',
      name,
      '--publish',
      '127.0.0.1::64647',
      '--env',
      'MIMIR_BUILD_VERSION=runtime-override',
      image,
    ]);
    const base = await ready(name);
    expect(await getJson(base, '/health')).toMatchObject({ status: 'ok', version });
  } finally {
    await docker(['rm', '--force', name]).catch(() => undefined);
    await docker(['image', 'rm', '--force', image]).catch(() => undefined);
  }
}, 150_000);

test('the host image persists SQLite and migrates Postgres before serving', async () => {
  const name = `mimir-host-test-${randomUUID()}`;
  const image = `${name}:test`;
  const volume = `${name}-data`;
  const rootContainer = `${name}-root`;
  const postgres = `${name}-postgres`;
  const network = `${name}-network`;
  const postgresHost = `${name}-pg-host`;
  const secretDirectory = await mkdtemp(join(tmpdir(), 'mimir-host-secret-'));
  const password = randomUUID();
  const refusedContainers = [`${name}-unwritable`, `${name}-invalid`];
  try {
    await docker(['build', '--quiet', '--tag', image, '.'], 120_000);
    await docker(['volume', 'create', volume]);
    const run = async (container: string, user: string[] = []) => {
      await docker([
        'run',
        '--detach',
        '--read-only',
        '--name',
        container,
        '--publish',
        '127.0.0.1::64647',
        '--volume',
        `${volume}:/data`,
        '--env',
        'MIMIR_HOSTS=allowed.example',
        '--env',
        'MIMIR_URL=https://public.example',
        '--env',
        'TSS_PRERENDERING=true',
        ...user,
        image,
      ]);
      return ready(container);
    };
    let base = await run(name);
    expect(await docker(['logs', name])).toContain('applied migration 0005_project_pinned');
    expect(await docker(['logs', name])).toContain('applied migration 0009_device_tokens');
    for (const path of [
      '/',
      '/_shell.html',
      '/icons/mimir.svg',
      '/assets/missing.js',
      '/api/projects',
      '/trpc',
      '/trpc/getNode',
      '/trpc/done',
      '/_serverFn/missing',
      '/health',
    ]) {
      const refused = await fetch(`${base}${path}`, { headers: { host: 'unlisted.example' } });
      expect(refused.status, path).toBe(403);
      expect(await refused.json(), path).toMatchObject({ error: { code: 'forbidden_host' } });
      const crossOrigin = await fetch(`${base}${path}`, {
        headers: { origin: 'https://evil.example' },
        method: 'POST',
      });
      expect(crossOrigin.status, path).toBe(403);
      expect(await crossOrigin.json(), path).toMatchObject({ error: { code: 'forbidden_origin' } });
    }
    const version = z
      .object({ version: z.string() })
      .parse(await Bun.file(new URL('../../bin/package.json', import.meta.url)).json()).version;
    expect(await getJson(base, '/health')).toEqual({ schema: 9, status: 'ok', version });
    const healthHead = await fetch(`${base}/health`, { method: 'HEAD' });
    expect(healthHead.status).toBe(200);
    expect(await healthHead.text()).toBe('');
    expect(healthHead.headers.get('cache-control')).toBe('no-store');
    await healthy(name);
    const [, ...healthCommand] = z
      .tuple([z.literal('CMD'), z.literal('bun'), z.literal('-e'), z.string()])
      .parse(
        JSON.parse(
          await docker(['inspect', '--format', '{{json .Config.Healthcheck.Test}}', name]),
        ),
      );
    const invalidHealth = await docker([
      'exec',
      name,
      'bun',
      '-e',
      `
      const exits = [];
      for (const body of ['<!doctype html><title>SPA fallback</title>', '{"status":"failed"}']) {
        const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(body) });
        try {
          const child = Bun.spawn(${JSON.stringify(healthCommand)}, {
            env: { ...process.env, MIMIR_PORT: String(server.port) },
            stdout: 'ignore', stderr: 'ignore',
          });
          exits.push(await child.exited);
        } finally {
          await server.stop(true);
        }
      }
      console.log(JSON.stringify(exits));
    `,
    ]);
    expect(invalidHealth).toBe('[1,1]');
    for (const host of ['allowed.example', 'public.example']) {
      const response = await fetch(`${base}/health`, { headers: { host } });
      expect(response.status, host).toBe(200);
    }
    // The CLI sends no Origin and the console sends its own: both writes land.
    const engineWith = (headers: Record<string, string>) =>
      new RemoteEngine({
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers },
          }),
        url: `${base}/trpc`,
      });
    for (const [key, headers] of [
      ['CLI', {}],
      ['WEB', { origin: base, 'sec-fetch-site': 'same-origin' }],
    ] satisfies [string, Record<string, string>][]) {
      await engineWith(headers).create({ key, name: key, type: 'project' });
    }

    const remote = new RemoteEngine({ url: `${base}/trpc` });
    expect(
      await remote.create({ key: 'TST', name: 'Container integration project', type: 'project' }),
    ).toMatchObject({ id: 'TST', title: 'Container integration project' });
    const initiative = await remote.create({
      parent: 'TST',
      title: 'Container integration initiative',
      type: 'initiative',
    });
    const task = await remote.create({
      parent: initiative.id,
      title: 'Complete through the container Engine',
      type: 'task',
    });
    const review = await remote.console.review({ timeZone: 'UTC' });
    expect(review.projects).toContainEqual(expect.objectContaining({ key: 'TST' }));
    const read = await remote.getNode({ id: task.id });
    expect(read).toMatchObject({ lifecycle: 'todo', title: task.title });
    expect(read.createdAt).toBeInstanceOf(Date);
    const completed = await remote.done({ id: task.id });
    expect(completed.lifecycle).toBe('done');
    expect(completed.completedAt).toBeInstanceOf(Date);
    expect(await remote.getNode({ id: task.id })).toMatchObject({ lifecycle: 'done' });
    // Nitro plugins and Start's server bundle must share the same store handle.
    const descriptors = await docker([
      'exec',
      name,
      'sh',
      '-c',
      'for fd in /proc/1/fd/*; do readlink "$fd"; done',
    ]);
    expect(descriptors.split('\n').filter((file) => file === '/data/store.sqlite')).toHaveLength(1);

    for (const path of ['/', `/p/TST/${task.id.split('-')[1]}`]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toContain('text/html');
      expect(await response.text(), path).toMatch(/<!doctype html>/i);
    }
    for (const path of ['/assets/missing-abc123.js', '/assets/missing-abc123.css']) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(404);
      expect(response.headers.get('cache-control') ?? '', path).not.toContain('immutable');
    }
    const manifest = await fetch(`${base}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get('content-type')).toMatch(/application\/(?:manifest\+)?json/);
    expect(await manifest.json()).toMatchObject({ name: 'Mimir' });
    const worker = await fetch(`${base}/sw.js`);
    expect(worker.status).toBe(200);
    expect(worker.headers.get('content-type')).toMatch(/(?:application|text)\/javascript/);
    const source = await worker.text();
    expect(source).toContain('url:"_shell.html"');
    expect(source).toContain('createHandlerBoundToURL("/_shell.html")');
    const workbox = /define\(\["\.\/([^"']*workbox[^"']*)"\]/.exec(source)?.[1];
    if (workbox === undefined) {
      throw new Error('the served service worker does not name its Workbox runtime');
    }
    const runtime = await fetch(`${base}/${workbox}.js`);
    expect(runtime.status).toBe(200);
    expect(runtime.headers.get('content-type')).toMatch(/(?:application|text)\/javascript/);
    expect(await runtime.text()).toContain('precacheAndRoute');
    // The retired /api envelope answers every method with a 410 tombstone, never
    // the console's HTML shell and never the store.
    for (const method of ['GET', 'POST', 'DELETE']) {
      for (const path of ['/api', '/api/health', '/api/projects', '/api/missing']) {
        const gone = await fetch(`${base}${path}`, { method });
        expect(gone.status, `${method} ${path}`).toBe(410);
        expect(gone.headers.get('content-type'), `${method} ${path}`).toContain('application/json');
        expect(await gone.json(), `${method} ${path}`).toMatchObject({
          error: { code: 'gone', hint: expect.stringContaining('/trpc') },
        });
      }
    }
    const refused = await fetch(`${base}/trpc/create`, {
      body: JSON.stringify({ json: { key: 'EVL', name: 'Cross-origin write', type: 'project' } }),
      headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
      method: 'POST',
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: { code: 'forbidden_origin' } });
    // oxlint-disable-next-line typescript/await-thenable -- Bun awaits async matchers at runtime.
    await expect(remote.getNode({ id: 'EVL' })).rejects.toMatchObject({ code: 'not_found' });

    await docker(['stop', '--time', '5', name]);
    await docker(['start', name]);
    base = await ready(name);
    expect(await new RemoteEngine({ url: `${base}/trpc` }).getNode({ id: task.id })).toMatchObject({
      id: task.id,
      lifecycle: 'done',
    });

    await docker(['rm', '--force', name]);
    base = await run(rootContainer, ['--user', '0:0']);
    const rooted = new RemoteEngine({ url: `${base}/trpc` });
    expect(await rooted.getNode({ id: task.id })).toMatchObject({ id: task.id, lifecycle: 'done' });
    expect(
      await rooted.reopen({
        id: task.id,
        reason: 'Verify the rootless fleet user override can write',
      }),
    ).toMatchObject({ lifecycle: 'in_progress' });
    await docker(['rm', '--force', rootContainer]);

    // This lane owns its database and network; no external URL is accepted.
    await docker(['network', 'create', network]);
    await docker([
      'run',
      '--detach',
      '--name',
      postgres,
      '--network',
      network,
      '--label',
      `dev.mimir.host-test=${name}`,
      '--env',
      `POSTGRES_PASSWORD=${password}`,
      '--env',
      'POSTGRES_USER=mimir_sandbox',
      '--env',
      'POSTGRES_DB=mimir_sandbox',
      POSTGRES_IMAGE,
    ]);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        await docker([
          'exec',
          postgres,
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-U',
          'mimir_sandbox',
        ]).then(
          () => true,
          () => false,
        )
      ) {
        break;
      }
      if (attempt === 99) {
        throw new Error(
          `Postgres container did not become ready: ${await docker(['logs', postgres])}`,
        );
      }
      await Bun.sleep(100);
    }
    const secret = join(secretDirectory, 'database-url');
    await writeFile(
      secret,
      `postgres://mimir_sandbox:${password}@${postgres}:5432/mimir_sandbox\n`,
      { mode: 0o644 },
    );
    const runPostgresHost = async () => {
      await docker([
        'run',
        '--detach',
        '--read-only',
        '--name',
        postgresHost,
        '--network',
        network,
        '--publish',
        '127.0.0.1::12345',
        '--env',
        'MIMIR_PORT=12345',
        '--env',
        'MIMIR_URL=https://public.example',
        '--env',
        'MIMIR_DATABASE_URL_FILE=/run/secrets/database-url',
        '--mount',
        `type=bind,src=${secret},dst=/run/secrets/database-url,readonly`,
        image,
      ]);
    };
    await runPostgresHost();
    base = await ready(postgresHost, 12345);
    await healthy(postgresHost);
    const arbitraryHost = await fetch(`${base}/health`, { headers: { host: 'unlisted.example' } });
    expect(arbitraryHost.status).toBe(200);
    const crossOriginWithoutAllowlist = await fetch(`${base}/`, {
      headers: { origin: 'https://evil.example' },
      method: 'POST',
    });
    expect(crossOriginWithoutAllowlist.status).toBe(403);
    expect(await crossOriginWithoutAllowlist.json()).toMatchObject({
      error: { code: 'forbidden_origin' },
    });
    expect(await new RemoteEngine({ url: `${base}/trpc` }).projects({})).toEqual([]);
    expect(await docker(['logs', postgresHost])).toContain('applied migration 0005_project_pinned');
    expect(await docker(['logs', postgresHost])).toContain('applied migration 0006_project_remote');
    expect(await docker(['logs', postgresHost])).toContain('applied migration 0009_device_tokens');
    await docker(['rm', '--force', postgresHost]);
    const sql = async (statement: string) =>
      docker([
        'exec',
        postgres,
        'psql',
        '-U',
        'mimir_sandbox',
        '-d',
        'mimir_sandbox',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        statement,
      ]);
    await sql(
      'ALTER TABLE project DROP COLUMN remote; ALTER TABLE project DROP COLUMN pinned; ALTER TABLE node DROP COLUMN worker_harness; ALTER TABLE node DROP COLUMN worker_session; ALTER TABLE transition_log DROP CONSTRAINT transition_log_assignment_node_check; DROP TABLE device_tokens; DROP TABLE pairing_codes; DELETE FROM schema_version WHERE version >= 5;',
    );
    await runPostgresHost();
    base = await ready(postgresHost, 12345);
    expect(await new RemoteEngine({ url: `${base}/trpc` }).projects({})).toEqual([]);
    expect(await docker(['logs', postgresHost])).toContain('applied migration 0005_project_pinned');
    await docker(['rm', '--force', postgresHost]);
    await sql('INSERT INTO schema_version (version, applied_at) VALUES (10, now());');
    await runPostgresHost();
    expect(await docker(['wait', postgresHost], 10_000)).not.toBe('0');
    expect(await docker(['logs', postgresHost])).toContain('update the image');
    for (const [index, container] of refusedContainers.entries()) {
      await docker([
        'run',
        '--detach',
        '--read-only',
        '--name',
        container,
        '--user',
        index === 0 ? '12345:12345' : '0:0',
        '--volume',
        `${volume}:/data`,
        '--env',
        `MIMIR_DATA_DIR=${index === 0 ? '/data' : '/app/unwritable'}`,
        image,
      ]);
      expect(await docker(['wait', container], 10_000)).not.toBe('0');
      expect(await docker(['logs', container])).toContain('MIMIR_DATA_DIR');
    }
  } finally {
    await Promise.all(
      [name, rootContainer, postgresHost, postgres, ...refusedContainers].map(async (container) => {
        await docker(['rm', '--force', container]).catch(() => undefined);
      }),
    );
    await docker(['network', 'rm', network]).catch(() => undefined);
    await rm(secretDirectory, { force: true, recursive: true });
    await docker(['volume', 'rm', volume]).catch(() => undefined);
    await docker(['image', 'rm', '--force', image]).catch(() => undefined);
  }
}, 240_000);

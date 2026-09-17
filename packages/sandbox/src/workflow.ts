import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { z } from 'zod';

import { installBinary, readInstallationAt } from '../../bin/src/installation/index';
import { readSandboxAuthority } from '../../bin/src/sandbox-authority';
import type { SandboxAuthority } from '../../bin/src/sandbox-authority';
import { latestSnapshot, snapshotSchema } from './snapshot';

export const POSTGRES_IMAGE =
  'postgres:18.6-alpine@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2';
const label = 'dev.mimir.sandbox';
type Authority = SandboxAuthority;

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of Bun.file(path).stream()) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function privateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function isolatedEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('PG') || key.startsWith('MIMIR_')) {
      delete environment[key];
    }
  }
  environment.PATH = `${dirname(process.execPath)}:${environment.PATH ?? ''}`;
  return environment;
}

class InterruptedError extends Error {
  override name = 'InterruptedError';
}

async function command(
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; inputFile?: string; timeout?: number },
): Promise<string> {
  const child = Bun.spawn(args, {
    cwd: options.cwd,
    env: options.env ?? isolatedEnvironment(),
    stderr: 'pipe',
    stdin: options.inputFile ? Bun.file(options.inputFile) : 'ignore',
    stdout: 'pipe',
  });
  let interrupted = false;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, options.timeout ?? 120_000);
  const stop = () => {
    interrupted = true;
    child.kill('SIGKILL');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (interrupted) {
      throw new InterruptedError(
        'Sandbox operation interrupted; owned resources retained for cleanup.',
      );
    }
    if (timedOut) {
      throw new Error(`Sandbox subprocess timed out: ${args[0]}`);
    }
    if (exit !== 0) {
      throw new Error(
        `${args[0]} failed (${exit}): ${stderr.replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[database URL redacted]').slice(-4000)}`,
      );
    }
    return stdout.trim();
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

/** Owns disposable resources beneath one checkout. No caller supplies a database URL. */
export class Sandbox {
  readonly repository: string;
  constructor(repository: string) {
    this.repository = realpathSync(repository);
  }
  private directory(id: string): string {
    if (!z.uuid().safeParse(id).success) {
      throw new Error('Invalid sandbox ID');
    }
    return join(this.repository, '.dev', 'sandboxes', id);
  }
  private async load(id: string): Promise<Authority> {
    const root = this.directory(id);
    try {
      await readFile(join(root, 'authority.json'), 'utf8');
    } catch {
      throw new Error(`Sandbox ${id} does not exist or has no authority file`);
    }
    const authority = readSandboxAuthority(join(root, 'authority.json'));
    if (authority.image !== POSTGRES_IMAGE) {
      throw new Error('Sandbox image does not match pinned image');
    }
    if (
      authority.id !== id ||
      authority.root !== (await realpath(root)) ||
      authority.root !== root
    ) {
      throw new Error('Sandbox ownership mismatch');
    }
    for (const kind of ['config', 'data', 'cache'] as const) {
      if (authority.paths[kind] !== join(root, kind, 'mimir')) {
        throw new Error('Sandbox path mismatch');
      }
    }
    const run = z
      .object({ dockerId: z.string().min(1) })
      .parse(JSON.parse(await readFile(join(root, 'run.json'), 'utf8')));
    if (
      run.dockerId !==
      (await command(['docker', 'info', '--format', '{{.ID}}'], { cwd: this.repository }))
    ) {
      throw new Error('Docker daemon changed; sandbox resources and records were retained.');
    }
    const actual = await command(
      [
        'docker',
        'inspect',
        '--format',
        `{{index .Config.Labels "${label}"}}`,
        authority.containerId,
      ],
      { cwd: this.repository },
    );
    if (actual !== id) {
      throw new Error('Container ownership mismatch');
    }
    return authority;
  }
  private env(authority: Authority): NodeJS.ProcessEnv {
    return {
      ...isolatedEnvironment(),
      MIMIR_SANDBOX_AUTHORITY: join(authority.root, 'authority.json'),
      XDG_CACHE_HOME: dirname(authority.paths.cache),
      XDG_CONFIG_HOME: dirname(authority.paths.config),
      XDG_DATA_HOME: dirname(authority.paths.data),
    };
  }
  private async worker(authority: Authority, operation: 'seed' | 'verify'): Promise<string> {
    return command([process.execPath, 'run', 'packages/bin/scripts/sandbox-store.ts', operation], {
      cwd: this.repository,
      env: this.env(authority),
    });
  }
  private async record(
    id: string,
    operation: string,
    status: string,
    details: unknown = null,
  ): Promise<void> {
    const root = this.directory(id);
    const previous = z
      .object({
        createdAt: z.string(),
        id: z.literal(id),
        image: z.literal(POSTGRES_IMAGE),
        runtime: z.string(),
        version: z.literal(1),
      })
      .passthrough()
      .parse(JSON.parse(await readFile(join(root, 'run.json'), 'utf8')));
    if ((await realpath(root)) !== root) {
      throw new Error('Sandbox ownership mismatch');
    }
    const event = { at: new Date().toISOString(), details, operation, status };
    const name = `${Date.now()}-${randomUUID()}.json`;
    await mkdir(join(root, 'events'), { mode: 0o700, recursive: true });
    await privateJson(join(root, 'events', name), event);
    await privateJson(join(root, 'run.json'), {
      ...previous,
      latestEvent: name,
      operation,
      status,
    });
  }
  private async provision(): Promise<Authority> {
    const dockerId = await command(['docker', 'info', '--format', '{{.ID}}'], {
      cwd: this.repository,
    });
    if (!dockerId) {
      throw new Error('Docker daemon has no stable identity.');
    }
    const id = randomUUID();
    const root = this.directory(id);
    await mkdir(root, { mode: 0o700, recursive: true });
    const paths = {
      cache: join(root, 'cache', 'mimir'),
      config: join(root, 'config', 'mimir'),
      data: join(root, 'data', 'mimir'),
    };
    await Promise.all(
      Object.values(paths).map((path) => mkdir(path, { mode: 0o700, recursive: true })),
    );
    await privateJson(join(root, 'run.json'), {
      createdAt: new Date().toISOString(),
      dockerId,
      id,
      image: POSTGRES_IMAGE,
      runtime: Bun.version,
      status: 'provisioning',
      version: 1,
    });
    const password = randomBytes(32).toString('hex');
    process.stderr.write(`Provisioning sandbox ${id}. Cleanup: bun run sandbox destroy ${id}\n`);
    try {
      const containerId = await command(
        [
          'docker',
          'run',
          '--detach',
          '--name',
          `mimir-sandbox-${id}`,
          '--label',
          `${label}=${id}`,
          '--publish',
          '127.0.0.1::5432',
          '--env',
          'POSTGRES_USER=mimir_sandbox',
          '--env',
          'POSTGRES_DB=mimir_sandbox',
          '--env',
          'POSTGRES_PASSWORD',
          POSTGRES_IMAGE,
        ],
        { cwd: this.repository, env: { ...isolatedEnvironment(), POSTGRES_PASSWORD: password } },
      );
      // Record ownership before readiness so interrupted provisioning can be cleaned up.
      await privateJson(join(root, 'container.json'), { containerId, id });
      const binding = await command(['docker', 'port', containerId, '5432/tcp'], {
        cwd: this.repository,
      });
      const port = /^127\.0\.0\.1:(\d+)$/.exec(binding)?.[1];
      if (!port) {
        throw new Error(`Unexpected sandbox port mapping; cleanup with sandbox destroy ${id}`);
      }
      const authority: Authority = {
        containerId,
        id,
        image: POSTGRES_IMAGE,
        paths,
        postgresUrl: `postgres://mimir_sandbox:${password}@127.0.0.1:${port}/mimir_sandbox`,
        root: await realpath(root),
        version: 1,
      };
      await privateJson(join(root, 'authority.json'), authority);
      await writeFile(
        join(paths.config, 'config.toml'),
        `[store]\nbackend = "postgres"\nurl = ${JSON.stringify(authority.postgresUrl)}\n`,
        { mode: 0o600 },
      );
      try {
        let ready = false;
        for (let attempt = 0; attempt < 60; attempt++) {
          try {
            await command(
              [
                'docker',
                'exec',
                containerId,
                'pg_isready',
                '--host',
                '127.0.0.1',
                '-U',
                'mimir_sandbox',
                '-d',
                'mimir_sandbox',
              ],
              { cwd: this.repository, timeout: 3000 },
            );
            ready = true;
            break;
          } catch (error) {
            if (error instanceof InterruptedError) {
              throw error;
            }
            await Bun.sleep(250);
          }
        }
        if (!ready) {
          throw new Error('Postgres did not become ready');
        }
        await this.record(id, 'provision', 'ready');
        return authority;
      } catch (error) {
        await this.failure(authority, error);
        throw error;
      }
    } catch (error) {
      await this.record(id, 'provision', 'failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      await privateJson(join(root, 'failure.json'), {
        cleanup: `bun run sandbox destroy ${id}`,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
  private async failure(authority: Pick<Authority, 'id' | 'root'>, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.record(authority.id, 'failure', 'failed', { message });
    await rm(join(authority.root, 'verification.json'), { force: true });
    await privateJson(join(authority.root, 'failure.json'), {
      cleanup: `bun run sandbox destroy ${authority.id}`,
      message,
    });
    process.stderr.write(
      `Sandbox ${authority.id} retained. Cleanup: bun run sandbox destroy ${authority.id}\n`,
    );
  }
  private async binary(authority: Authority, allowMissing = false): Promise<string> {
    const binary = join(authority.root, 'bin', 'mimir');
    await mkdir(dirname(binary), { mode: 0o700, recursive: true });
    if ((await realpath(dirname(binary))) !== dirname(binary)) {
      throw new Error('Sandbox binary directory must not be a symlink.');
    }
    const stat = await lstat(binary).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    });
    if (!stat) {
      if (allowMissing) {
        return binary;
      }
      throw new Error('Sandbox has no installed candidate. Run sandbox upgrade first.');
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Sandbox executable must be a regular file, not a symlink.');
    }
    const receipt = readInstallationAt(binary);
    if (
      receipt?.mode !== 'sandbox' ||
      receipt.executable !== binary ||
      receipt.sandboxAuthority !== join(authority.root, 'authority.json') ||
      (['config', 'data', 'cache'] as const).some(
        (kind) => receipt.paths[kind] !== authority.paths[kind],
      )
    ) {
      throw new Error('Candidate is not registered to this sandbox.');
    }
    return binary;
  }
  private async install(authority: Authority, binary?: string): Promise<string> {
    if (!binary) {
      await command([process.execPath, 'run', 'build'], { cwd: this.repository, timeout: 600_000 });
    }
    const source = resolve(this.repository, binary ?? 'dist/mimir');
    const target = await this.binary(authority, true);
    installBinary({
      registration: {
        mode: 'sandbox',
        paths: authority.paths,
        sandboxAuthority: join(authority.root, 'authority.json'),
      },
      source,
      target,
    });
    const sha256 = await hashFile(target);
    await privateJson(join(authority.root, 'binary.json'), { sha256, source });
    await this.record(authority.id, 'install', 'ready', { sha256, source });
    return target;
  }
  async create(binary?: string): Promise<string> {
    const authority = await this.provision();
    try {
      const target = await this.install(authority, binary);
      await command([target, 'store', 'upgrade'], {
        cwd: authority.root,
        env: this.env(authority),
      });
      const fixture = await this.worker(authority, 'seed');
      const fixtureInput = {
        fixtureVersion: 1,
        result: fixture,
        runtime: Bun.version,
        sourceSha256: await hashFile(
          join(this.repository, 'packages/bin/src/testing/conformance.ts'),
        ),
        workerSha256: await hashFile(
          join(this.repository, 'packages/bin/scripts/sandbox-store.ts'),
        ),
      };
      await privateJson(join(authority.root, 'fixture.json'), fixtureInput);
      await this.record(authority.id, 'seed', 'ready', fixtureInput);
      await this.verify(authority.id);
      return authority.id;
    } catch (error) {
      await this.failure(authority, error);
      throw error;
    }
  }
  async verify(id: string): Promise<void> {
    const owner = { id, root: this.directory(id) };
    await this.record(id, 'verify', 'verifying');
    await rm(join(owner.root, 'verification.json'), { force: true });
    try {
      const authority = await this.load(id);
      const binary = await this.binary(authority);
      const doctor = JSON.parse(
        await command([binary, 'doctor', '-s', 'all', '--format', 'json'], {
          cwd: authority.root,
          env: this.env(authority),
        }),
      );
      if (!Array.isArray(doctor) || doctor.length !== 0) {
        throw new Error('Installed candidate doctor reported findings');
      }
      const exported = join(authority.root, `verify-${randomUUID()}.json`);
      await command([binary, 'store', 'export', exported], {
        cwd: authority.root,
        env: this.env(authority),
      });
      await rm(exported);
      const result = await this.worker(authority, 'verify');
      await privateJson(join(authority.root, 'verification.json'), {
        doctor,
        exported: true,
        result,
        verifiedAt: new Date().toISOString(),
      });
      await this.record(id, 'verify', 'verified', { doctor, exported: true, result });
    } catch (error) {
      await this.failure(owner, error);
      throw error;
    }
  }
  async run(id: string, args: readonly string[]): Promise<string> {
    const owner = { id, root: this.directory(id) };
    if (args.length === 0) {
      throw new Error('Supply Mimir arguments after --.');
    }
    const verb = args[0];
    if (verb === 'serve') {
      throw new Error(
        `Sandbox run is for finite CLI commands. Start the registered sandbox candidate ${join(owner.root, 'bin', 'mimir')} directly for an interactive server.`,
      );
    }
    if (
      !verb ||
      verb.startsWith('-') ||
      new Set([
        'installation-install',
        'installation-protocol',
        'self-update',
        'setup',
        'service',
        'skill',
        'vault',
      ]).has(verb)
    ) {
      throw new Error(
        'Sandbox run accepts finite work and store commands; installation and service machinery is disabled. Put the command before options.',
      );
    }
    await this.record(id, 'run', 'running', { args });
    try {
      const authority = await this.load(id);
      const binary = await this.binary(authority);
      const result = await command([binary, ...args], {
        cwd: authority.root,
        env: this.env(authority),
        timeout: 600_000,
      });
      await this.record(id, 'run', 'ready', { args, succeeded: true });
      return result;
    } catch (error) {
      await this.failure(owner, error);
      throw error;
    }
  }
  async upgrade(id: string, binary: string): Promise<void> {
    const owner = { id, root: this.directory(id) };
    await this.record(id, 'upgrade', 'upgrading');
    await rm(join(owner.root, 'verification.json'), { force: true });
    try {
      const authority = await this.load(id);
      const previous = (await Bun.file(join(authority.root, 'binary.json')).exists())
        ? JSON.parse(await readFile(join(authority.root, 'binary.json'), 'utf8'))
        : null;
      const target = await this.install(authority, binary);
      const result = await command([target, 'store', 'upgrade'], {
        cwd: authority.root,
        env: this.env(authority),
      });
      await this.verify(id);
      await privateJson(join(authority.root, 'upgrade.json'), {
        candidate: JSON.parse(await readFile(join(authority.root, 'binary.json'), 'utf8')),
        completedAt: new Date().toISOString(),
        previous,
        result,
      });
      await this.record(
        id,
        'upgrade',
        'verified',
        JSON.parse(await readFile(join(authority.root, 'upgrade.json'), 'utf8')),
      );
    } catch (error) {
      await this.failure(owner, error);
      throw error;
    }
  }
  async restore(selection: string): Promise<string> {
    const config = z
      .object({ snapshots: z.object({ directory: z.string().min(1) }) })
      .parse(JSON.parse(await readFile(join(this.repository, '.dev', 'sandbox.json'), 'utf8')));
    const directory = resolve(this.repository, config.snapshots.directory);
    if (selection === 'latest') {
      const snapshots = await Promise.all(
        (await readdir(directory, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry.name))
          .map(async (entry) =>
            snapshotSchema.parse(
              JSON.parse(await readFile(join(directory, entry.name, 'snapshot.json'), 'utf8')),
            ),
          ),
      );
      const selected = latestSnapshot(snapshots);
      selection = selected.id;
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(selection)) {
      throw new Error('Invalid snapshot ID');
    }
    const snapshot = snapshotSchema.parse(
      JSON.parse(await readFile(join(directory, selection, 'snapshot.json'), 'utf8')),
    );
    if (snapshot.id !== selection) {
      throw new Error('Snapshot ID mismatch');
    }
    if (
      !/^18(?:\.|$)/.test(snapshot.postgresVersion) ||
      !/^18(?:\.|$)/.test(snapshot.pgDumpVersion)
    ) {
      throw new Error('Snapshot requires PostgreSQL and pg_dump major version 18');
    }
    const archive = join(directory, selection, 'database.dump');
    if ((await hashFile(archive)) !== snapshot.sha256) {
      throw new Error('Snapshot checksum mismatch');
    }
    const header = await open(archive, 'r');
    try {
      const bytes = Buffer.alloc(5);
      await header.read(bytes, 0, 5, 0);
      if (bytes.toString() !== 'PGDMP') {
        throw new Error('Snapshot is not a PostgreSQL custom archive');
      }
    } finally {
      await header.close();
    }
    const authority = await this.provision();
    try {
      await privateJson(join(authority.root, 'snapshot.json'), snapshot);
      const staged = join(authority.root, 'restore.dump');
      await copyFile(archive, staged);
      await chmod(staged, 0o600);
      if ((await hashFile(staged)) !== snapshot.sha256) {
        throw new Error('Snapshot changed while staging');
      }
      await command(
        [
          'docker',
          'exec',
          '-i',
          authority.containerId,
          'pg_restore',
          '--exit-on-error',
          '--single-transaction',
          '--no-owner',
          '--no-privileges',
          '--username',
          'mimir_sandbox',
          '--dbname',
          'mimir_sandbox',
        ],
        { cwd: this.repository, inputFile: staged, timeout: 600_000 },
      );
      await rm(staged);
      const schema = await command(
        [
          'docker',
          'exec',
          authority.containerId,
          'psql',
          '-X',
          '--set',
          'ON_ERROR_STOP=1',
          '--username',
          'mimir_sandbox',
          '--dbname',
          'mimir_sandbox',
          '--tuples-only',
          '--no-align',
          '--command',
          'SELECT max(version) FROM public.schema_version',
        ],
        { cwd: this.repository },
      );
      if (!/^[1-9][0-9]*$/.test(schema)) {
        throw new Error('Snapshot does not contain a versioned Mimir schema.');
      }
      await this.record(authority.id, 'restore', 'restored', {
        schemaVersion: Number(schema),
        snapshot,
      });
      await privateJson(join(authority.root, 'restored-schema.json'), { version: Number(schema) });
      return authority.id;
    } catch (error) {
      await this.failure(authority, error);
      throw error;
    }
  }
  async rehearse(snapshot: string, binary: string): Promise<string> {
    const id = await this.restore(snapshot);
    await this.upgrade(id, binary);
    const authority = await this.load(id);
    const report = join(this.repository, '.dev', 'sandbox-results', `${id}.json`);
    await mkdir(dirname(report), { mode: 0o700, recursive: true });
    await privateJson(report, {
      binary: JSON.parse(await readFile(join(authority.root, 'binary.json'), 'utf8')),
      events: await Promise.all(
        (await readdir(join(authority.root, 'events')))
          .toSorted()
          .map(async (name) =>
            JSON.parse(await readFile(join(authority.root, 'events', name), 'utf8')),
          ),
      ),
      id,
      image: POSTGRES_IMAGE,
      runtime: Bun.version,
      schema: JSON.parse(await readFile(join(authority.root, 'restored-schema.json'), 'utf8')),
      snapshot: JSON.parse(await readFile(join(authority.root, 'snapshot.json'), 'utf8')),
      upgrade: JSON.parse(await readFile(join(authority.root, 'upgrade.json'), 'utf8')),
      verification: JSON.parse(await readFile(join(authority.root, 'verification.json'), 'utf8')),
    });
    await this.destroy(id);
    return report;
  }
  async test(): Promise<void> {
    const authority = await this.provision();
    try {
      await command(
        [
          process.execPath,
          'test',
          'packages/bin/src/core/store-postgres/postgres.integration.test.ts',
          'packages/bin/src/store-backend.test.ts',
        ],
        { cwd: this.repository, env: this.env(authority), timeout: 600_000 },
      );
      await this.record(authority.id, 'test', 'passed');
      const report = join(this.repository, '.dev', 'sandbox-results', `${authority.id}.json`);
      await mkdir(dirname(report), { mode: 0o700, recursive: true });
      await privateJson(report, {
        events: await Promise.all(
          (await readdir(join(authority.root, 'events')))
            .toSorted()
            .map(async (name) =>
              JSON.parse(await readFile(join(authority.root, 'events', name), 'utf8')),
            ),
        ),
        run: JSON.parse(await readFile(join(authority.root, 'run.json'), 'utf8')),
      });
      await this.destroy(authority.id);
    } catch (error) {
      await this.failure(authority, error);
      throw error;
    }
  }
  async destroy(id: string): Promise<void> {
    const root = this.directory(id);
    if (!(await Bun.file(join(root, 'run.json')).exists())) {
      throw new Error(`Sandbox ${id} does not exist`);
    }
    const run = z
      .object({
        dockerId: z.string().min(1),
        id: z.literal(id),
        image: z.literal(POSTGRES_IMAGE),
        version: z.literal(1),
      })
      .passthrough()
      .parse(JSON.parse(await readFile(join(root, 'run.json'), 'utf8')));
    if (run.id !== id || (await realpath(root)) !== root) {
      throw new Error('Sandbox directory ownership mismatch');
    }
    const daemon = await command(['docker', 'info', '--format', '{{.ID}}'], {
      cwd: this.repository,
    });
    if (daemon !== run.dockerId) {
      throw new Error('Docker daemon changed; sandbox resources and records were retained.');
    }
    const containerRecord = join(root, 'container.json');
    const record = (await Bun.file(containerRecord).exists())
      ? z
          .object({ containerId: z.string().regex(/^[a-f0-9]{64}$/), id: z.literal(id) })
          .parse(JSON.parse(await readFile(containerRecord, 'utf8')))
      : undefined;
    const target = record?.containerId ?? `mimir-sandbox-${id}`;
    const present = await command(
      [
        'docker',
        'container',
        'ls',
        '--all',
        '--no-trunc',
        '--filter',
        record ? `id=${record.containerId}` : `name=^/${target}$`,
        '--format',
        '{{.ID}}',
      ],
      { cwd: this.repository },
    );
    if (present) {
      if (record && present !== record.containerId) {
        throw new Error('Container identity mismatch');
      }
      const actual = await command(
        ['docker', 'inspect', '--format', `{{index .Config.Labels "${label}"}}`, target],
        { cwd: this.repository },
      );
      if (actual !== id) {
        throw new Error('Container ownership mismatch');
      }
      await command(['docker', 'rm', '--force', '--volumes', target], { cwd: this.repository });
    }
    await rm(root, { recursive: true });
  }
}

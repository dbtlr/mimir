import { randomBytes, randomUUID } from 'node:crypto';
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
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { z } from 'zod';

import { installBinary, readInstallationAt } from '../../core/src/installation/index';
import { readDatabaseAuthority } from '../../core/src/sandbox-authority';
import type { DatabaseSandboxAuthority } from '../../core/src/sandbox-authority';
import { SandboxError, SandboxUsageError } from './failures';
import { hostPort, launchHost } from './host';
import { InterruptedError, command, hashFile, isolatedEnvironment, privateJson } from './process';
import { latestSnapshot, snapshotSchema } from './snapshot';

export const POSTGRES_IMAGE =
  'postgres:18.6-alpine@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2';
const label = 'dev.mimir.sandbox';
type Authority = DatabaseSandboxAuthority;

const daemonChanged = (id: string): string =>
  `Docker daemon changed since sandbox ${id} was created; switch back to that daemon. Sandbox resources and records were retained.`;
const containerNotOwned = (id: string): string =>
  `Container for sandbox ${id} is not labelled as its own; refusing to touch it.`;

/** `operation`'s result, or a `SandboxError` carrying `message` when its path is absent. */
async function required<T>(operation: Promise<T>, message: string): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new SandboxError(message, { cause: error });
    }
    throw error;
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
      throw new SandboxUsageError(
        `Invalid sandbox ID "${id}"; use the UUID that create or restore printed.`,
      );
    }
    return join(this.repository, '.dev', 'sandboxes', id);
  }
  /** The directory of a sandbox that has a run record. */
  private async existing(id: string): Promise<string> {
    const root = this.directory(id);
    if (!(await Bun.file(join(root, 'run.json')).exists())) {
      throw new SandboxError(`Sandbox ${id} does not exist.`);
    }
    return root;
  }
  private async load(id: string): Promise<Authority> {
    const root = this.directory(id);
    try {
      await readFile(join(root, 'authority.json'), 'utf8');
    } catch {
      throw new SandboxError(`Sandbox ${id} does not exist or has no authority file.`);
    }
    const authority = readDatabaseAuthority(join(root, 'authority.json'));
    if (authority.image !== POSTGRES_IMAGE) {
      throw new SandboxError(
        `Sandbox ${id} uses another Postgres image than the pinned one; create a new sandbox.`,
      );
    }
    if (
      authority.id !== id ||
      authority.root !== (await realpath(root)) ||
      authority.root !== root
    ) {
      throw new SandboxError(
        `Sandbox ${id} authority does not match its directory; refusing to use it.`,
      );
    }
    for (const kind of ['config', 'data', 'cache'] as const) {
      if (authority.paths[kind] !== join(root, kind, 'mimir')) {
        throw new SandboxError(
          `Sandbox ${id} ${kind} path is outside its directory; refusing to use it.`,
        );
      }
    }
    const run = z
      .object({ dockerId: z.string().min(1) })
      .parse(JSON.parse(await readFile(join(root, 'run.json'), 'utf8')));
    if (
      run.dockerId !==
      (await command(['docker', 'info', '--format', '{{.ID}}'], { cwd: this.repository }))
    ) {
      throw new SandboxError(daemonChanged(id));
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
      throw new SandboxError(containerNotOwned(id));
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
  async host(id: string, port?: string): Promise<void> {
    hostPort(port);
    const authority = await this.load(id);
    await launchHost(this.repository, authority, { port });
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
    const root = await this.existing(id);
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
      throw new SandboxError(
        `Sandbox ${id} directory resolves through a symlink; refusing to record to it.`,
      );
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
      throw new SandboxError('Docker reported no daemon ID; check that Docker is running.');
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
        throw new SandboxError(
          `Unexpected sandbox port mapping; clean up with bun run sandbox destroy ${id}`,
        );
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
          throw new SandboxError('Postgres did not become ready.');
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
      throw new SandboxError('Sandbox binary directory must not be a symlink.');
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
      throw new SandboxError('Sandbox has no installed candidate. Run sandbox upgrade first.');
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new SandboxError('Sandbox executable must be a regular file, not a symlink.');
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
      throw new SandboxError(
        'Candidate is not registered to this sandbox. Run sandbox upgrade to reinstall it.',
      );
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
          join(this.repository, 'packages/core/src/testing/conformance.ts'),
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
        throw new SandboxError(
          `Installed candidate doctor reported findings; see them with bun run sandbox run ${id} -- doctor`,
        );
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
      throw new SandboxUsageError('Supply Mimir arguments after --.');
    }
    const verb = args[0];
    if (
      !verb ||
      verb.startsWith('-') ||
      new Set(['installation-install', 'installation-protocol', 'self-update', 'skill']).has(verb)
    ) {
      throw new SandboxUsageError(
        'Sandbox run accepts finite work and store commands; installation machinery is disabled. Put the command before options.',
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
      .parse(
        JSON.parse(
          await required(
            readFile(join(this.repository, '.dev', 'sandbox.json'), 'utf8'),
            'No snapshot directory is configured; create .dev/sandbox.json as docs/guides/development-sandboxes.md describes.',
          ),
        ),
      );
    const directory = resolve(this.repository, config.snapshots.directory);
    if (selection === 'latest') {
      const snapshots = await Promise.all(
        (
          await required(
            readdir(directory, { withFileTypes: true }),
            `Snapshot directory ${directory} doesn't exist.`,
          )
        )
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
      throw new SandboxUsageError(`Invalid snapshot ID "${selection}".`);
    }
    const snapshot = snapshotSchema.parse(
      JSON.parse(
        await required(
          readFile(join(directory, selection, 'snapshot.json'), 'utf8'),
          `Snapshot ${selection} doesn't exist in ${directory}.`,
        ),
      ),
    );
    if (snapshot.id !== selection) {
      throw new SandboxError(
        `Snapshot ${selection} manifest names another snapshot, ${snapshot.id}.`,
      );
    }
    if (
      !/^18(?:\.|$)/.test(snapshot.postgresVersion) ||
      !/^18(?:\.|$)/.test(snapshot.pgDumpVersion)
    ) {
      throw new SandboxError('Snapshot requires PostgreSQL and pg_dump major version 18.');
    }
    const archive = join(directory, selection, 'database.dump');
    if ((await hashFile(archive)) !== snapshot.sha256) {
      throw new SandboxError(`Snapshot ${selection} archive does not match its checksum.`);
    }
    const header = await open(archive, 'r');
    try {
      const bytes = Buffer.alloc(5);
      await header.read(bytes, 0, 5, 0);
      if (bytes.toString() !== 'PGDMP') {
        throw new SandboxError(`Snapshot ${selection} is not a PostgreSQL custom archive.`);
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
        throw new SandboxError(`Snapshot ${selection} changed while staging.`);
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
        throw new SandboxError('Snapshot does not contain a versioned Mimir schema.');
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
          'packages/core/src/store-postgres/postgres.integration.test.ts',
          'packages/core/src/store-backend.test.ts',
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
    const root = await this.existing(id);
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
      throw new SandboxError(
        `Sandbox ${id} records do not match its directory; refusing to remove it.`,
      );
    }
    const daemon = await command(['docker', 'info', '--format', '{{.ID}}'], {
      cwd: this.repository,
    });
    if (daemon !== run.dockerId) {
      throw new SandboxError(daemonChanged(id));
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
        throw new SandboxError(
          `Sandbox ${id} container does not match its record; refusing to remove it.`,
        );
      }
      const actual = await command(
        ['docker', 'inspect', '--format', `{{index .Config.Labels "${label}"}}`, target],
        { cwd: this.repository },
      );
      if (actual !== id) {
        throw new SandboxError(containerNotOwned(id));
      }
      await command(['docker', 'rm', '--force', '--volumes', target], { cwd: this.repository });
    }
    await rm(root, { recursive: true });
  }
}

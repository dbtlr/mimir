import { randomBytes, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { readDatabaseAuthority } from '../../core/src/sandbox-authority';
import type { DatabaseSandboxAuthority } from '../../core/src/sandbox-authority';
import { SandboxError, SandboxUsageError } from './failures';
import { hostPort, launchHost } from './host';
import { InterruptedError, command, isolatedEnvironment, privateJson } from './process';

export const POSTGRES_IMAGE =
  'postgres:18.6-alpine@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2';
const label = 'dev.mimir.sandbox';
type Authority = DatabaseSandboxAuthority;

const daemonChanged = (id: string): string =>
  `Docker daemon changed since sandbox ${id} was created; switch back to that daemon. Sandbox resources and records were retained.`;
const containerNotOwned = (id: string): string =>
  `Container for sandbox ${id} is not labelled as its own; refusing to touch it.`;

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
  /** Provision an owned Postgres sandbox; the development host migrates it on start. */
  async create(): Promise<string> {
    return (await this.provision()).id;
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

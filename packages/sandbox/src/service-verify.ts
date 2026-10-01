/**
 * `service-verify` (MMR-54): prove the real supervisor lifecycle without
 * touching the live daemon.
 *
 *   - **host** — a vault sandbox installation (owned directories, no database)
 *     drives the host supervisor under its own sandbox-scoped unit names: launchd
 *     on macOS, systemd user units on Linux. The supervisor fence lets it address
 *     nothing else.
 *   - **container** — a disposable Linux container with systemd as PID 1 and a
 *     lingering non-root user. The candidate installs there through the release
 *     `install.sh` (only the download is substituted), with its own empty
 *     configuration, so it is a live installation of that container alone.
 *
 * Both run the same {@link verifyServiceLifecycle} and fingerprint the host's
 * live units before and after. Resources are owned by id: a sandbox directory
 * under `.dev/service-sandboxes`, unit names derived from that id, and a
 * container labelled with it. Teardown always runs; a failed run retains its
 * directory for diagnosis and names the cleanup command.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { z } from 'zod';

import { installBinary } from '../../bin/src/installation/index';
import { readSandboxAuthority } from '../../bin/src/sandbox-authority';
import { SERVE_LABEL, SNAPSHOT_LABEL, unitLabels } from '../../bin/src/service/units';
import { command, hashFile, isolatedEnvironment, privateJson } from './process';
import { verifyServiceLifecycle } from './service-lifecycle';
import type { ServiceHost } from './service-lifecycle';

export const SERVICE_VERIFY_TARGETS = ['host', 'container'] as const;
export type ServiceVerifyTarget = (typeof SERVICE_VERIFY_TARGETS)[number];

const CONTAINER_LABEL = 'dev.mimir.service-verify';
const CONTAINER_USER = 'mimir';
const CONTAINER_HOME = `/home/${CONTAINER_USER}`;
const CONTAINER_STAGE = '/tmp/service-verify';
/** The container is its own host, so any port is free there. */
const CONTAINER_PORT = 54647;
const FIXTURE_TAG = 'v0.0.0-service-verify';
/** One minute per transition: covers systemd's 10s RestartSec and launchd's throttle. */
const ATTEMPTS = 60;
const pause = () => Bun.sleep(1000);

const runSchema = z.object({
  containerId: z.string().optional(),
  createdAt: z.string(),
  id: z.uuid(),
  target: z.enum(SERVICE_VERIFY_TARGETS),
  version: z.literal(1),
});
type RunRecord = z.infer<typeof runSchema>;

/** A command whose failure is expected during best-effort teardown. */
async function attempt(args: string[], cwd: string): Promise<string | undefined> {
  try {
    return await command(args, { cwd, timeout: 60_000 });
  } catch {
    return undefined;
  }
}

async function freePort(): Promise<number> {
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

async function hostHealth(port: number): Promise<string | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) {
      return undefined;
    }
    const body: unknown = await response.json();
    return z.object({ version: z.string() }).safeParse(body).data?.version;
  } catch {
    return undefined;
  }
}

/** The supervisor's view of the live units, by name, for a before/after comparison. */
async function liveUnitState(cwd: string): Promise<string> {
  if (process.platform === 'darwin') {
    const uid = String(process.getuid?.() ?? 501);
    const states = await Promise.all(
      [SERVE_LABEL, SNAPSHOT_LABEL].map(async (label) => {
        const printed = await attempt(['launchctl', 'print', `gui/${uid}/${label}`], cwd);
        if (printed === undefined) {
          return `${label}: not loaded`;
        }
        const pid = /\bpid = (\d+)/.exec(printed)?.[1] ?? 'none';
        const state = /\bstate = (\S+)/.exec(printed)?.[1] ?? 'unknown';
        return `${label}: ${state} pid ${pid}`;
      }),
    );
    return states.join('; ');
  }
  if (process.platform === 'linux') {
    const states = await Promise.all(
      [`${SERVE_LABEL}.service`, `${SNAPSHOT_LABEL}.timer`].map(async (unit) => {
        const shown = await attempt(
          ['systemctl', '--user', 'show', unit, '--property=ActiveState,MainPID'],
          cwd,
        );
        return `${unit}: ${shown?.replace(/\n/g, ' ') ?? 'manager unavailable'}`;
      }),
    );
    return states.join('; ');
  }
  return `no supervisor on ${process.platform}`;
}

export class ServiceVerifier {
  readonly repository: string;
  constructor(repository: string) {
    this.repository = realpathSync(repository);
  }

  private directory(id: string): string {
    if (!z.uuid().safeParse(id).success) {
      throw new Error('Invalid service sandbox ID');
    }
    return join(this.repository, '.dev', 'service-sandboxes', id);
  }

  /** Run the whole lifecycle on `target` and return the path of its report. */
  async verify(target: ServiceVerifyTarget, binary?: string): Promise<string> {
    const id = randomUUID();
    const root = this.directory(id);
    await mkdir(root, { mode: 0o700, recursive: true });
    const run: RunRecord = { createdAt: new Date().toISOString(), id, target, version: 1 };
    await privateJson(join(root, 'run.json'), run);
    process.stderr.write(
      `Service sandbox ${id} (${target}). Cleanup: bun run sandbox service-destroy ${id}\n`,
    );
    const report = join(this.repository, '.dev', 'sandbox-results', `service-${id}.json`);
    await mkdir(join(this.repository, '.dev', 'sandbox-results'), {
      mode: 0o700,
      recursive: true,
    });
    try {
      const result =
        target === 'host'
          ? await this.verifyHost(id, root, binary)
          : await this.verifyContainer(id, root, binary);
      await privateJson(report, { ...run, ...result, outcome: 'passed' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.teardown(id).catch(() => undefined);
      await privateJson(report, { ...run, message, outcome: 'failed' });
      process.stderr.write(
        `Service sandbox ${id} failed and was retained. Logs: ${root}. Cleanup: bun run sandbox service-destroy ${id}\n`,
      );
      throw error;
    }
    await this.destroy(id);
    return report;
  }

  /** Tear down a service sandbox's units or container, then remove its directory. */
  async destroy(id: string): Promise<void> {
    const root = this.directory(id);
    if (!existsSync(join(root, 'run.json'))) {
      throw new Error(`Service sandbox ${id} does not exist`);
    }
    await this.teardown(id);
    await rm(root, { force: true, recursive: true });
  }

  private async record(id: string): Promise<RunRecord> {
    const root = this.directory(id);
    if ((await realpath(root)) !== root) {
      throw new Error('Service sandbox ownership mismatch');
    }
    const run = runSchema.parse(JSON.parse(await readFile(join(root, 'run.json'), 'utf8')));
    if (run.id !== id) {
      throw new Error('Service sandbox ownership mismatch');
    }
    return run;
  }

  /** Remove only what this id owns: its sandbox-scoped units, or its labelled container. */
  private async teardown(id: string): Promise<void> {
    const run = await this.record(id);
    if (run.target === 'container') {
      if (run.containerId !== undefined) {
        const owner = await attempt(
          [
            'docker',
            'inspect',
            '--format',
            `{{index .Config.Labels "${CONTAINER_LABEL}"}}`,
            run.containerId,
          ],
          this.repository,
        );
        if (owner === id) {
          await command(['docker', 'rm', '--force', '--volumes', run.containerId], {
            cwd: this.repository,
          });
        }
      }
      return;
    }
    const root = this.directory(id);
    const binary = join(root, 'bin', 'mimir');
    if (existsSync(binary)) {
      await attempt([binary, 'service', 'uninstall', 'all'], root);
    }
    // Backstop for a half-installed unit: address only the sandbox-scoped names.
    for (const label of Object.values(unitLabels({ id, kind: 'sandbox' }))) {
      if (process.platform === 'darwin') {
        await attempt(
          ['launchctl', 'bootout', `gui/${String(process.getuid?.() ?? 501)}/${label}`],
          root,
        );
      } else if (process.platform === 'linux') {
        for (const unit of [`${label}.service`, `${label}.timer`]) {
          await attempt(['systemctl', '--user', 'disable', '--now', unit], root);
        }
      }
    }
  }

  private async build(): Promise<string> {
    await command([process.execPath, 'run', 'build'], { cwd: this.repository, timeout: 600_000 });
    return join(this.repository, 'dist', 'mimir');
  }

  private async verifyHost(
    id: string,
    root: string,
    binary: string | undefined,
  ): Promise<Record<string, unknown>> {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new Error(
        `service-verify --target host needs launchd or systemd, not ${process.platform}`,
      );
    }
    const paths = {
      cache: join(root, 'cache', 'mimir'),
      config: join(root, 'config', 'mimir'),
      data: join(root, 'data', 'mimir'),
    };
    for (const path of Object.values(paths)) {
      await mkdir(path, { mode: 0o700, recursive: true });
    }
    const authorityFile = join(root, 'authority.json');
    await privateJson(authorityFile, { id, kind: 'vault', paths, root, version: 1 });
    readSandboxAuthority(authorityFile);

    const source = binary === undefined ? await this.build() : resolve(this.repository, binary);
    const target = join(root, 'bin', 'mimir');
    await mkdir(join(root, 'bin'), { mode: 0o700 });
    installBinary({
      registration: { mode: 'sandbox', paths, sandboxAuthority: authorityFile },
      source,
      target,
    });
    const env = isolatedEnvironment();
    const mimir = (args: string[]) => command([target, ...args], { cwd: root, env });
    const host: ServiceHost = {
      exists: (path) => Promise.resolve(existsSync(path)),
      health: hostHealth,
      kill: (pid) => {
        process.kill(pid, 'SIGKILL');
        return Promise.resolve();
      },
      mimir,
    };
    const version = await mimir(['version']);
    const labels = unitLabels({ id, kind: 'sandbox' });
    const steps = await verifyServiceLifecycle(host, {
      attempts: ATTEMPTS,
      liveState: () => liveUnitState(root),
      pause,
      port: await freePort(),
      unitFileMarker: labels.serve.slice(0, -'serve'.length),
      version,
    });
    return {
      binarySha256: await hashFile(target),
      mimirVersion: version,
      steps,
      supervisor: process.platform === 'darwin' ? 'launchd' : 'systemd',
    };
  }

  private async verifyContainer(
    id: string,
    root: string,
    binary: string | undefined,
  ): Promise<Record<string, unknown>> {
    const docker = (args: string[], timeout = 120_000) =>
      command(['docker', ...args], { cwd: this.repository, timeout });
    const architecture = await docker(['info', '--format', '{{.Architecture}}']);
    const arch = /^(aarch64|arm64)$/.test(architecture) ? 'arm64' : 'x64';
    const asset = `mimir-linux-${arch}`;
    const stage = join(root, 'stage');
    await mkdir(join(stage, 'shim'), { mode: 0o755, recursive: true });

    const candidate = join(stage, asset);
    if (binary === undefined) {
      await command([process.execPath, 'run', 'build:ui'], {
        cwd: this.repository,
        timeout: 600_000,
      });
      await command([process.execPath, 'run', 'assets'], {
        cwd: this.repository,
        timeout: 600_000,
      });
      await command(
        [
          process.execPath,
          'build',
          'packages/bin/src/main.ts',
          '--compile',
          `--target=bun-linux-${arch}`,
          '--outfile',
          candidate,
        ],
        { cwd: this.repository, timeout: 600_000 },
      );
    } else {
      await writeFile(candidate, await readFile(resolve(this.repository, binary)));
    }
    await chmod(candidate, 0o755);
    const digest = await hashFile(candidate);
    await writeFile(join(stage, 'SHA256SUMS'), `${digest}  ${asset}\n`);
    await writeFile(join(stage, 'install.sh'), await readFile(join(this.repository, 'install.sh')));
    // Only the release download is substituted; install.sh runs unchanged.
    await writeFile(
      join(stage, 'shim', 'curl'),
      `#!/bin/sh
set -eu
url= output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    --proto) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
base="https://github.com/dbtlr/mimir/releases/download/${FIXTURE_TAG}"
case "$url" in
  "$base/${asset}") cp "${CONTAINER_STAGE}/${asset}" "$output" ;;
  "$base/SHA256SUMS") cp "${CONTAINER_STAGE}/SHA256SUMS" "$output" ;;
  *) echo "unexpected download: $url" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 },
    );

    const dockerfile = join(
      this.repository,
      'packages',
      'sandbox',
      'container',
      'systemd.Dockerfile',
    );
    const image = `mimir-service-verify:${createHash('sha256')
      .update(await readFile(dockerfile))
      .digest('hex')
      .slice(0, 16)}`;
    await docker(
      [
        'build',
        '--quiet',
        '--label',
        `${CONTAINER_LABEL}=image`,
        '--tag',
        image,
        '--file',
        dockerfile,
        join(this.repository, 'packages', 'sandbox', 'container'),
      ],
      900_000,
    );
    // systemd as PID 1 needs a writable cgroup tree and tmpfs run directories.
    const containerId = await docker([
      'run',
      '--detach',
      '--name',
      `mimir-service-verify-${id}`,
      '--label',
      `${CONTAINER_LABEL}=${id}`,
      '--privileged',
      '--cgroupns=private',
      '--tmpfs',
      '/run',
      '--tmpfs',
      '/run/lock',
      image,
    ]);
    const run = runSchema.parse(JSON.parse(await readFile(join(root, 'run.json'), 'utf8')));
    await privateJson(join(root, 'run.json'), { ...run, containerId });

    const uid = await docker(['exec', containerId, 'id', '-u', CONTAINER_USER]);
    const runtime = `/run/user/${uid}`;
    let ready = false;
    for (let poll = 0; poll < ATTEMPTS && !ready; poll += 1) {
      ready =
        (await attempt(['docker', 'exec', containerId, 'test', '-S', `${runtime}/bus`], root)) !==
        undefined;
      if (!ready) {
        await pause();
      }
    }
    if (!ready) {
      throw new Error(`the container's user manager never started (${runtime}/bus)`);
    }
    await docker(['cp', `${stage}/.`, `${containerId}:${CONTAINER_STAGE}`]);
    await docker(['exec', containerId, 'chmod', '-R', 'a+rX', CONTAINER_STAGE]);

    const asUser = (env: Record<string, string>, args: string[]) =>
      docker([
        'exec',
        '--user',
        CONTAINER_USER,
        '--workdir',
        CONTAINER_HOME,
        ...Object.entries({ HOME: CONTAINER_HOME, ...env }).flatMap(([key, value]) => [
          '--env',
          `${key}=${value}`,
        ]),
        containerId,
        ...args,
      ]);
    await asUser(
      { MIMIR_VERSION: FIXTURE_TAG, PATH: `${CONTAINER_STAGE}/shim:/usr/local/bin:/usr/bin:/bin` },
      ['sh', `${CONTAINER_STAGE}/install.sh`],
    );
    const installed = `${CONTAINER_HOME}/.local/bin/mimir`;
    const receipt = z
      .object({ mode: z.literal('live'), paths: z.object({ config: z.string() }) })
      .parse(JSON.parse(await asUser({}, ['cat', `${installed}.installation.json`])));

    const userEnv = {
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
      PATH: '/usr/local/bin:/usr/bin:/bin',
      XDG_RUNTIME_DIR: runtime,
    };
    const host: ServiceHost = {
      exists: async (path) =>
        (await attempt(['docker', 'exec', containerId, 'test', '-e', path], root)) !== undefined,
      health: async (port) => {
        const body = await attempt(
          [
            'docker',
            'exec',
            containerId,
            '/usr/bin/curl',
            '-fsS',
            '--max-time',
            '2',
            `http://127.0.0.1:${String(port)}/api/health`,
          ],
          root,
        );
        return body === undefined
          ? undefined
          : z.object({ version: z.string() }).safeParse(JSON.parse(body)).data?.version;
      },
      kill: async (pid) => {
        await docker(['exec', containerId, 'kill', '-9', String(pid)]);
      },
      mimir: (args) => asUser(userEnv, [installed, ...args]),
    };
    const version = await host.mimir(['version']);
    const steps = await verifyServiceLifecycle(host, {
      attempts: ATTEMPTS,
      liveState: () => liveUnitState(root),
      pause,
      port: CONTAINER_PORT,
      unitFileMarker: `${CONTAINER_HOME}/.config/systemd/user/com.dbtlr.mimir.`,
      version,
    });
    // The container's installation has its own configuration and no database.
    const config =
      (await attempt(
        ['docker', 'exec', containerId, 'cat', `${receipt.paths.config}/config.toml`],
        root,
      )) ?? '';
    if (/postgres/i.test(config)) {
      throw new Error(`the container installation's configuration names Postgres:\n${config}`);
    }
    return {
      binarySha256: digest,
      configuration: receipt.paths.config,
      image,
      installer: 'install.sh',
      mimirVersion: version,
      steps,
      supervisor: 'systemd (container)',
    };
  }
}

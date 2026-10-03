/**
 * The real supervisor lifecycle an installed `mimir service` must survive
 * (MMR-54): install, health, status, restart, kill-and-recover, stop, start, and
 * uninstall, each proven by observing the supervisor and the daemon's
 * `/api/health` rather than trusting a verb's exit code. The same sequence runs
 * against launchd, systemd user units on a host, and systemd in a container; a
 * {@link ServiceHost} hides where the installation lives.
 */
import { z } from 'zod';

/** The edges of wherever the installation under test runs. */
export type ServiceHost = {
  /** Run the installed `mimir` with these arguments; resolves stdout, rejects on failure. */
  mimir: (args: string[]) => Promise<string>;
  /** The version `/api/health` reports on this port, or undefined when nothing answers. */
  health: (port: number) => Promise<string | undefined>;
  /** SIGKILL a process, as a crash would. */
  kill: (pid: number) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
};

export type LifecycleOptions = {
  port: number;
  /** The version the installed binary reports; the daemon must serve exactly it. */
  version: string;
  /** Every unit file the install writes must contain this: the installation's own unit names. */
  unitFileMarker: string;
  /** A fingerprint of the live units, which must not change across the run. */
  liveState: () => Promise<string>;
  /** Polls per wait before a transition counts as failed. */
  attempts: number;
  /** The delay between polls. */
  pause: () => Promise<void>;
};

export type LifecycleStep = { step: string; at: string; detail: string };

const actionsSchema = z.object({
  actions: z.array(
    z.object({
      ok: z.boolean(),
      paths: z.object({ plist: z.string() }).optional(),
      unit: z.enum(['serve', 'snapshot']),
    }),
  ),
});

const unitSchema = z.object({
  health: z.object({ running_version: z.string() }).nullable().optional(),
  loaded: z.boolean(),
  pid: z.number().nullable(),
  running: z.boolean(),
  unit: z.enum(['serve', 'snapshot']),
});
const statusSchema = z.object({ units: z.array(unitSchema) });
type UnitState = z.infer<typeof unitSchema>;
type Status = { serve: UnitState; snapshot: UnitState };

async function status(host: ServiceHost): Promise<Status> {
  const parsed = statusSchema.parse(
    JSON.parse(await host.mimir(['service', 'status', '--format', 'json'])),
  );
  const serve = parsed.units.find((u) => u.unit === 'serve');
  const snapshot = parsed.units.find((u) => u.unit === 'snapshot');
  if (serve === undefined || snapshot === undefined) {
    throw new Error('service status did not report both units');
  }
  return { serve, snapshot };
}

const describe = (s: Status): string =>
  `serve loaded=${String(s.serve.loaded)} running=${String(s.serve.running)} pid=${String(s.serve.pid)}; snapshot loaded=${String(s.snapshot.loaded)}`;

export async function verifyServiceLifecycle(
  host: ServiceHost,
  options: LifecycleOptions,
): Promise<LifecycleStep[]> {
  const steps: LifecycleStep[] = [];
  const record = (step: string, detail: string): void => {
    steps.push({ at: new Date().toISOString(), detail, step });
  };

  /** Poll `probe` until it yields a value; a transition that never settles fails `step`. */
  async function settle<T>(
    step: string,
    probe: () => Promise<T | undefined>,
    observe: () => Promise<string>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
      const value = await probe();
      if (value !== undefined) {
        return value;
      }
      if (attempt < options.attempts) {
        await options.pause();
      }
    }
    throw new Error(`${step}: never settled — last observed ${await observe()}`);
  }

  const healthy = async (): Promise<boolean> =>
    (await host.health(options.port)) === options.version;
  const observe = async (): Promise<string> =>
    `${describe(await status(host))}; health=${(await host.health(options.port)) ?? 'none'}`;
  /** Wait until serve runs a process other than `previous` and answers health. */
  const running = (step: string, previous?: number | null) =>
    settle(
      step,
      async () => {
        const s = await status(host);
        const pid = s.serve.pid;
        const fresh = s.serve.running && pid !== null && pid !== previous;
        return fresh && (await healthy()) ? pid : undefined;
      },
      observe,
    );
  /** Wait until serve is down and its port is silent. */
  const down = (step: string, snapshotLoaded: boolean) =>
    settle(
      step,
      async () => {
        const s = await status(host);
        const quiet = !s.serve.loaded && (await host.health(options.port)) === undefined;
        return quiet && s.snapshot.loaded === snapshotLoaded ? true : undefined;
      },
      observe,
    );

  const liveBefore = await options.liveState();

  const installed = actionsSchema.parse(
    JSON.parse(
      await host.mimir([
        'service',
        'install',
        'serve',
        '--port',
        String(options.port),
        '--format',
        'json',
      ]),
    ),
  );
  const unitFiles = installed.actions.map((action) => {
    const file = action.paths?.plist;
    if (!action.ok || file === undefined) {
      throw new Error(`install: ${action.unit} did not report an installed unit file`);
    }
    if (!file.includes(options.unitFileMarker)) {
      throw new Error(
        `install: ${file} is not one of this installation's units (${options.unitFileMarker})`,
      );
    }
    return file;
  });
  for (const file of unitFiles) {
    if (!(await host.exists(file))) {
      throw new Error(`install: ${file} was reported but is not on disk`);
    }
  }
  record('install', unitFiles.join(', '));

  await settle('health', async () => ((await healthy()) ? true : undefined), observe);
  record('health', `port ${String(options.port)} serves ${options.version}`);

  const first = await status(host);
  if (
    !first.serve.loaded ||
    !first.serve.running ||
    first.serve.pid === null ||
    first.serve.health?.running_version !== options.version ||
    first.snapshot.loaded
  ) {
    throw new Error(
      `status: expected serve loaded and healthy, the snapshot timer not installed — ${describe(first)}`,
    );
  }
  record('status', describe(first));

  await host.mimir(['service', 'restart', 'serve', '--format', 'json']);
  const restarted = await running('restart', first.serve.pid);
  record('restart', `pid ${String(first.serve.pid)} → ${String(restarted)}`);

  await host.kill(restarted);
  const recovered = await running('kill-and-recover', restarted);
  record(
    'kill-and-recover',
    `killed ${String(restarted)}; supervisor respawned ${String(recovered)}`,
  );

  await host.mimir(['service', 'stop', 'serve', '--format', 'json']);
  await down('stop', false);
  record('stop', 'serve unloaded; port silent');

  await host.mimir(['service', 'start', 'serve', '--format', 'json']);
  const started = await running('start', null);
  record('start', `pid ${String(started)}`);

  await host.mimir(['service', 'uninstall', '--format', 'json']);
  await down('uninstall', false);
  for (const file of unitFiles) {
    if (await host.exists(file)) {
      throw new Error(`uninstall: ${file} is still on disk`);
    }
  }
  record('uninstall', 'serve unloaded and its unit file removed');

  const liveAfter = await options.liveState();
  if (liveAfter !== liveBefore) {
    throw new Error(`live units changed during the run: ${liveBefore} → ${liveAfter}`);
  }
  record('live-untouched', liveAfter);
  return steps;
}

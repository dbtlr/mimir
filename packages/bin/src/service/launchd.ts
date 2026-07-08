/**
 * The supervisor seam (MMR-47): `service` verbs speak this interface; launchd
 * is its first implementation (systemd is a parked follow-up behind the same
 * seam). Modern launchctl subcommands only. Quirks the shape encodes:
 * KeepAlive restarts a killed process, so honest stop is bootout (plist stays
 * on disk); restart is kickstart -k; a nonzero `print` means not loaded.
 */
import { MimirError } from '../core';
import type { Exec, ExecResult } from '../exec';
import { SERVE_LABEL } from './plist';

// Re-exported from the shared exec module so existing importers keep working.
export type { Exec, ExecResult } from '../exec';
export { bunExec } from '../exec';

export type ServiceInfo = {
  loaded: boolean;
  running: boolean;
  pid?: number;
};

export type Supervisor = {
  install: (serviceFile: string) => Promise<void>;
  uninstall: () => Promise<void>;
  start: (serviceFile: string) => Promise<void>;
  stop: () => Promise<void>;
  restart: () => Promise<void>;
  info: () => Promise<ServiceInfo>;
};

/** `bootout` is asynchronous — it returns before launchd has fully torn the old
 *  unit down, so an immediate `bootstrap` can lose the race and fail with error
 *  5 ("Input/output error"), leaving nothing loaded. Retry the bootstrap a few
 *  times on exactly that code, waiting for the teardown to settle between
 *  attempts; any other exit is a genuine failure and surfaces at once. */
const BOOTSTRAP_ATTEMPTS = 5;
const BOOTSTRAP_SETTLE_MS = 250;
const BOOTSTRAP_RACE_CODE = 5;

export class LaunchdSupervisor implements Supervisor {
  private readonly target: string;
  private readonly service: string;
  private readonly exec: Exec;
  private readonly sleep: (ms: number) => Promise<void>;
  /** `label` selects the unit this supervisor manages; defaults to serve.
   *  `sleep` is injectable so tests exercise the retry without real delay. */
  constructor(
    exec: Exec,
    uid: number,
    label: string = SERVE_LABEL,
    sleep: (ms: number) => Promise<void> = Bun.sleep,
  ) {
    this.exec = exec;
    this.sleep = sleep;
    this.target = `gui/${String(uid)}`;
    this.service = `${this.target}/${label}`;
  }

  /** The `validation` error a nonzero launchctl exit raises, built once so the
   *  message/category can't drift between `run` and `bootstrapWithRetry`. */
  private launchctlError(verb: string, failure: string, result: ExecResult): MimirError {
    return new MimirError(
      'validation',
      `launchctl ${verb} failed (${String(result.code)}): ${failure}`,
      result.stderr.trim() === '' ? undefined : result.stderr.trim(),
    );
  }

  private async run(argv: string[], failure: string, tolerate = false): Promise<void> {
    const result = await this.exec(['launchctl', ...argv]);
    if (result.code !== 0 && !tolerate) {
      throw this.launchctlError(argv[0] ?? '', failure, result);
    }
  }

  async install(plistFile: string): Promise<void> {
    // Idempotent refresh: clear any loaded copy first; bootout of an
    // unloaded service is the expected no-op, so its failure is tolerated.
    await this.run(['bootout', this.service], '', true);
    await this.bootstrapWithRetry(plistFile);
  }

  /** Bootstrap, retrying ONLY the async-teardown race (BOOTSTRAP_RACE_CODE) so a
   *  genuine, non-transient failure still surfaces immediately. A race that
   *  outlives the retry budget surfaces as the usual load error. */
  private async bootstrapWithRetry(plistFile: string): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      const result = await this.exec(['launchctl', 'bootstrap', this.target, plistFile]);
      if (result.code === 0) {
        return;
      }
      if (result.code !== BOOTSTRAP_RACE_CODE || attempt >= BOOTSTRAP_ATTEMPTS) {
        throw this.launchctlError('bootstrap', 'could not load the service', result);
      }
      await this.sleep(BOOTSTRAP_SETTLE_MS);
    }
  }

  async uninstall(): Promise<void> {
    await this.run(['bootout', this.service], '', true);
  }

  async start(plistFile: string): Promise<void> {
    // A stop→start sequence hits the same async-teardown race as a reinstall
    // (the prior `stop`'s bootout may still be settling), so share the retry.
    await this.bootstrapWithRetry(plistFile);
  }

  async stop(): Promise<void> {
    await this.run(['bootout', this.service], 'could not unload the service');
  }

  async restart(): Promise<void> {
    await this.run(['kickstart', '-k', this.service], 'is the service installed?');
  }

  async info(): Promise<ServiceInfo> {
    const result = await this.exec(['launchctl', 'print', this.service]);
    if (result.code !== 0) {
      return { loaded: false, running: false };
    }
    const pidMatch = /\bpid = (\d+)/.exec(result.stdout);
    const running = /\bstate = running/.test(result.stdout) || pidMatch !== null;
    const info: ServiceInfo = { loaded: true, running };
    if (pidMatch?.[1] !== undefined) {
      info.pid = Number(pidMatch[1]);
    }
    return info;
  }
}

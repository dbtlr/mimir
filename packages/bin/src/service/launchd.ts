/**
 * The supervisor seam (MMR-47): `service` verbs speak this interface; launchd
 * is its first implementation (systemd is a parked follow-up behind the same
 * seam). Modern launchctl subcommands only. Quirks the shape encodes:
 * KeepAlive restarts a killed process, so honest stop is bootout (plist stays
 * on disk); restart is kickstart -k; a nonzero `print` means not loaded.
 */
import { MimirError } from '../core';
import type { Exec } from '../exec';
import { LABEL } from './plist';

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

export class LaunchdSupervisor implements Supervisor {
  private readonly target: string;
  private readonly exec: Exec;
  constructor(exec: Exec, uid: number) {
    this.exec = exec;
    this.target = `gui/${String(uid)}`;
  }

  private async run(argv: string[], failure: string, tolerate = false): Promise<void> {
    const result = await this.exec(['launchctl', ...argv]);
    if (result.code !== 0 && !tolerate) {
      throw new MimirError(
        'validation',
        `launchctl ${argv[0] ?? ''} failed (${String(result.code)}): ${failure}`,
        result.stderr.trim() === '' ? undefined : result.stderr.trim(),
      );
    }
  }

  async install(plistFile: string): Promise<void> {
    // Idempotent refresh: clear any loaded copy first; bootout of an
    // unloaded service is the expected no-op, so its failure is tolerated.
    await this.run(['bootout', `${this.target}/${LABEL}`], '', true);
    await this.run(['bootstrap', this.target, plistFile], 'could not load the service');
  }

  async uninstall(): Promise<void> {
    await this.run(['bootout', `${this.target}/${LABEL}`], '', true);
  }

  async start(plistFile: string): Promise<void> {
    await this.run(['bootstrap', this.target, plistFile], 'could not load the service');
  }

  async stop(): Promise<void> {
    await this.run(['bootout', `${this.target}/${LABEL}`], 'could not unload the service');
  }

  async restart(): Promise<void> {
    await this.run(['kickstart', '-k', `${this.target}/${LABEL}`], 'is the service installed?');
  }

  async info(): Promise<ServiceInfo> {
    const result = await this.exec(['launchctl', 'print', `${this.target}/${LABEL}`]);
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

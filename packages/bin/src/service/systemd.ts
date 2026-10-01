/**
 * The systemd user-unit implementation of the supervisor seam (MMR-54; see
 * ./supervisor). Every call is `systemctl --user`, so units run in the calling
 * user's manager; a Linux host keeps them running without a login session once
 * linger is enabled (`loginctl enable-linger`). Quirks the shape encodes:
 *
 *   - install enables by absolute file path, which links a unit file kept
 *     outside the manager's search path (a sandbox's own data directory) and is
 *     a plain enable for one already inside it (a live `~/.config/systemd/user`).
 *     Companion files (the snapshot timer's oneshot service) are linked first.
 *   - stop/start keep the unit enabled, like launchd's bootout/bootstrap keep the
 *     plist on disk: the unit comes back at the next manager start.
 *   - `show` exits 0 even for unknown units, so `loaded` is read from the
 *     active state, never the exit code alone.
 */
import { basename } from 'node:path';

import type { Exec, ExecResult } from '../exec';
import { supervisorError } from './supervisor';
import type { ServiceInfo, Supervisor } from './supervisor';

/** Active states in which the unit is up or on its way up (or down): launchd's
 *  "loaded". `inactive` and `failed` read as not loaded. */
const LOADED_STATES = new Set(['active', 'activating', 'deactivating', 'reloading']);

export class SystemdSupervisor implements Supervisor {
  private readonly exec: Exec;
  private readonly unit: string;
  private readonly companions: readonly string[];
  /** `unit` is the full unit name this supervisor drives (`<label>.service` or
   *  `<label>.timer`); `companions` are unit files the unit needs linked. */
  constructor(exec: Exec, unit: string, companions: readonly string[] = []) {
    this.exec = exec;
    this.unit = unit;
    this.companions = companions;
  }

  private async systemctl(argv: string[]): Promise<ExecResult> {
    return await this.exec(['systemctl', '--user', ...argv]);
  }

  private async run(argv: string[], failure: string): Promise<void> {
    const result = await this.systemctl(argv);
    if (result.code !== 0) {
      throw supervisorError('systemctl', argv[0] ?? '', failure, result);
    }
  }

  async install(unitFile: string): Promise<void> {
    for (const companion of this.companions) {
      await this.run(['link', companion], 'could not link the unit file');
    }
    await this.run(['enable', unitFile], 'could not enable the service');
    // Re-read changed unit files, then restart: an idempotent refresh that
    // starts a stopped unit and re-execs a running one on its new definition.
    await this.run(['daemon-reload'], 'could not reload the user manager');
    await this.run(['restart', this.unit], 'could not start the service');
  }

  async uninstall(): Promise<void> {
    // Disabling an absent unit is the expected no-op, so failures are tolerated.
    await this.systemctl(['disable', '--now', this.unit]);
    for (const companion of this.companions) {
      await this.systemctl(['disable', '--now', basename(companion)]);
    }
  }

  async start(): Promise<void> {
    await this.run(['start', this.unit], 'could not start the service');
  }

  async stop(): Promise<void> {
    await this.run(['stop', this.unit], 'could not stop the service');
  }

  async restart(): Promise<void> {
    await this.run(['restart', this.unit], 'is the service installed?');
  }

  async info(): Promise<ServiceInfo> {
    const result = await this.systemctl([
      'show',
      this.unit,
      '--property=LoadState,ActiveState,SubState,MainPID',
    ]);
    if (result.code !== 0) {
      return { loaded: false, running: false };
    }
    const props = new Map<string, string>();
    for (const line of result.stdout.split('\n')) {
      const at = line.indexOf('=');
      if (at > 0) {
        props.set(line.slice(0, at), line.slice(at + 1).trim());
      }
    }
    const loaded =
      props.get('LoadState') === 'loaded' && LOADED_STATES.has(props.get('ActiveState') ?? '');
    const pid = Number(props.get('MainPID') ?? '0');
    const running = loaded && Number.isInteger(pid) && pid > 0;
    const info: ServiceInfo = { loaded, running };
    if (running) {
      info.pid = pid;
    }
    return info;
  }
}

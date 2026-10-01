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
 *   - uninstall stops a running unit explicitly before `disable`: `disable
 *     --now` refuses a unit whose file is gone before it stops anything. It then
 *     removes the unit files itself, between `disable` (which needs them) and
 *     `daemon-reload` (which must not find them).
 *   - `show` exits 0 even for unknown units, so `loaded` is read from the
 *     active state, never the exit code alone. The load state is ignored: a
 *     unit whose file vanished keeps running as `not-found` after a reload.
 */
import { rmSync } from 'node:fs';
import { basename } from 'node:path';

import type { Exec, ExecResult } from '../exec';
import { supervisorError } from './supervisor';
import type { ServiceInfo, Supervisor } from './supervisor';

/** Active states in which the unit is up or on its way up (or down): launchd's
 *  "loaded". `inactive` and `failed` read as not loaded. */
const LOADED_STATES = new Set(['active', 'activating', 'deactivating', 'reloading']);

/** The exit a missing `systemctl` reports, matching the shell's "command not found". */
const NOT_FOUND = 127;

export class SystemdSupervisor implements Supervisor {
  private readonly exec: Exec;
  private readonly unitFile: string;
  private readonly unit: string;
  private readonly companions: readonly string[];
  /** `unitFile` is the unit this supervisor drives (`<label>.service` or
   *  `<label>.timer`; its name is the file's basename); `companions` are unit
   *  files the unit needs linked and removed with it. */
  constructor(exec: Exec, unitFile: string, companions: readonly string[] = []) {
    this.exec = exec;
    this.unitFile = unitFile;
    this.unit = basename(unitFile);
    this.companions = companions;
  }

  /** A Linux host without systemd (a container, OpenRC, WSL) has no systemctl;
   *  that reads as a failed command, never an uncaught spawn error. */
  private async systemctl(argv: string[]): Promise<ExecResult> {
    try {
      return await this.exec(['systemctl', '--user', ...argv]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { code: NOT_FOUND, stderr: `systemctl unavailable: ${reason}`, stdout: '' };
    }
  }

  private async run(argv: string[], failure: string): Promise<void> {
    const result = await this.systemctl(argv);
    if (result.code !== 0) {
      throw supervisorError('systemctl', argv[0] ?? '', failure, result);
    }
  }

  async install(): Promise<void> {
    for (const companion of this.companions) {
      await this.run(['link', companion], 'could not link the unit file');
    }
    await this.run(['enable', this.unitFile], 'could not enable the service');
    // Re-read changed unit files, then restart: an idempotent refresh that
    // starts a stopped unit and re-execs a running one on its new definition.
    await this.run(['daemon-reload'], 'could not reload the user manager');
    await this.run(['restart', this.unit], 'could not start the service');
  }

  /** The unit's `show` properties; empty when the manager is unreachable. */
  private async show(unit: string): Promise<Map<string, string>> {
    const props = new Map<string, string>();
    const result = await this.systemctl(['show', unit, '--property=ActiveState,MainPID']);
    if (result.code !== 0) {
      return props;
    }
    for (const line of result.stdout.split('\n')) {
      const at = line.indexOf('=');
      if (at > 0) {
        props.set(line.slice(0, at), line.slice(at + 1).trim());
      }
    }
    return props;
  }

  private async isUp(unit: string): Promise<boolean> {
    return LOADED_STATES.has((await this.show(unit)).get('ActiveState') ?? '');
  }

  /** Stop what runs, disable, remove the unit files, then reload so the manager
   *  forgets the units instead of keeping definitions whose files are gone. A
   *  running unit that will not stop fails loudly, before any file is removed.
   *  Disabling an absent unit is the expected no-op, so `disable` and the
   *  reload tolerate failure. */
  async uninstall(): Promise<void> {
    const units = [this.unitFile, ...this.companions].map((file) => basename(file));
    for (const unit of units) {
      if (await this.isUp(unit)) {
        await this.run(['stop', unit], 'could not stop the service');
      }
    }
    for (const unit of units) {
      await this.systemctl(['disable', unit]);
    }
    for (const file of [this.unitFile, ...this.companions]) {
      rmSync(file, { force: true });
    }
    await this.systemctl(['daemon-reload']);
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
    const props = await this.show(this.unit);
    const loaded = LOADED_STATES.has(props.get('ActiveState') ?? '');
    const pid = Number(props.get('MainPID') ?? '0');
    const running = loaded && Number.isInteger(pid) && pid > 0;
    const info: ServiceInfo = { loaded, running };
    if (running) {
      info.pid = pid;
    }
    return info;
  }
}

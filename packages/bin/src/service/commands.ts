/**
 * The service command layer (MMR-47): verbs over the supervisor seam, the
 * config, the unit files, and the event log. All effects flow through ServiceDeps
 * so tests drive the layer with fakes; main wires the real edges.
 *
 * Output conforms to the CLI contract (MMR-59): each verb computes a typed
 * result, then renders `json`/`jsonl` (structured envelope, ./format) or
 * human prose. The picked format is supplied by the dispatcher (pickFormat's
 * "report" kind); the param defaults to human for direct/test callers.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { formatInstant, isMember } from '@mimir/helpers';

import { usage } from '../cli/errors';
import { MimirError } from '../core';
import type { Format, Io } from '../presentation';
import { arrow, ok, warn } from '../presentation';
import { DEFAULT_SNAPSHOT_INTERVAL_SECONDS, writeServePort } from './config';
import type { GlobalConfig } from './config';
import { appendEvent, recentEvents } from './events';
import type { ServiceEventName } from './events';
import { formatSelfUpdateJson, formatServiceActionsJson, formatServiceStatusJson } from './format';
import type {
  SelfUpdateResult,
  ServiceActionResult,
  ServiceHealth,
  ServiceStatusReport,
  UnitName,
  UnitStatus,
} from './format';
import type { Health } from './health';
import {
  assetName,
  compareSemver,
  downloadAsset,
  downloadSums,
  replaceBinary,
  isSemverTag,
  resolveLatestTag,
  resolveNextChannelTag,
  verifyChecksum,
} from './self-update';
import type { Fetcher } from './self-update';
import type { Supervisor } from './supervisor';
import { mayDrive } from './units';
import type { SupervisorScope } from './units';

export type UpdateSelection = {
  /** Include prereleases — resolve the newest build on the next-version line (--next). */
  next?: boolean;
  /** Install this exact tag (official or prerelease); wins over `next` (--tag). */
  tag?: string;
};

/** Render one unit file from the given config file — the same file the command reads for its report. */
export type UnitRender = (
  configFile: string,
  config: GlobalConfig,
  port: number | undefined,
) => string;

/**
 * One managed supervisor unit (MMR-146, MMR-54). The supervisor is bound to
 * `label`; `render` produces the unit file (a launchd plist, a systemd .service
 * or .timer) at install time, reading live config for port/interval; `logFile`
 * is the unit's stdout/stderr sink. `companion` is a second owned file the unit
 * needs (the systemd snapshot timer's oneshot service), written and removed with it.
 */
export type ServiceUnit = {
  /** The installation-scoped supervisor label (./units); the fence checks it. */
  label: string;
  supervisor: Supervisor;
  /** The primary unit file; its presence on disk means "installed". */
  unitFile: string;
  logFile: string;
  render: UnitRender;
  companion?: { file: string; render: UnitRender };
};

export type ServiceDeps = {
  platform: NodeJS.Platform;
  /** Which installation is asking (./units): it may mutate only units it owns.
   * Tests supply fake supervisors and set this scope explicitly. */
  scope: SupervisorScope;
  /** The binary the unit file points at / self-update replaces (process.execPath). */
  binPath: string;
  /** This invocation's version (build-injected tag, or package.json) — the on-disk version by definition. */
  version: string;
  configFile: string;
  /** The serve fallback for this installation. */
  defaultPort: number;
  /** Dev-only explicit environment override captured for service installation. */
  portOverride?: number;
  /** Port baked into an installed non-live unit; absent for live units. */
  readInstalledPort: () => number | undefined;
  /** The build-profile-aware config projection used by every service read/render. */
  readConfig: (file: string) => GlobalConfig;
  eventsFile: string;
  /** GET /api/health on a port, undefined when nothing answers. */
  health: (port: number) => Promise<Health | undefined>;
  fetcher: Fetcher;
  /** The supervisor units this surface manages, keyed by name. */
  units: Record<UnitName, ServiceUnit>;
};

const SUBCOMMANDS = ['install', 'uninstall', 'start', 'stop', 'restart', 'status'] as const;
const UNITS = ['serve', 'snapshot'] as const;
/** The selector accepts a single unit or the literal `all`; omitted → the verb's default. */
const SELECTORS = ['serve', 'snapshot', 'all'] as const;

/** Validate the raw unit selector: a unit name, `all`, or undefined (verb default). */
function parseSelector(arg: string | undefined): 'all' | UnitName | undefined {
  if (arg === undefined) {
    return undefined;
  }
  if (!isMember(arg, SELECTORS)) {
    throw usage(`service: unknown unit '${arg}' (expected: ${SELECTORS.join(' | ')})`);
  }
  return arg;
}

/**
 * Resolve the selector to concrete units. `all` → both; a named unit → that one;
 * omitted → `fallback()`. Snapshot is opt-in: install/uninstall fall back to
 * serve only (a bare `install` never schedules the vault timer), while the
 * lifecycle verbs fall back to whatever is actually installed.
 */
function resolveUnits(sel: 'all' | UnitName | undefined, fallback: () => UnitName[]): UnitName[] {
  if (sel === 'all') {
    return [...UNITS];
  }
  if (sel !== undefined) {
    return [sel];
  }
  return fallback();
}

/** The platforms with a supervisor backend: launchd on macOS, systemd on Linux. */
export function hasSupervisor(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'linux';
}

function requireSupervisor(deps: ServiceDeps): void {
  if (!hasSupervisor(deps.platform)) {
    throw new MimirError(
      'validation',
      'mimir service requires launchd (macOS) or systemd (Linux)',
      'run `mimir serve --no-hunt` under your supervisor of choice',
    );
  }
}

/** The supervisor fence (MMR-147, narrowed by MMR-54): every supervisor-mutating
 *  verb refuses unless this process is an installation that owns every unit it
 *  would drive — a live installation the live names, a sandbox installation only
 *  its own sandbox-scoped names. Loud by design — a smoke that reaches for the
 *  real supervisor should fail its run, not silently pollute
 *  `~/Library/LaunchAgents` (it has, three times). Reads stay open: `status`
 *  never mutates. */
function requireRealSupervisor(deps: ServiceDeps, verb: string): void {
  if (deps.scope.kind === 'none') {
    throw new MimirError(
      'validation',
      `service ${verb} manages the host supervisor — refused from a dev/from-source build`,
      'use a registered live or sandbox installation to manage the real supervisor',
    );
  }
  for (const unit of Object.values(deps.units)) {
    if (!mayDrive(deps.scope, unit.label)) {
      throw new MimirError(
        'validation',
        `service ${verb} refused — ${unit.label} belongs to another installation`,
        'a sandbox installation drives only its own sandbox-scoped units; only a live installation drives the live ones',
      );
    }
  }
}

/** Render a service/self-update result: structured envelope, else human prose. */
function report(io: Io, format: Format, json: () => string, human: () => void): void {
  if (format === 'json' || format === 'jsonl') {
    io.write(json());
  } else {
    human();
  }
}

export async function cmdService(
  positionals: string[],
  values: { port?: string },
  io: Io,
  deps: ServiceDeps,
  format: Format = 'records',
): Promise<number> {
  const sub = positionals[1];
  if (sub === undefined || !isMember(sub, SUBCOMMANDS)) {
    throw usage(`service: unknown subcommand (expected: ${SUBCOMMANDS.join(' | ')})`);
  }
  requireSupervisor(deps);

  const log = (event: ServiceEventName, okFlag: boolean, detail?: string): void => {
    appendEvent(deps.eventsFile, {
      event,
      ok: okFlag,
      source: 'cli',
      version: deps.version,
      ...(detail === undefined ? {} : { detail }),
    });
  };

  // `status` is a read over every unit — the selector does not apply.
  if (sub === 'status') {
    return await statusReport(io, deps, format);
  }
  // Everything past this point mutates the host supervisor.
  requireRealSupervisor(deps, sub);

  const sel = parseSelector(positionals[2]);
  const installed = (): UnitName[] => UNITS.filter((n) => existsSync(deps.units[n].unitFile));
  const emitActions = (results: ServiceActionResult[], humans: (() => void)[]): void => {
    report(
      io,
      format,
      () => formatServiceActionsJson(results, format === 'json' ? 'json' : 'jsonl'),
      () => {
        for (const h of humans) {
          h();
        }
      },
    );
  };

  switch (sub) {
    case 'install': {
      // Snapshot is opt-in: a bare `install` sets up only the serve daemon.
      const units = resolveUnits(sel, () => ['serve']);
      // --port is a serve setting. Validate the value up front (pure), but defer
      // persisting it until render has proven the install can proceed: serve-env's
      // preflight throws inside render(), and a mutated config must not survive an
      // aborted install.
      let port: number | undefined;
      if (values.port !== undefined) {
        port = Number(values.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw usage('service install: --port expects an integer in 1–65535');
        }
      }
      // Render every unit file before any mutation — this is where a bad Norn env aborts.
      const config = deps.readConfig(deps.configFile);
      const effectivePort = port ?? deps.portOverride ?? config.serve.port ?? deps.defaultPort;
      const rendered = units.map((name) => {
        const unit = deps.units[name];
        const unitPort = name === 'serve' ? effectivePort : undefined;
        const files = [
          { content: unit.render(deps.configFile, config, unitPort), path: unit.unitFile },
        ];
        if (unit.companion !== undefined) {
          files.push({
            content: unit.companion.render(deps.configFile, config, unitPort),
            path: unit.companion.file,
          });
        }
        return { files, name, unit };
      });
      // A reset means the prior file was unparseable and got rewritten fresh
      // (lossy) — surface it rather than clobbering other sections silently.
      if (port !== undefined && writeServePort(deps.configFile, port).reset) {
        warn(io, `existing config at ${deps.configFile} was not valid TOML — rewrote it fresh`);
      }
      const results: ServiceActionResult[] = [];
      const humans: (() => void)[] = [];
      const fileLabel = deps.platform === 'darwin' ? 'plist: ' : 'unit:  ';
      for (const { files, name, unit } of rendered) {
        for (const file of files) {
          mkdirSync(dirname(file.path), { recursive: true });
          writeFileSync(file.path, file.content);
        }
        // Neither supervisor creates a missing log directory; the unit would
        // fail to spawn before writing a line.
        mkdirSync(dirname(unit.logFile), { recursive: true });
        await unit.supervisor.install(unit.unitFile);
        const paths = { config: deps.configFile, log: unit.logFile, plist: unit.unitFile };
        if (name === 'serve') {
          log('install', true, `serve · port ${String(effectivePort)}`);
          results.push({
            action: 'install',
            ok: true,
            paths,
            port: effectivePort,
            unit: 'serve',
          });
          humans.push(() => {
            ok(io, `serve installed — serving on http://127.0.0.1:${String(effectivePort)}`);
            io.write(`  ${fileLabel} ${unit.unitFile}`);
            io.write(
              `  config: ${deps.configFile}${port === undefined ? ' (defaults; set with service install --port)' : ''}`,
            );
            io.write(`  log:    ${unit.logFile}`);
          });
        } else {
          const interval = config.vault.snapshot?.interval ?? DEFAULT_SNAPSHOT_INTERVAL_SECONDS;
          log('install', true, `snapshot · interval ${String(interval)}s`);
          results.push({ action: 'install', ok: true, paths, unit: 'snapshot' });
          humans.push(() => {
            ok(io, `snapshot installed — every ${String(interval)}s`);
            io.write(`  ${fileLabel} ${unit.unitFile}`);
            io.write(`  log:    ${unit.logFile}`);
          });
        }
      }
      emitActions(results, humans);
      return 0;
    }
    case 'uninstall': {
      // A bare `uninstall` tears down whatever is installed — never orphaning
      // the opt-in snapshot timer (which would keep auto-committing/pushing the
      // vault). `uninstall <unit>` / `uninstall all` target explicitly.
      const units = resolveUnits(sel, installed);
      const results: ServiceActionResult[] = [];
      const humans: (() => void)[] = [];
      if (units.length === 0) {
        report(
          io,
          format,
          () => formatServiceActionsJson([], format === 'json' ? 'json' : 'jsonl'),
          () => ok(io, 'nothing installed to uninstall'),
        );
        return 0;
      }
      for (const name of units) {
        const unit = deps.units[name];
        const onDisk = existsSync(unit.unitFile);
        // "Present" = on disk OR still loaded (a unit file can vanish while the unit
        // runs). The bootout is tolerant either way; we report/log a teardown
        // exactly when there was something to tear down — no phantom event for a
        // never-installed unit, no silent teardown of a live one.
        const present = onDisk || (await unit.supervisor.info()).loaded;
        await unit.supervisor.uninstall();
        rmSync(unit.unitFile, { force: true });
        if (unit.companion !== undefined) {
          rmSync(unit.companion.file, { force: true });
        }
        results.push({ action: 'uninstall', ok: true, unit: name });
        if (present) {
          log('uninstall', true, name);
          humans.push(() => ok(io, `${name} uninstalled (config and logs kept)`));
        } else {
          humans.push(() => ok(io, `${name}: not installed (nothing to remove)`));
        }
      }
      emitActions(results, humans);
      return 0;
    }
    case 'start':
    case 'stop':
    case 'restart': {
      // A lifecycle verb acts only on an INSTALLED unit, whatever the selector:
      // a bare verb sweeps what's installed, and naming (or `all`-including) a
      // not-installed unit is a reported no-op, never a supervisor throw.
      const units = resolveUnits(sel, installed);
      const pastTense = { restart: 'restarted', start: 'started', stop: 'stopped' } as const;
      const results: ServiceActionResult[] = [];
      const humans: (() => void)[] = [];
      for (const name of units) {
        const unit = deps.units[name];
        if (!existsSync(unit.unitFile)) {
          results.push({ action: sub, ok: false, unit: name });
          humans.push(() => warn(io, `${name}: not installed — nothing to ${sub}`));
          continue;
        }
        if (sub === 'start') {
          await unit.supervisor.start(unit.unitFile);
        } else if (sub === 'stop') {
          await unit.supervisor.stop();
        } else {
          await unit.supervisor.restart();
        }
        log(sub, true, name);
        results.push({ action: sub, ok: true, unit: name });
        humans.push(() => ok(io, `${name} ${pastTense[sub]}`));
      }
      if (results.length === 0) {
        // Only a bare sweep reaches here (all/explicit resolve to ≥1 unit): a
        // host with nothing installed. Nothing was acted on → nonzero, with
        // guidance, so a `mimir service restart && …` chain doesn't proceed.
        report(
          io,
          format,
          () => formatServiceActionsJson([], format === 'json' ? 'json' : 'jsonl'),
          () => ok(io, 'no units installed (install with `mimir service install`)'),
        );
        return 1;
      }
      emitActions(results, humans);
      // One invariant covers every selector: the verb succeeds iff it actually
      // acted on at least one unit. A sweep that touched only the opt-in
      // snapshot's absence still restarted serve (success); `start all` when the
      // serve daemon itself is absent, or an explicit missing unit, acted on
      // nothing (failure) — so a deploy chain never proceeds on a no-op.
      return results.some((r) => r.ok) ? 0 : 1;
    }
    default: {
      // Unreachable — `sub` is validated against SUBCOMMANDS above (narrows to never here).
      throw usage(`service: unknown subcommand (expected: ${SUBCOMMANDS.join(' | ')})`);
    }
  }
}

/** Status over every unit: serve carries port + health, snapshot its interval. */
async function statusReport(io: Io, deps: ServiceDeps, format: Format): Promise<number> {
  // One parse of the config file, both sections read from it (MMR-146 review).
  const parsed = deps.readConfig(deps.configFile);
  const config = parsed.serve;
  // A config that couldn't be honored is always a stderr warning (warnings stay
  // off stdout, per the output contract); the JSON envelope also carries it.
  if (config.problem !== undefined) {
    warn(io, `config ignored (${config.problem}) — ${deps.configFile}`);
  }

  const serveInfo = await deps.units.serve.supervisor.info();
  // Probe the port resolved from the installation-bound configuration.
  const port = deps.readInstalledPort() ?? deps.portOverride ?? config.port ?? deps.defaultPort;
  const healthRaw = await deps.health(port);
  const health: ServiceHealth | null =
    healthRaw === undefined
      ? null
      : {
          onDiskVersion: deps.version,
          // The health payload is an untrusted boundary: a non-SemVer version
          // (foreign responder on the port) is by definition not the on-disk
          // binary — restart pending, never a crash in a pure read.
          restartPending:
            !isSemverTag(healthRaw.version) || compareSemver(healthRaw.version, deps.version) !== 0,
          runningVersion: healthRaw.version,
        };
  const serve: UnitStatus = {
    configProblem: config.problem ?? null,
    health,
    loaded: serveInfo.loaded,
    log: deps.units.serve.logFile,
    pid: serveInfo.pid ?? null,
    plist: deps.units.serve.unitFile,
    port,
    running: serveInfo.running,
    unit: 'serve',
  };

  const snapInfo = await deps.units.snapshot.supervisor.info();
  const snapshot: UnitStatus = {
    intervalSeconds: parsed.vault.snapshot?.interval ?? DEFAULT_SNAPSHOT_INTERVAL_SECONDS,
    loaded: snapInfo.loaded,
    log: deps.units.snapshot.logFile,
    pid: snapInfo.pid ?? null,
    plist: deps.units.snapshot.unitFile,
    running: snapInfo.running,
    unit: 'snapshot',
  };

  const status: ServiceStatusReport = {
    config: deps.configFile,
    recentEvents: recentEvents(deps.eventsFile, 5),
    units: [serve, snapshot],
  };
  report(
    io,
    format,
    () => formatServiceStatusJson(status, format === 'json'),
    () => renderStatusHuman(status, io),
  );
  return 0;
}

function renderUnitHuman(u: UnitStatus, io: Io): void {
  const state = u.loaded
    ? `loaded, ${u.running ? `running (pid ${String(u.pid ?? '?')})` : 'not running'}`
    : 'not loaded';
  io.write(`${u.unit}: ${state}`);
  if (u.unit === 'serve') {
    if (u.health === null || u.health === undefined) {
      io.write(`  port ${String(u.port)}: no answer on /api/health`);
    } else {
      io.write(
        `  port ${String(u.port)}: running ${u.health.runningVersion} · on-disk ${u.health.onDiskVersion}${u.health.restartPending ? ' — restart pending' : ''}`,
      );
    }
  } else {
    io.write(`  interval: every ${String(u.intervalSeconds ?? 0)}s`);
  }
  io.write(`  unit file ${u.plist} · log ${u.log}`);
}

function renderStatusHuman(s: ServiceStatusReport, io: Io): void {
  for (const u of s.units) {
    renderUnitHuman(u, io);
  }
  if (s.recentEvents.length > 0) {
    io.write('recent events:');
    for (const e of s.recentEvents) {
      // The log line itself stays canonical UTC (service/format.ts); only this
      // human reading of it is local.
      io.write(
        `  ${formatInstant(e.at, io.zone)}  ${e.event} (${e.source}${e.detail === undefined ? '' : `, ${e.detail}`})`,
      );
    }
  }
  io.write(`config: ${s.config}`);
}

const stripV = (t: string): string => t.replace(/^v/, '');

export async function cmdSelfUpdate(
  io: Io,
  deps: ServiceDeps,
  sel: UpdateSelection = {},
  format: Format = 'records',
): Promise<number> {
  if (basename(deps.binPath).startsWith('bun')) {
    throw new MimirError(
      'validation',
      'self-update needs an installed binary',
      'running from source — use git pull / bun run instead',
    );
  }
  const structured = format === 'json' || format === 'jsonl';
  const asset = assetName();
  let targetTag: string;
  let alreadyCurrent: boolean;
  if (sel.tag !== undefined) {
    targetTag = sel.tag.startsWith('v') ? sel.tag : `v${sel.tag}`;
    alreadyCurrent = stripV(targetTag) === deps.version;
  } else if (sel.next === true) {
    targetTag = await resolveNextChannelTag(deps.fetcher);
    alreadyCurrent = compareSemver(targetTag, deps.version) <= 0;
  } else {
    targetTag = await resolveLatestTag(deps.fetcher);
    alreadyCurrent = compareSemver(targetTag, deps.version) <= 0;
  }
  const target = stripV(targetTag);
  if (alreadyCurrent) {
    const result: SelfUpdateResult = {
      asset,
      from: deps.version,
      restartFailed: false,
      restarted: false,
      to: target,
      updated: false,
    };
    report(
      io,
      format,
      () => formatSelfUpdateJson(result, format === 'json'),
      () => ok(io, `already up to date (${deps.version})`),
    );
    return 0;
  }
  if (!structured) {
    io.write(`updating ${deps.version} ${arrow(io.plain)} ${target} (${asset})`);
  }
  const [body, sums] = await Promise.all([
    downloadAsset(targetTag, deps.fetcher),
    downloadSums(targetTag, deps.fetcher),
  ]);
  verifyChecksum(body, sums, asset);
  replaceBinary(deps.binPath, body);
  // The persisted event-log detail keeps a stable glyph (never presentation-gated);
  // the human echo below restyles the arrow for `--ascii`.
  const detail = `${deps.version} → ${target}`;
  // Log the replacement immediately — it already happened, regardless of what follows.
  appendEvent(deps.eventsFile, {
    detail,
    event: 'self-update',
    ok: true,
    source: 'self-update',
    version: target,
  });
  let restarted = false;
  let restartFailed = false;
  // Self-update replaces the binary and restarts the serve daemon; the snapshot
  // unit is a short-lived timer that always re-execs the new binary next fire.
  // The restart is a real-supervisor mutation, so it honors the same fence as
  // the service verbs (the binary itself is already replaced) — but a loaded
  // daemon left on stale code is never silent: restarted-or-surfaced is the
  // invariant, and the trust skip surfaces like a failed restart would.
  if (hasSupervisor(deps.platform) && (await deps.units.serve.supervisor.info()).loaded) {
    if (!mayDrive(deps.scope, deps.units.serve.label)) {
      warn(
        io,
        'service not restarted (untrusted build leaves the real daemon alone) — run `mimir service restart` (binary is updated)',
      );
    } else {
      try {
        await deps.units.serve.supervisor.restart();
        restarted = true;
        appendEvent(deps.eventsFile, {
          detail,
          event: 'restart',
          ok: true,
          source: 'self-update',
          version: target,
        });
      } catch (err) {
        restartFailed = true;
        const msg = err instanceof Error ? err.message : String(err);
        appendEvent(deps.eventsFile, {
          detail: `restart failed: ${msg}`,
          event: 'restart',
          ok: false,
          source: 'self-update',
          version: target,
        });
      }
    }
  }
  // A failed restart is always a stderr warning (the binary IS updated).
  if (restartFailed) {
    warn(io, 'service did not restart — run `mimir service restart` (binary is updated)');
  }
  const result: SelfUpdateResult = {
    asset,
    from: deps.version,
    restartFailed,
    restarted,
    to: target,
    updated: true,
  };
  report(
    io,
    format,
    () => formatSelfUpdateJson(result, format === 'json'),
    () =>
      ok(
        io,
        `updated ${deps.version} ${arrow(io.plain)} ${target}${restarted ? ' — service restarted' : ''}`,
      ),
  );
  return 0;
}

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
import { assertUsableStoreConfig } from '../store-backend';
import { consoleUrl, probeHost } from './address';
import { isUnparseableConfig, serveProblemWarning, writeServePort } from './config';
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

/**
 * One managed supervisor unit (MMR-146, MMR-54). The supervisor is bound to
 * `label`; `render` produces the unit file (a launchd plist or a systemd
 * .service) at install time for the port the install resolved; `logFile` is the
 * unit's stdout/stderr sink.
 */
export type ServiceUnit = {
  /** The installation-scoped supervisor label (./units); the fence checks it. */
  label: string;
  supervisor: Supervisor;
  /** The unit file; its presence on disk means "installed". */
  unitFile: string;
  logFile: string;
  render: (port: number) => string;
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
  /** GET /api/health at a host and port, undefined when nothing answers. */
  health: (host: string, port: number) => Promise<Health | undefined>;
  fetcher: Fetcher;
  /** The supervisor units this surface manages, keyed by name. */
  units: Record<UnitName, ServiceUnit>;
};

const SUBCOMMANDS = ['install', 'uninstall', 'start', 'stop', 'restart', 'status'] as const;
const UNITS = ['serve'] as const;

/** Validate the optional `[unit]` argument. The serve daemon is the only unit, so
 *  naming it and omitting it select the same thing; anything else is a usage fault. */
function checkUnitArg(arg: string | undefined): void {
  if (arg !== undefined && !isMember(arg, UNITS)) {
    throw usage(`service: unknown unit '${arg}' (expected: ${UNITS.join(' | ')})`);
  }
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

  checkUnitArg(positionals[2]);
  const unit = deps.units.serve;
  const emitActions = (results: ServiceActionResult[], human: () => void): void => {
    report(
      io,
      format,
      () => formatServiceActionsJson(results, format === 'json' ? 'json' : 'jsonl'),
      human,
    );
  };

  switch (sub) {
    case 'install': {
      // Validate --port up front (pure), but defer persisting it until render
      // has proven the install can proceed: a unit file that cannot be written
      // (a line break in a baked value) throws inside render(), and a mutated
      // config must not survive an aborted install.
      let port: number | undefined;
      if (values.port !== undefined) {
        port = Number(values.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw usage('service install: --port expects an integer in 1–65535');
        }
      }
      const config = deps.readConfig(deps.configFile);
      // The daemon builds its store from this config at boot; a `[store]` it
      // would refuse makes a unit that crash-loops, so refuse it here instead.
      // A file that is not TOML at all is the `--port` reset path below.
      if (!isUnparseableConfig(deps.configFile)) {
        assertUsableStoreConfig(config, deps.configFile);
      }
      const effectivePort = port ?? deps.portOverride ?? config.serve.port ?? deps.defaultPort;
      const content = unit.render(effectivePort);
      // A reset means the prior file was unparseable and got rewritten fresh
      // (lossy) — surface it rather than clobbering other sections silently.
      if (port !== undefined && writeServePort(deps.configFile, port).reset) {
        warn(io, `existing config at ${deps.configFile} was not valid TOML — rewrote it fresh`);
      }
      mkdirSync(dirname(unit.unitFile), { recursive: true });
      writeFileSync(unit.unitFile, content);
      // Neither supervisor creates a missing log directory; the unit would
      // fail to spawn before writing a line.
      mkdirSync(dirname(unit.logFile), { recursive: true });
      await unit.supervisor.install(unit.unitFile);
      log('install', true, `serve · port ${String(effectivePort)}`);
      const fileLabel = deps.platform === 'darwin' ? 'plist: ' : 'unit:  ';
      emitActions(
        [
          {
            action: 'install',
            ok: true,
            paths: { config: deps.configFile, log: unit.logFile, unitFile: unit.unitFile },
            port: effectivePort,
            unit: 'serve',
          },
        ],
        () => {
          ok(io, `serve installed — serving on ${consoleUrl(config.serve, effectivePort)}`);
          io.write(`  ${fileLabel} ${unit.unitFile}`);
          io.write(
            `  config: ${deps.configFile}${port === undefined ? ' (defaults; set with service install --port)' : ''}`,
          );
          io.write(`  log:    ${unit.logFile}`);
        },
      );
      return 0;
    }
    case 'uninstall': {
      // "Present" = on disk OR still loaded (a unit file can vanish while the
      // unit runs): a running daemon whose file is gone is torn down, never
      // reported as "nothing installed". Report and log a teardown exactly when
      // the unit was present — no phantom event for a never-installed unit.
      const present = existsSync(unit.unitFile) || (await unit.supervisor.info()).loaded;
      if (!present) {
        emitActions([], () => ok(io, 'nothing installed to uninstall'));
        return 0;
      }
      await unit.supervisor.uninstall();
      rmSync(unit.unitFile, { force: true });
      log('uninstall', true, 'serve');
      emitActions([{ action: 'uninstall', ok: true, unit: 'serve' }], () =>
        ok(io, 'serve uninstalled (config and logs kept)'),
      );
      return 0;
    }
    case 'start':
    case 'stop':
    case 'restart': {
      // A lifecycle verb acts only on an INSTALLED unit: a missing one is a
      // reported failure (nonzero, so a `mimir service restart && …` chain does
      // not proceed on a no-op), never a supervisor throw.
      if (!existsSync(unit.unitFile)) {
        emitActions([{ action: sub, ok: false, unit: 'serve' }], () =>
          warn(
            io,
            `serve: not installed — nothing to ${sub} (install with \`mimir service install\`)`,
          ),
        );
        return 1;
      }
      if (sub === 'start') {
        await unit.supervisor.start(unit.unitFile);
      } else if (sub === 'stop') {
        await unit.supervisor.stop();
      } else {
        await unit.supervisor.restart();
      }
      log(sub, true, 'serve');
      const pastTense = { restart: 'restarted', start: 'started', stop: 'stopped' } as const;
      emitActions([{ action: sub, ok: true, unit: 'serve' }], () =>
        ok(io, `serve ${pastTense[sub]}`),
      );
      return 0;
    }
    default: {
      // Unreachable — `sub` is validated against SUBCOMMANDS above (narrows to never here).
      throw usage(`service: unknown subcommand (expected: ${SUBCOMMANDS.join(' | ')})`);
    }
  }
}

/** Status of the serve unit: supervisor state, port, and health. */
async function statusReport(io: Io, deps: ServiceDeps, format: Format): Promise<number> {
  const config = deps.readConfig(deps.configFile).serve;
  // A config that couldn't be honored is always a stderr warning (warnings stay
  // off stdout, per the output contract); the JSON envelope also carries it.
  for (const problem of config.problems ?? []) {
    warn(io, `${serveProblemWarning(problem)} — ${deps.configFile}`);
  }

  const serveInfo = await deps.units.serve.supervisor.info();
  // Probe the port resolved from the installation-bound configuration, at the
  // address the daemon answers on from this machine.
  const port = deps.readInstalledPort() ?? deps.portOverride ?? config.port ?? deps.defaultPort;
  const healthRaw = await deps.health(probeHost(config.bind), port);
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
    configProblems: config.problems ?? [],
    consoleUrl: consoleUrl(config, port),
    health,
    loaded: serveInfo.loaded,
    log: deps.units.serve.logFile,
    pid: serveInfo.pid ?? null,
    port,
    running: serveInfo.running,
    unit: 'serve',
    unitFile: deps.units.serve.unitFile,
  };

  const status: ServiceStatusReport = {
    config: deps.configFile,
    recentEvents: recentEvents(deps.eventsFile, 5),
    units: [serve],
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
  if (u.consoleUrl !== undefined) {
    io.write(`  console ${u.consoleUrl}`);
  }
  if (u.health === null || u.health === undefined) {
    io.write(`  port ${String(u.port)}: no answer on /api/health`);
  } else {
    io.write(
      `  port ${String(u.port)}: running ${u.health.runningVersion} · on-disk ${u.health.onDiskVersion}${u.health.restartPending ? ' — restart pending' : ''}`,
    );
  }
  io.write(`  unit file ${u.unitFile} · log ${u.log}`);
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
  // Self-update replaces the binary and restarts the serve daemon. The restart is a real-supervisor mutation, so it honors the same fence as
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

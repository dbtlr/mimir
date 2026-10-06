/**
 * The service/self-update output layer (MMR-59). Mirrors core/format.ts: the
 * structured `json` / `jsonl` envelopes are a versioned promise (snake_case
 * wire names, never styled), kept separate from the camelCase result objects
 * the command layer computes. Human (`table`/`records`) rendering lives here
 * too so commands.ts returns data, not prose.
 */
import { emitWire } from '../core';
import type { ServiceEvent } from './events';

export type ServiceHealth = {
  runningVersion: string;
  onDiskVersion: string;
  restartPending: boolean;
};

export type ServicePaths = {
  unitFile: string;
  config: string;
  log: string;
};

/** Which supervisor unit a status/action concerns (MMR-146). The serve daemon
 *  is the only one; the wire keeps the name so the envelope stays a unit list. */
export type UnitName = 'serve';

/**
 * One unit's status. `loaded`/`running`/`pid`/`unitFile`/`log` are the
 * supervisor's view; `port`, `consoleUrl`, `health`, and `configProblems` are
 * the serve daemon's.
 */
export type UnitStatus = {
  unit: UnitName;
  loaded: boolean;
  running: boolean;
  pid: number | null;
  unitFile: string;
  log: string;
  port?: number;
  /** The address an operator opens the console at: `[serve] url`, else the bound one. */
  consoleUrl?: string;
  /** Every ignored `[serve]` key; empty when the config was honored whole. */
  configProblems?: string[];
  health?: ServiceHealth | null;
};

export type ServiceStatusReport = {
  units: UnitStatus[];
  config: string;
  recentEvents: ServiceEvent[];
};

export type ServiceAction = 'install' | 'uninstall' | 'start' | 'stop' | 'restart';

export type ServiceActionResult = {
  action: ServiceAction;
  unit: UnitName;
  ok: boolean;
  port?: number;
  paths?: ServicePaths;
};

export type SelfUpdateResult = {
  from: string;
  to: string;
  updated: boolean;
  restarted: boolean;
  restartFailed: boolean;
  asset: string;
};

/** Map a stored event to its wire object — explicit so the envelope is decoupled
 *  from the internal {@link ServiceEvent} type (detail omitted when absent). */
function eventToWire(e: ServiceEvent): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    at: e.at,
    event: e.event,
    ok: e.ok,
    source: e.source,
    version: e.version,
  };
  if (e.detail !== undefined) {
    wire.detail = e.detail;
  }
  return wire;
}

/** One unit's wire object — only the fields relevant to that unit are emitted. */
function unitToWire(u: UnitStatus): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    loaded: u.loaded,
    log: u.log,
    pid: u.pid,
    running: u.running,
    unit: u.unit,
    unit_file: u.unitFile,
  };
  if (u.port !== undefined) {
    wire.port = u.port;
  }
  if (u.consoleUrl !== undefined) {
    wire.console_url = u.consoleUrl;
  }
  if (u.configProblems !== undefined) {
    wire.config_problems = u.configProblems;
  }
  if (u.health !== undefined) {
    wire.health =
      u.health === null
        ? null
        : {
            on_disk_version: u.health.onDiskVersion,
            restart_pending: u.health.restartPending,
            running_version: u.health.runningVersion,
          };
  }
  return wire;
}

export function formatServiceStatusJson(report: ServiceStatusReport, pretty: boolean): string {
  return emitWire(
    {
      config: report.config,
      recent_events: report.recentEvents.map(eventToWire),
      units: report.units.map(unitToWire),
    },
    pretty,
  );
}

function actionToWire(result: ServiceActionResult): Record<string, unknown> {
  const wire: Record<string, unknown> = { action: result.action, ok: result.ok, unit: result.unit };
  if (result.port !== undefined) {
    wire.port = result.port;
  }
  if (result.paths !== undefined) {
    wire.paths = {
      config: result.paths.config,
      log: result.paths.log,
      unit_file: result.paths.unitFile,
    };
  }
  return wire;
}

/**
 * A verb can act on more than one unit (the default selector). `json` wraps the
 * results in `{ actions: [...] }`; `jsonl` emits one action object per line.
 */
export function formatServiceActionsJson(
  results: ServiceActionResult[],
  format: 'json' | 'jsonl',
): string {
  if (format === 'jsonl') {
    return results.map((r) => emitWire(actionToWire(r), false)).join('\n');
  }
  return emitWire({ actions: results.map(actionToWire) }, true);
}

export function formatSelfUpdateJson(result: SelfUpdateResult, pretty: boolean): string {
  return emitWire(
    {
      asset: result.asset,
      from: result.from,
      restart_failed: result.restartFailed,
      restarted: result.restarted,
      to: result.to,
      updated: result.updated,
    },
    pretty,
  );
}

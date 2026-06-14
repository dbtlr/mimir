/**
 * The service/self-update output layer (MMR-59). Mirrors core/format.ts: the
 * structured `json` / `jsonl` envelopes are a versioned promise (snake_case
 * wire names, never styled), kept separate from the camelCase result objects
 * the command layer computes. Human (`table`/`records`) rendering lives here
 * too so commands.ts returns data, not prose.
 */
import { emitWire } from "../core";
import type { ServiceEvent } from "./events";

export interface ServiceHealth {
  runningVersion: string;
  onDiskVersion: string;
  restartPending: boolean;
}

export interface ServicePaths {
  plist: string;
  config: string;
  log: string;
}

export interface ServiceStatus {
  loaded: boolean;
  running: boolean;
  pid: number | null;
  port: number;
  configProblem: string | null;
  health: ServiceHealth | null;
  recentEvents: ServiceEvent[];
  paths: ServicePaths;
}

export type ServiceAction = "install" | "uninstall" | "start" | "stop" | "restart";

export interface ServiceActionResult {
  action: ServiceAction;
  ok: boolean;
  port?: number;
  paths?: ServicePaths;
}

export interface SelfUpdateResult {
  from: string;
  to: string;
  updated: boolean;
  restarted: boolean;
  restartFailed: boolean;
  asset: string;
}

/** Map a stored event to its wire object — explicit so the envelope is decoupled
 *  from the internal {@link ServiceEvent} type (detail omitted when absent). */
function eventToWire(e: ServiceEvent): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    at: e.at,
    event: e.event,
    source: e.source,
    version: e.version,
    ok: e.ok,
  };
  if (e.detail !== undefined) wire.detail = e.detail;
  return wire;
}

export function formatServiceStatusJson(status: ServiceStatus, pretty: boolean): string {
  return emitWire(
    {
      loaded: status.loaded,
      running: status.running,
      pid: status.pid,
      port: status.port,
      config_problem: status.configProblem,
      health:
        status.health === null
          ? null
          : {
              running_version: status.health.runningVersion,
              on_disk_version: status.health.onDiskVersion,
              restart_pending: status.health.restartPending,
            },
      recent_events: status.recentEvents.map(eventToWire),
      paths: status.paths,
    },
    pretty,
  );
}

export function formatServiceActionJson(result: ServiceActionResult, pretty: boolean): string {
  const wire: Record<string, unknown> = { action: result.action, ok: result.ok };
  if (result.port !== undefined) wire.port = result.port;
  if (result.paths !== undefined) wire.paths = result.paths;
  return emitWire(wire, pretty);
}

export function formatSelfUpdateJson(result: SelfUpdateResult, pretty: boolean): string {
  return emitWire(
    {
      from: result.from,
      to: result.to,
      updated: result.updated,
      restarted: result.restarted,
      restart_failed: result.restartFailed,
      asset: result.asset,
    },
    pretty,
  );
}

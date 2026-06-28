/**
 * The service command layer (MMR-47): verbs over the supervisor seam, the
 * config, the plist, and the event log. All effects flow through ServiceDeps
 * so tests drive the layer with fakes; main wires the real edges.
 *
 * Output conforms to the CLI contract (MMR-59): each verb computes a typed
 * result, then renders `json`/`jsonl` (structured envelope, ./format) or
 * human prose. The picked format is supplied by the dispatcher (pickFormat's
 * "report" kind); the param defaults to human for direct/test callers.
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import { usage } from '../cli/errors';
import type { Format, Io } from '../cli/render';
import { ok, warn } from '../cli/render';
import { MimirError } from '../core';
import { readServeConfig, writeServePort } from './config';
import { SERVE_LOG_FILE, appendEvent, recentEvents } from './events';
import type { ServiceEventName } from './events';
import { formatSelfUpdateJson, formatServiceActionJson, formatServiceStatusJson } from './format';
import type { SelfUpdateResult, ServiceActionResult, ServiceHealth, ServiceStatus } from './format';
import type { Supervisor } from './launchd';
import { plistFor } from './plist';
import {
  assetName,
  compareSemver,
  downloadAsset,
  downloadSums,
  replaceBinary,
  resolveLatestPrereleaseTag,
  resolveLatestTag,
  verifyChecksum,
} from './self-update';
import type { Fetcher } from './self-update';

export interface Health {
  status: string;
  version: string;
}

export interface UpdateSelection {
  /** Include prereleases — resolve the newest build on the next-version line (--next). */
  next?: boolean;
  /** Install this exact tag (official or prerelease); wins over `next` (--tag). */
  tag?: string;
}

export interface ServiceDeps {
  supervisor: Supervisor;
  platform: NodeJS.Platform;
  /** The binary the plist points at / self-update replaces (process.execPath). */
  binPath: string;
  /** This invocation's version (build-injected tag, or package.json) — the on-disk version by definition. */
  version: string;
  configFile: string;
  plistFile: string;
  eventsFile: string;
  /** GET /api/health on a port, undefined when nothing answers. */
  health: (port: number) => Promise<Health | undefined>;
  fetcher: Fetcher;
  /** MIMIR_DB at invocation time, baked into the plist iff set. */
  dbPath: string | undefined;
}

/** Default `serve` port — MIMIR on a phone keypad. */
export const DEFAULT_PORT = 64647;

const SUBCOMMANDS = ['install', 'uninstall', 'start', 'stop', 'restart', 'status'] as const;
type Sub = (typeof SUBCOMMANDS)[number];

function requireDarwin(deps: ServiceDeps): void {
  if (deps.platform !== 'darwin') {
    throw new MimirError(
      'validation',
      'mimir service requires macOS (launchd)',
      'run `mimir serve --no-hunt` under your supervisor of choice; systemd support is planned',
    );
  }
}

/** Render a service/self-update result: structured envelope, else human prose. */
function report(io: Io, format: Format, json: () => string, human: () => void): void {
  if (format === 'json' || format === 'jsonl') io.write(json());
  else human();
}

export async function cmdService(
  positionals: string[],
  values: { port?: string },
  io: Io,
  deps: ServiceDeps,
  format: Format = 'records',
): Promise<number> {
  const sub = positionals[1];
  if (sub === undefined || !(SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw usage(`service: unknown subcommand (expected: ${SUBCOMMANDS.join(' | ')})`);
  }
  requireDarwin(deps);

  const log = (event: ServiceEventName, okFlag: boolean, detail?: string): void => {
    appendEvent(deps.eventsFile, {
      event,
      source: 'cli',
      version: deps.version,
      ok: okFlag,
      ...(detail === undefined ? {} : { detail }),
    });
  };

  const paths = { plist: deps.plistFile, config: deps.configFile, log: SERVE_LOG_FILE };
  const action = (result: ServiceActionResult, human: () => void): void => {
    report(io, format, () => formatServiceActionJson(result, format === 'json'), human);
  };

  switch (sub as Sub) {
    case 'install': {
      let port: number | undefined;
      if (values.port !== undefined) {
        port = Number(values.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw usage('service install: --port expects an integer in 1–65535');
        }
        writeServePort(deps.configFile, port);
      }
      writeFileSync(deps.plistFile, plistFor(deps.binPath, { dbPath: deps.dbPath }));
      await deps.supervisor.install(deps.plistFile);
      const effective = port ?? readServeConfig(deps.configFile).port ?? DEFAULT_PORT;
      log('install', true, `port ${String(effective)}`);
      action({ action: 'install', ok: true, port: effective, paths }, () => {
        ok(io, `service installed — serving on http://127.0.0.1:${String(effective)}`);
        io.write(`  plist:  ${deps.plistFile}`);
        io.write(
          `  config: ${deps.configFile}${port === undefined ? ' (defaults; set with service install --port)' : ''}`,
        );
        io.write(`  log:    ${SERVE_LOG_FILE}`);
      });
      return 0;
    }
    case 'uninstall': {
      await deps.supervisor.uninstall();
      if (existsSync(deps.plistFile)) rmSync(deps.plistFile);
      log('uninstall', true);
      action({ action: 'uninstall', ok: true }, () =>
        ok(io, 'service uninstalled (config and logs kept)'),
      );
      return 0;
    }
    case 'start': {
      await deps.supervisor.start(deps.plistFile);
      log('start', true);
      action({ action: 'start', ok: true }, () => ok(io, 'service started'));
      return 0;
    }
    case 'stop': {
      await deps.supervisor.stop();
      log('stop', true);
      action({ action: 'stop', ok: true }, () =>
        ok(io, 'service stopped (start again with `mimir service start`)'),
      );
      return 0;
    }
    case 'restart': {
      await deps.supervisor.restart();
      log('restart', true);
      action({ action: 'restart', ok: true }, () => ok(io, 'service restarted'));
      return 0;
    }
    case 'status': {
      return await statusReport(io, deps, format);
    }
  }
}

async function statusReport(io: Io, deps: ServiceDeps, format: Format): Promise<number> {
  const info = await deps.supervisor.info();
  const config = readServeConfig(deps.configFile);
  // A config that couldn't be honored is always a stderr warning (warnings stay
  // off stdout, per the output contract); the JSON envelope also carries it.
  if (config.problem !== undefined) {
    warn(io, `config ignored (${config.problem}) — ${deps.configFile}`);
  }
  const port = config.port ?? DEFAULT_PORT;
  const healthRaw = await deps.health(port);
  const health: ServiceHealth | null =
    healthRaw === undefined
      ? null
      : {
          runningVersion: healthRaw.version,
          onDiskVersion: deps.version,
          restartPending: compareSemver(healthRaw.version, deps.version) !== 0,
        };
  const status: ServiceStatus = {
    loaded: info.loaded,
    running: info.running,
    pid: info.pid ?? null,
    port,
    configProblem: config.problem ?? null,
    health,
    recentEvents: recentEvents(deps.eventsFile, 5),
    paths: { plist: deps.plistFile, config: deps.configFile, log: SERVE_LOG_FILE },
  };
  report(
    io,
    format,
    () => formatServiceStatusJson(status, format === 'json'),
    () => renderStatusHuman(status, io),
  );
  return 0;
}

function renderStatusHuman(s: ServiceStatus, io: Io): void {
  if (!s.loaded) {
    io.write('service: not loaded (install with `mimir service install`)');
  } else {
    io.write(
      `service: loaded, ${s.running ? `running (pid ${String(s.pid ?? '?')})` : 'not running'}`,
    );
  }
  if (s.health === null) {
    io.write(`port ${String(s.port)}: no answer on /api/health`);
  } else {
    io.write(
      `port ${String(s.port)}: running ${s.health.runningVersion} · on-disk ${s.health.onDiskVersion}${s.health.restartPending ? ' — restart pending' : ''}`,
    );
  }
  if (s.recentEvents.length > 0) {
    io.write('recent events:');
    for (const e of s.recentEvents) {
      io.write(
        `  ${e.at}  ${e.event} (${e.source}${e.detail === undefined ? '' : `, ${e.detail}`})`,
      );
    }
  }
  io.write(`paths: plist ${s.paths.plist} · config ${s.paths.config} · log ${SERVE_LOG_FILE}`);
}

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
  const stripV = (t: string): string => t.replace(/^v/, '');
  let targetTag: string;
  let alreadyCurrent: boolean;
  if (sel.tag !== undefined) {
    targetTag = sel.tag.startsWith('v') ? sel.tag : `v${sel.tag}`;
    alreadyCurrent = stripV(targetTag) === deps.version;
  } else if (sel.next === true) {
    targetTag = await resolveLatestPrereleaseTag(deps.fetcher);
    alreadyCurrent = stripV(targetTag) === deps.version;
  } else {
    targetTag = await resolveLatestTag(deps.fetcher);
    alreadyCurrent = compareSemver(targetTag, deps.version) <= 0;
  }
  const target = stripV(targetTag);
  if (alreadyCurrent) {
    const result: SelfUpdateResult = {
      from: deps.version,
      to: target,
      updated: false,
      restarted: false,
      restartFailed: false,
      asset,
    };
    report(
      io,
      format,
      () => formatSelfUpdateJson(result, format === 'json'),
      () => ok(io, `already up to date (${deps.version})`),
    );
    return 0;
  }
  if (!structured) io.write(`updating ${deps.version} → ${target} (${asset})`);
  const [body, sums] = await Promise.all([
    downloadAsset(targetTag, deps.fetcher),
    downloadSums(targetTag, deps.fetcher),
  ]);
  verifyChecksum(body, sums, asset);
  replaceBinary(deps.binPath, body);
  const detail = `${deps.version} → ${target}`;
  // Log the replacement immediately — it already happened, regardless of what follows.
  appendEvent(deps.eventsFile, {
    event: 'self-update',
    source: 'self-update',
    version: target,
    ok: true,
    detail,
  });
  let restarted = false;
  let restartFailed = false;
  if (deps.platform === 'darwin' && (await deps.supervisor.info()).loaded) {
    try {
      await deps.supervisor.restart();
      restarted = true;
      appendEvent(deps.eventsFile, {
        event: 'restart',
        source: 'self-update',
        version: target,
        ok: true,
        detail,
      });
    } catch (err) {
      restartFailed = true;
      const msg = err instanceof Error ? err.message : String(err);
      appendEvent(deps.eventsFile, {
        event: 'restart',
        source: 'self-update',
        version: target,
        ok: false,
        detail: `restart failed: ${msg}`,
      });
    }
  }
  // A failed restart is always a stderr warning (the binary IS updated).
  if (restartFailed) {
    warn(io, 'service did not restart — run `mimir service restart` (binary is updated)');
  }
  const result: SelfUpdateResult = {
    from: deps.version,
    to: target,
    updated: true,
    restarted,
    restartFailed,
    asset,
  };
  report(
    io,
    format,
    () => formatSelfUpdateJson(result, format === 'json'),
    () => ok(io, `updated ${detail}${restarted ? ' — service restarted' : ''}`),
  );
  return 0;
}

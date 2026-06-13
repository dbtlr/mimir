/**
 * The service command layer (MMR-47): verbs over the supervisor seam, the
 * config, the plist, and the event log. All effects flow through ServiceDeps
 * so tests drive the layer with fakes; main wires the real edges.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { MimirError } from "../core";
import type { Io } from "../cli/render";
import { usage } from "../cli/errors";
import { readServeConfig, writeServePort } from "./config";
import { SERVE_LOG_FILE, appendEvent, recentEvents } from "./events";
import type { ServiceEventName } from "./events";
import { plistFor } from "./plist";
import type { Supervisor } from "./launchd";
import {
  type Fetcher,
  assetName,
  compareSemver,
  downloadAsset,
  downloadSums,
  replaceBinary,
  resolveLatestTag,
  verifyChecksum,
} from "./self-update";

export interface Health {
  status: string;
  version: string;
}

export interface ServiceDeps {
  supervisor: Supervisor;
  platform: NodeJS.Platform;
  /** The binary the plist points at / self-update replaces (process.execPath). */
  binPath: string;
  /** pkg.version of this invocation — the on-disk version by definition. */
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

const SUBCOMMANDS = ["install", "uninstall", "start", "stop", "restart", "status"] as const;
type Sub = (typeof SUBCOMMANDS)[number];

function requireDarwin(deps: ServiceDeps): void {
  if (deps.platform !== "darwin") {
    throw new MimirError(
      "validation",
      "mimir service requires macOS (launchd)",
      "run `mimir serve --no-hunt` under your supervisor of choice; systemd support is planned",
    );
  }
}

function ok(io: Io, text: string): void {
  const glyph = io.plain ? "[ok]" : "\x1b[32m✓\x1b[0m";
  io.write(`${glyph} ${text}`);
}

export async function cmdService(
  positionals: string[],
  values: { port?: string },
  io: Io,
  deps: ServiceDeps,
): Promise<number> {
  const sub = positionals[1];
  if (sub === undefined || !(SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw usage(`service: unknown subcommand (expected: ${SUBCOMMANDS.join(" | ")})`);
  }
  requireDarwin(deps);

  const log = (event: ServiceEventName, okFlag: boolean, detail?: string): void => {
    appendEvent(deps.eventsFile, {
      event,
      source: "cli",
      version: deps.version,
      ok: okFlag,
      ...(detail === undefined ? {} : { detail }),
    });
  };

  switch (sub as Sub) {
    case "install": {
      let port: number | undefined;
      if (values.port !== undefined) {
        port = Number(values.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw usage("service install: --port expects an integer in 1–65535");
        }
        writeServePort(deps.configFile, port);
      }
      writeFileSync(deps.plistFile, plistFor(deps.binPath, { dbPath: deps.dbPath }));
      await deps.supervisor.install(deps.plistFile);
      const effective = port ?? readServeConfig(deps.configFile).port ?? DEFAULT_PORT;
      log("install", true, `port ${String(effective)}`);
      ok(io, `service installed — serving on http://127.0.0.1:${String(effective)}`);
      io.write(`  plist:  ${deps.plistFile}`);
      io.write(
        `  config: ${deps.configFile}${port === undefined ? " (defaults; set with service install --port)" : ""}`,
      );
      io.write(`  log:    ${SERVE_LOG_FILE}`);
      return 0;
    }
    case "uninstall":
      await deps.supervisor.uninstall();
      if (existsSync(deps.plistFile)) rmSync(deps.plistFile);
      log("uninstall", true);
      ok(io, "service uninstalled (config and logs kept)");
      return 0;
    case "start":
      await deps.supervisor.start(deps.plistFile);
      log("start", true);
      ok(io, "service started");
      return 0;
    case "stop":
      await deps.supervisor.stop();
      log("stop", true);
      ok(io, "service stopped (start again with `mimir service start`)");
      return 0;
    case "restart":
      await deps.supervisor.restart();
      log("restart", true);
      ok(io, "service restarted");
      return 0;
    case "status":
      return await statusReport(io, deps);
  }
}

async function statusReport(io: Io, deps: ServiceDeps): Promise<number> {
  const info = await deps.supervisor.info();
  const config = readServeConfig(deps.configFile);
  if (config.problem !== undefined) {
    const warn = io.plain ? "[warn]" : "\x1b[33m⚠\x1b[0m";
    io.error(`${warn} config ignored (${config.problem}) — ${deps.configFile}`);
  }
  const port = config.port ?? DEFAULT_PORT;
  if (!info.loaded) {
    io.write("service: not loaded (install with `mimir service install`)");
  } else {
    io.write(
      `service: loaded, ${info.running ? `running (pid ${String(info.pid ?? "?")})` : "not running"}`,
    );
  }
  const health = await deps.health(port);
  if (health === undefined) {
    io.write(`port ${String(port)}: no answer on /api/health`);
  } else {
    const pending = compareSemver(health.version, deps.version) !== 0;
    io.write(
      `port ${String(port)}: running ${health.version} · on-disk ${deps.version}${pending ? " — restart pending" : ""}`,
    );
  }
  const events = recentEvents(deps.eventsFile, 5);
  if (events.length > 0) {
    io.write("recent events:");
    for (const e of events) {
      io.write(
        `  ${e.at}  ${e.event} (${e.source}${e.detail === undefined ? "" : `, ${e.detail}`})`,
      );
    }
  }
  io.write(`paths: plist ${deps.plistFile} · config ${deps.configFile} · log ${SERVE_LOG_FILE}`);
  return 0;
}

export async function cmdSelfUpdate(io: Io, deps: ServiceDeps): Promise<number> {
  if (basename(deps.binPath).startsWith("bun")) {
    throw new MimirError(
      "validation",
      "self-update needs an installed binary",
      "running from source — use git pull / bun run instead",
    );
  }
  const tag = await resolveLatestTag(deps.fetcher);
  if (compareSemver(tag, deps.version) <= 0) {
    ok(io, `already up to date (${deps.version})`);
    return 0;
  }
  io.write(`updating ${deps.version} → ${tag.replace(/^v/, "")} (${assetName()})`);
  const [body, sums] = await Promise.all([
    downloadAsset(tag, deps.fetcher),
    downloadSums(tag, deps.fetcher),
  ]);
  verifyChecksum(body, sums, assetName());
  replaceBinary(deps.binPath, body);
  const newVersion = tag.replace(/^v/, "");
  const detail = `${deps.version} → ${newVersion}`;
  // Log the replacement immediately — it already happened, regardless of what follows.
  appendEvent(deps.eventsFile, {
    event: "self-update",
    source: "self-update",
    version: newVersion,
    ok: true,
    detail,
  });
  let restarted = false;
  let restartFailed = false;
  if (deps.platform === "darwin" && (await deps.supervisor.info()).loaded) {
    try {
      await deps.supervisor.restart();
      restarted = true;
      appendEvent(deps.eventsFile, {
        event: "restart",
        source: "self-update",
        version: newVersion,
        ok: true,
        detail,
      });
    } catch (err) {
      restartFailed = true;
      const msg = err instanceof Error ? err.message : String(err);
      appendEvent(deps.eventsFile, {
        event: "restart",
        source: "self-update",
        version: newVersion,
        ok: false,
        detail: `restart failed: ${msg}`,
      });
    }
  }
  ok(io, `updated ${detail}${restarted ? " — service restarted" : ""}`);
  if (restartFailed) {
    const warn = io.plain ? "[warn]" : "\x1b[33m⚠\x1b[0m";
    io.error(`${warn} service did not restart — run \`mimir service restart\` (binary is updated)`);
  }
  return 0;
}

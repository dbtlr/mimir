/**
 * Entry point + composition root. Unlike the transport layers, `main` may wire
 * the store and transports together. It builds the store, then dispatches:
 *
 *   <verb> [args]   read/write commands → CLI transport
 *   mcp             the agent envelope over stdio → MCP transport
 *   --help, -h      help (handled by the CLI)
 *
 * `serve`/`mcp`/`version` are machinery loners (ADR 0024) intercepted here,
 * ahead of `runCli`, because each has a real effect (start a server, hang on
 * stdio, print a bare version) a lazily-acquired store can't gate the way it
 * gates every other verb (MMR-39). `-h`/`--help` on any of the three is the
 * one exception: it's recognized here and falls through to `runCli` instead,
 * which renders that verb's `COMMAND_HELP` descriptor without ever touching
 * the store (MMR-294).
 */
import { findBinding, runCli } from './cli';
import type { Io } from './cli';
import { systemTimeZone } from './core';
import type { Store } from './core';
import { MimirError } from './core/errors';
import { openPostgres } from './core/store-postgres/index';
import { warnConfigPermissions, withConfigFindings } from './doctor/config-permissions';
import type { DoctorBackend } from './doctor/contract';
import { DEFAULT_PORT, IS_PRODUCTION, envPort, supervisorScope } from './env';
import { createServer } from './http';
import { runInstallationCommand } from './installation/command';
import { INSTALLATION_PROTOCOL_RESPONSE } from './installation/protocol';
import { serveStdio } from './mcp';
import { parseServeArgs } from './serve-args';
import {
  EVENTS_FILE,
  LaunchdSupervisor,
  SERVE_LOG_FILE,
  SystemdSupervisor,
  bunExec,
  configPath,
  manualFetch,
  plistFor,
  plistPathFor,
  readRuntimeConfig,
  readServePlistPort,
  readServeUnitPort,
  parseHealth,
  serveUnitFor,
  systemdUnitPathFor,
  unitLabels,
} from './service';
import type { Health, ServeUnitOptions, ServiceDeps, SupervisorScope } from './service';
import { buildStore } from './store-backend';
import type { BuiltStore } from './store-backend';
import { openInstallationSqlite } from './store-sqlite-backend';
import type { StoreDeps } from './store/commands';
import { VERSION } from './version';

const line = (stream: NodeJS.WriteStream) => (text: string) => {
  stream.write(text.endsWith('\n') ? text : `${text}\n`);
};

function stdoutIo(): Io {
  const isTTY = process.stdout.isTTY;
  // A downstream reader that closes early (`mimir … | head`) breaks the pipe;
  // the stream then emits EPIPE asynchronously, which is fatal if unhandled.
  // Exit quietly like a well-behaved Unix filter instead of surfacing a stack
  // trace — matters for any verb that writes line-by-line (e.g. `service
  // status`) rather than in one shot.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') {
        process.exit(0);
      }
      throw err;
    });
  }
  return {
    error: line(process.stderr),
    isTTY,
    plain: process.env.NO_COLOR !== undefined || !isTTY,
    write: line(process.stdout),
    zone: systemTimeZone(),
  };
}

/** True when `-h`/`--help` is present — the one case a machinery loner (serve/mcp/version) doesn't intercept, falling through to `runCli`'s help instead (MMR-294). */
function wantsHelp(args: string[]): boolean {
  return args.includes('-h') || args.includes('--help');
}

/** The serve unit's baked environment: only a non-live installation bakes its
 *  port; a live one reads it from its bound configuration at startup. */
function serveOptions(port: number): ServeUnitOptions {
  return { port: IS_PRODUCTION ? undefined : port };
}

/**
 * The serve unit for this platform's supervisor, under this installation's own
 * unit name (service/units): a launchd plist on macOS, a systemd user unit on
 * Linux. The non-live port bake is shared; only the file shape and supervisor
 * differ.
 */
function realServiceUnits(
  binPath: string,
  scope: SupervisorScope,
): { units: ServiceDeps['units']; readInstalledPort: () => number | undefined } {
  const labels = unitLabels(scope);
  if (process.platform === 'linux') {
    const serveFile = systemdUnitPathFor(`${labels.serve}.service`);
    return {
      readInstalledPort: () => readServeUnitPort(serveFile),
      units: {
        serve: {
          label: labels.serve,
          logFile: SERVE_LOG_FILE,
          render: (port) => serveUnitFor(labels.serve, binPath, serveOptions(port)),
          supervisor: new SystemdSupervisor(bunExec, serveFile),
          unitFile: serveFile,
        },
      },
    };
  }

  const uid = process.getuid?.() ?? 501;
  const servePlist = plistPathFor(labels.serve);
  return {
    readInstalledPort: () => readServePlistPort(servePlist),
    units: {
      serve: {
        label: labels.serve,
        logFile: SERVE_LOG_FILE,
        render: (port) => plistFor(labels.serve, binPath, serveOptions(port)),
        supervisor: new LaunchdSupervisor(bunExec, uid, labels.serve),
        unitFile: servePlist,
      },
    },
  };
}

function realServiceDeps(): ServiceDeps {
  const binPath = process.execPath;
  const explicitPort = envPort();
  const scope = supervisorScope();
  return {
    binPath,
    configFile: configPath(),
    defaultPort: DEFAULT_PORT,
    eventsFile: EVENTS_FILE,
    fetcher: manualFetch,
    health: async (port: number): Promise<Health | undefined> => {
      try {
        const res = await fetch(`http://127.0.0.1:${String(port)}/api/health`, {
          signal: AbortSignal.timeout(1500),
        });
        if (!res.ok) {
          return undefined;
        }
        return parseHealth(await res.json());
      } catch {
        return undefined;
      }
    },
    platform: process.platform,
    portOverride: !IS_PRODUCTION && typeof explicitPort === 'number' ? explicitPort : undefined,
    readConfig: readRuntimeConfig,
    // Only a registered installation drives the host supervisor, and only its own units.
    scope,
    ...realServiceUnits(binPath, scope),
    version: VERSION,
  };
}

/** The `store` machinery edges: the config this install reads, the pool it
 * opens, and stdin for `store import -`. Deliberately NOT the built store —
 * `store upgrade` runs before the schema gate would let a store exist. */
function realStoreDeps(): StoreDeps {
  return {
    openPostgres,
    openSqlite: () => openInstallationSqlite(),
    readConfig: readRuntimeConfig,
    readStdin: () => Bun.stdin.text(),
  };
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === 'installation-protocol') {
    console.log(INSTALLATION_PROTOCOL_RESPONSE);
    return 0;
  }
  if (command === 'installation-install') {
    try {
      runInstallationCommand(argv.slice(1));
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }

  if (command === '--version') {
    console.log(VERSION);
    return 0;
  }

  if (command === 'version' && !wantsHelp(argv.slice(1))) {
    console.log(VERSION);
    return 0;
  }

  if (command === 'serve' && !wantsHelp(argv.slice(1))) {
    const parsed = parseServeArgs(argv.slice(1));
    if ('error' in parsed) {
      console.error(`✗ serve: ${parsed.error}`);
      return 2;
    }
    const { noHunt, port: flagPort, storeFile } = parsed;
    // Declared port wins: flag > MIMIR_PORT env > production-only global config
    // > built-in default (MMR-47/MMR-117/MMR-325). A malformed MIMIR_PORT is
    // ignored with a warning.
    const overridePort = envPort();
    if (overridePort === null) {
      console.error(
        `⚠ serve: MIMIR_PORT ignored (not an integer in 1–65535) — ${String(process.env.MIMIR_PORT)}`,
      );
    }
    const config = readRuntimeConfig().serve;
    if (config.problem !== undefined) {
      console.error(`⚠ serve: config ignored (${config.problem}) — ${configPath()}`);
    }
    const port = flagPort ?? overridePort ?? config.port ?? DEFAULT_PORT;
    // Long-running: the server keeps the process alive; loopback-only by
    // design (ADR 0012 — the proxy is the boundary). Signals stop it cleanly.
    // `/api/doctor` serves the backend's read-only record-health facet (MMR-185).
    let built: BuiltStore;
    try {
      built = await buildStore(undefined, { file: storeFile });
    } catch (err) {
      // A refusal (an unusable [store], a missing --store file) is the
      // operator's to fix: name it and its remedy rather than a stack trace.
      if (err instanceof MimirError) {
        console.error(`✗ serve: ${err.message}`);
        if (err.hint !== undefined) {
          console.error(`note: ${err.hint}`);
        }
        return 1;
      }
      throw err;
    }
    const doctor = built.doctor.facet;
    let server: ReturnType<typeof createServer>;
    try {
      server = createServer(built.store, { doctor, hunt: !noHunt, port, version: VERSION });
    } catch (err) {
      await built.close();
      if (err instanceof Error && 'code' in err && err.code === 'EADDRINUSE') {
        console.error(`✗ serve: ${err.message}`);
        console.error(
          noHunt
            ? 'note: --no-hunt is set — free the port, pass a different --port, or change [serve] port in the config'
            : 'note: pass --port to start the hunt elsewhere',
        );
        return 1;
      }
      throw err;
    }
    console.log(`mimir serve — listening on http://127.0.0.1:${String(server.port)}`);
    if (server.port !== port) {
      console.log(`note: port ${String(port)} was taken — hunted up to ${String(server.port)}`);
    }
    const stop = async (): Promise<void> => {
      // Release resources even if a teardown step throws — a stuck stop must
      // still close the store and exit for a supervisor to restart.
      try {
        await server.stop();
      } finally {
        await built.close();
        process.exit(0);
      }
    };
    process.on('SIGINT', () => void stop());
    process.on('SIGTERM', () => void stop());
    return 0;
  }

  if (command === 'mcp' && !wantsHelp(argv.slice(1))) {
    // Long-running: connect and let the stdio transport keep the process alive.
    // The MCP rendering honors the same Project Binding (ADR 0011), resolved
    // from the server's spawn cwd.
    const built = await buildStore();
    try {
      await serveStdio(built.store, VERSION, findBinding(process.cwd()));
    } finally {
      // serveStdio resolves when the stdio transport closes; close releases the
      // store's connections so the process can exit.
      await built.close();
    }
    return 0;
  }

  // Read and write commands go through the CLI. The store is acquired lazily
  // (MMR-39): a verb that touches data asks for it, opening the store on first
  // ask; help, usage errors, and `skill install` never ask, so a bare
  // `mimir` / `mimir --help` never touches the store. main holds no verb list.
  let built: BuiltStore | undefined;
  const getBuilt = async (): Promise<BuiltStore> => {
    built ??= await buildStore();
    return built;
  };
  const getStore = async (): Promise<Store> => (await getBuilt()).store;
  const cliDoctor = async (): Promise<DoctorBackend> => (await getBuilt()).doctor;
  try {
    // Project Binding (ADR 0011): the nearest .mimir.toml supplies the
    // default -s scope; resolved here so the CLI itself never reads cwd.
    return await runCli(argv, getStore, stdoutIo(), {
      cwd: process.cwd(),
      doctor: {
        // Every call first forces the lazy store build.
        diagnose: async (scope) => {
          try {
            return withConfigFindings(
              await (await cliDoctor()).diagnose(scope),
              scope,
              configPath(),
            );
          } catch (err) {
            // The permission check needs only the config file, so a store that
            // cannot be built or read (down, bad credentials) must not hide it.
            warnConfigPermissions(scope, configPath(), line(process.stderr));
            throw err;
          }
        },
        facet: async (scope) => (await cliDoctor()).facet(scope),
      },
      scope: findBinding(process.cwd()),
      service: realServiceDeps(),
      store: realStoreDeps(),
    });
  } finally {
    // close() releases the store's connections so the process can exit.
    await built?.close();
  }
}

process.exitCode = await main(process.argv.slice(2));

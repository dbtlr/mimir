/**
 * Entry point + composition root. Unlike the transport layers, `main` may wire
 * the store and transports together. It builds the store (converging the Norn
 * vault, ADR 0016), then dispatches:
 *
 *   <verb> [args]   read/write commands → CLI transport
 *   mcp             the agent envelope over stdio → MCP transport
 *   --help, -h      help (handled by the CLI)
 */
import { parsePort } from '@mimir/helpers';

import { findBinding, runCli } from './cli';
import type { Io } from './cli';
import type { Store } from './core';
import type { DoctorFacet } from './doctor/facet';
import { computeDoctorFacet } from './doctor/serve';
import type { DoctorFacetDeps } from './doctor/serve';
import { DEFAULT_PORT, IS_PRODUCTION, envFlag, envPort } from './env';
import { createServer } from './http';
import { serveStdio } from './mcp';
import {
  DEFAULT_SNAPSHOT_INTERVAL_SECONDS,
  EVENTS_FILE,
  LaunchdSupervisor,
  SERVE_LABEL,
  SERVE_LOG_FILE,
  SNAPSHOT_LABEL,
  SNAPSHOT_LOG_FILE,
  bunExec,
  configPath,
  manualFetch,
  plistFor,
  plistForSnapshot,
  plistPathFor,
  readConfig,
  readServeConfig,
  readVaultConfig,
  serveInstallEnv,
} from './service';
import type { Health, ServiceDeps } from './service';
import { buildStore } from './store-backend';
import type { BuiltStore } from './store-backend';
import { resolveVault } from './vault';
import type { VaultDeps } from './vault/commands';
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
  };
}

/**
 * Parse `serve`'s `--port` flag.
 * - `undefined`: flag absent — caller uses config or built-in default.
 * - `null`: flag present but unusable (a usage fault).
 * - `number`: the parsed port.
 */
function servePort(args: string[]): number | null | undefined {
  const at = args.indexOf('--port');
  if (at === -1) {
    return undefined;
  }
  const raw = args[at + 1];
  if (raw === undefined) {
    return null;
  }
  return parsePort(raw);
}

function realServiceDeps(): ServiceDeps {
  const binPath = process.execPath;
  const uid = process.getuid?.() ?? 501;
  return {
    // Only a production build manages the host launchd by default; a dev/
    // from-source run must opt in explicitly (the MMR-147 fence).
    allowRealSupervisor: IS_PRODUCTION || envFlag(process.env.MIMIR_ALLOW_REAL_SERVICE),
    binPath,
    configFile: configPath(),
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
        // Untrusted HTTP boundary (own /api/health) — schema validation is the planned follow-up.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        return (await res.json()) as Health;
      } catch {
        return undefined;
      }
    },
    platform: process.platform,
    units: {
      serve: {
        logFile: SERVE_LOG_FILE,
        plistFile: plistPathFor(SERVE_LABEL),
        render: () => {
          // The daemon shells out to norn and reads the vault (ADR 0018), so
          // preflight both at install time and bake the absolute norn path.
          const config = readConfig();
          const vault = resolveVault({
            configPath: config.vault.path,
            envPath: process.env.MIMIR_VAULT,
          });
          return plistFor(
            binPath,
            serveInstallEnv({ nornPath: Bun.which('norn') ?? undefined, vault }),
          );
        },
        supervisor: new LaunchdSupervisor(bunExec, uid, SERVE_LABEL),
      },
      snapshot: {
        logFile: SNAPSHOT_LOG_FILE,
        plistFile: plistPathFor(SNAPSHOT_LABEL),
        // Bake the interval from the SAME config file the command reports from,
        // and the vault at install time (launchd does no shell expansion).
        render: (configFile) =>
          plistForSnapshot(binPath, {
            intervalSeconds:
              readVaultConfig(configFile).snapshot?.interval ?? DEFAULT_SNAPSHOT_INTERVAL_SECONDS,
            vaultPath: process.env.MIMIR_VAULT,
          }),
        supervisor: new LaunchdSupervisor(bunExec, uid, SNAPSHOT_LABEL),
      },
    },
    version: VERSION,
  };
}

function realVaultDeps(): VaultDeps {
  return {
    exec: bunExec,
    resolveVault: () =>
      resolveVault({ configPath: readConfig().vault.path, envPath: process.env.MIMIR_VAULT }),
    snapshotConfig: () => readConfig().vault.snapshot ?? {},
    stamp: () => new Date().toISOString(),
  };
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];

  if (command === '--version' || command === 'version') {
    console.log(VERSION);
    return 0;
  }

  if (command === 'serve') {
    const args = argv.slice(1);
    const flagPort = servePort(args);
    if (flagPort === null) {
      console.error('✗ serve: --port expects an integer in 1–65535');
      return 2;
    }
    const noHunt = args.includes('--no-hunt');
    // Declared port wins: flag > MIMIR_PORT env > global config > built-in
    // default (MMR-47, MMR-117). A malformed MIMIR_PORT is ignored with a warn.
    const overridePort = envPort();
    if (overridePort === null) {
      console.error(
        `⚠ serve: MIMIR_PORT ignored (not an integer in 1–65535) — ${String(process.env.MIMIR_PORT)}`,
      );
    }
    const config = readServeConfig();
    if (config.problem !== undefined) {
      console.error(`⚠ serve: config ignored (${config.problem}) — ${configPath()}`);
    }
    const port = flagPort ?? overridePort ?? config.port ?? DEFAULT_PORT;
    // Long-running: the server keeps the process alive; loopback-only by
    // design (ADR 0012 — the proxy is the boundary). Signals stop it cleanly.
    const built = await buildStore();
    // The record-health facet provider (MMR-185): every read handle is wired
    // unconditionally (the Norn vault is the only backend).
    const { readNodeDocs, readRaw, readSectionFailures, readVaultGraph, validate } = built;
    const deps: DoctorFacetDeps = {
      readNodeDocs,
      readRaw,
      readSectionFailures,
      readVaultGraph,
      validate,
    };
    const doctor = (scope: string | undefined): Promise<DoctorFacet> =>
      computeDoctorFacet(deps, scope);
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
      // still kill the Norn subprocess and exit for a supervisor to restart.
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

  if (command === 'mcp') {
    // Long-running: connect and let the stdio transport keep the process alive.
    // The MCP rendering honors the same Project Binding (ADR 0011), resolved
    // from the server's spawn cwd.
    const built = await buildStore();
    try {
      await serveStdio(built.store, VERSION, findBinding(process.cwd()));
    } finally {
      // serveStdio resolves when the stdio transport closes; close releases the
      // Norn subprocess (its open pipes would otherwise keep the process alive).
      await built.close();
    }
    return 0;
  }

  // Read and write commands go through the CLI. The store is acquired lazily
  // (MMR-39): a verb that touches data asks for it, converging the vault on
  // first ask; help, usage errors, and `skill install` never ask, so a bare
  // `mimir` / `mimir --help` never touches the vault. main holds no verb list.
  let built: BuiltStore | undefined;
  const getStore = async (): Promise<Store> => {
    if (built === undefined) {
      built = await buildStore();
    }
    return built.store;
  };
  try {
    // Project Binding (ADR 0011): the nearest .mimir.toml supplies the
    // default -s scope; resolved here so the CLI itself never reads cwd.
    return await runCli(argv, getStore, stdoutIo(), {
      cwd: process.cwd(),
      doctor: {
        // Vault diagnostics: build the store (the client) and read the vault.
        readNodeDocs: async (scope) => {
          await getStore();
          return (await built?.readNodeDocs(scope)) ?? [];
        },
        readSectionFailures: async (scope) => {
          await getStore();
          return (await built?.readSectionFailures(scope)) ?? [];
        },
        readVaultGraph: async () => {
          await getStore();
          return (await built?.readVaultGraph()) ?? { nodes: [], projectKeys: [] };
        },
        validate: async () => {
          await getStore();
          return (await built?.validate()) ?? { findings: [] };
        },
      },
      scope: findBinding(process.cwd()),
      service: realServiceDeps(),
      vault: realVaultDeps(),
    });
  } finally {
    // close() releases the Norn subprocess (its open pipes would otherwise keep
    // the process alive).
    await built?.close();
  }
}

process.exitCode = await main(process.argv.slice(2));

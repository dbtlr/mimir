/**
 * Entry point + composition root. Unlike the transport layers, `main` may wire
 * `db` and transports together. It opens the database (auto-applying migrations
 * on startup), then dispatches:
 *
 *   <verb> [args]   read/write commands → CLI transport
 *   mcp             the agent envelope over stdio → MCP transport
 *   --help, -h      help (handled by the CLI)
 *
 * The whole `migrate <sub>` namespace dispatches through the CLI transport;
 * `migrate schema` is wired in as the `migrateSchema` capability because it
 * must open the store WITHOUT auto-migrating (it inspects/applies migrations
 * itself), so it can't ride the normal auto-migrating store provider.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { findBinding, runCli } from './cli';
import type { Io } from './cli';
import type { Db, Store } from './core';
import { createDb } from './db/client';
import { migrateToLatest, migrationStatus } from './db/migrator';
import type { DoctorFacet } from './doctor/facet';
import { computeDoctorFacet } from './doctor/serve';
import type { DoctorFacetDeps } from './doctor/serve';
import { DEFAULT_PORT, IS_PRODUCTION, envFlag, envPort, storePath } from './env';
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
import { buildStore, storeBackend } from './store-backend';
import type { BuiltStore } from './store-backend';
import { resolveVault } from './vault';
import type { VaultDeps } from './vault/commands';
import { VERSION } from './version';

/**
 * Open the database — creating the parent directory if needed — and apply any
 * pending migrations under the migration lock.
 */
async function openMigrated(path: string): Promise<Db> {
  mkdirSync(dirname(path), { recursive: true });
  const db = createDb(path);
  const { error } = await migrateToLatest(db);
  if (error !== undefined) {
    await db.destroy();
    throw error instanceof Error ? error : new Error(JSON.stringify(error));
  }
  return db;
}

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

async function runMigrateSchema(sub: string | undefined): Promise<number> {
  // Opens without auto-migrating — `migrate schema` inspects/applies them itself.
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  const db = createDb(path);
  try {
    if (sub === 'status') {
      for (const m of await migrationStatus(db)) {
        console.log(`${m.executedAt === undefined ? 'pending ' : 'applied '} ${m.name}`);
      }
      return 0;
    }
    const { results, error } = await migrateToLatest(db);
    for (const r of results ?? []) {
      console.log(`${r.status === 'Success' ? 'applied' : 'failed '}  ${r.migrationName}`);
    }
    if (error !== undefined) {
      const message = error instanceof Error ? error.message : JSON.stringify(error);
      console.error(`migration error: ${message}`);
      return 1;
    }
    if ((results ?? []).length === 0) {
      console.log('already up to date');
    }
    return 0;
  } finally {
    await db.destroy();
  }
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
  const port = Number(raw);
  if (raw === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return port;
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
          // Read config once and feed both backend + vault resolution. On
          // SQLite the norn binary and vault are irrelevant, so don't resolve
          // them (a wasted PATH search + config-derived vault).
          const config = readConfig();
          const backend = storeBackend(config);
          if (backend === 'sqlite') {
            return plistFor(binPath, serveInstallEnv({ backend, dbPath: process.env.MIMIR_DB }));
          }
          const vault = resolveVault({
            configPath: config.vault.path,
            envPath: process.env.MIMIR_VAULT,
          });
          return plistFor(
            binPath,
            serveInstallEnv({ backend, nornPath: Bun.which('norn') ?? undefined, vault }),
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
    const db = await openMigrated(storePath());
    const built = await buildStore(db);
    // The record-health facet provider (MMR-185) — present only when the vault
    // read handles are (Norn backend). Destructured so the truthy guard narrows each
    // to its non-undefined type; on SQLite it stays undefined and the route serves
    // the empty facet.
    const { readNodeDocs, readRaw, readSectionFailures, readVaultGraph, validate } = built;
    let doctor: ((scope: string | undefined) => Promise<DoctorFacet>) | undefined;
    if (readNodeDocs && readRaw && readSectionFailures && readVaultGraph && validate) {
      const deps: DoctorFacetDeps = {
        readNodeDocs,
        readRaw,
        readSectionFailures,
        readVaultGraph,
        validate,
      };
      doctor = (scope) => computeDoctorFacet(deps, scope);
    }
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
    const db = await openMigrated(storePath());
    const built = await buildStore(db);
    try {
      await serveStdio(built.store, VERSION, findBinding(process.cwd()));
    } finally {
      // serveStdio resolves when the stdio transport closes; close releases the
      // Norn subprocess (its open pipes would otherwise keep the process alive)
      // and the db handle.
      await built.close();
    }
    return 0;
  }

  // Read and write commands go through the CLI. The store is acquired lazily
  // (MMR-39): a verb that touches data asks for it, opening + migrating on
  // first ask; help, usage errors, and `skill install` never ask, so a bare
  // `mimir` / `mimir --help` never creates a file. main holds no verb list.
  let built: BuiltStore | undefined;
  let dbHandle: Db | undefined;
  const getStore = async (): Promise<Store> => {
    if (built === undefined) {
      dbHandle = await openMigrated(storePath());
      built = await buildStore(dbHandle);
    }
    return built.store;
  };
  try {
    // Project Binding (ADR 0011): the nearest .mimir.toml supplies the
    // default -s scope; resolved here so the CLI itself never reads cwd.
    return await runCli(argv, getStore, stdoutIo(), {
      cwd: process.cwd(),
      db: async () => {
        await getStore(); // ensure the handle is open
        if (dbHandle === undefined) {
          throw new Error('internal: store opened without a db handle');
        }
        return dbHandle;
      },
      doctor: {
        // A vault diagnostic: on the SQLite backend there is no vault to read,
        // so doctor no-ops (null). On Norn, open the store (building the client)
        // and read every node document's raw body.
        readNodeDocs:
          storeBackend() === 'norn'
            ? async (scope) => {
                await getStore();
                return (await built?.readNodeDocs?.(scope)) ?? [];
              }
            : null,
        readSectionFailures:
          storeBackend() === 'norn'
            ? async (scope) => {
                await getStore();
                return (await built?.readSectionFailures?.(scope)) ?? [];
              }
            : null,
        readVaultGraph:
          storeBackend() === 'norn'
            ? async () => {
                await getStore();
                return (await built?.readVaultGraph?.()) ?? { nodes: [], projectKeys: [] };
              }
            : null,
        validate:
          storeBackend() === 'norn'
            ? async () => {
                await getStore();
                return (await built?.validate?.()) ?? { findings: [] };
              }
            : null,
      },
      migrateSchema: runMigrateSchema,
      scope: findBinding(process.cwd()),
      service: realServiceDeps(),
      vault: realVaultDeps(),
    });
  } finally {
    // close() releases the artifact backend (a Norn subprocess would otherwise
    // keep the process alive) and the db handle (MMR-160).
    await built?.close();
  }
}

process.exitCode = await main(process.argv.slice(2));

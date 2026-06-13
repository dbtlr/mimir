/**
 * Entry point + composition root. Unlike the transport layers, `main` may wire
 * `db` and transports together. It opens the database (auto-applying migrations
 * on startup), then dispatches:
 *
 *   <verb> [args]   read/write commands → CLI transport
 *   mcp             the agent envelope over stdio → MCP transport
 *   migrate [status] apply / inspect migrations
 *   --help, -h      help (handled by the CLI)
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import pkg from "../package.json";
import { findBinding, runCli } from "./cli";
import type { Io } from "./cli";
import { createDb } from "./db/client";
import { migrateToLatest, migrationStatus } from "./db/migrator";
import type { Db } from "./core";
import { createServer } from "./http";
import { serveStdio } from "./mcp";
import { configPath, readServeConfig } from "./service/config";

/**
 * The database path. `MIMIR_DB` overrides; otherwise a single user-global store
 * under the XDG data dir (`$XDG_DATA_HOME/mimir/mimir.db`, defaulting to
 * `~/.local/share/mimir/mimir.db`), so a globally-installed `mimir` works from
 * any directory.
 */
function dbPath(): string {
  const override = process.env.MIMIR_DB;
  if (override !== undefined) {
    return override;
  }
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "mimir", "mimir.db");
}

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

function stdoutIo(): Io {
  const isTTY = process.stdout.isTTY === true;
  const line = (stream: NodeJS.WriteStream) => (text: string) => {
    stream.write(text.endsWith("\n") ? text : `${text}\n`);
  };
  return {
    write: line(process.stdout),
    error: line(process.stderr),
    isTTY,
    plain: process.env.NO_COLOR !== undefined || !isTTY,
  };
}

async function runMigrate(sub: string | undefined): Promise<number> {
  // Opens without auto-migrating — `migrate` inspects/applies them itself.
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  const db = createDb(path);
  try {
    if (sub === "status") {
      for (const m of await migrationStatus(db)) {
        console.log(`${m.executedAt === undefined ? "pending " : "applied "} ${m.name}`);
      }
      return 0;
    }
    const { results, error } = await migrateToLatest(db);
    for (const r of results ?? []) {
      console.log(`${r.status === "Success" ? "applied" : "failed "}  ${r.migrationName}`);
    }
    if (error !== undefined) {
      const message = error instanceof Error ? error.message : JSON.stringify(error);
      console.error(`migration error: ${message}`);
      return 1;
    }
    if ((results ?? []).length === 0) {
      console.log("already up to date");
    }
    return 0;
  } finally {
    await db.destroy();
  }
}

/** Default `serve` port — MIMIR on a phone keypad. */
const DEFAULT_PORT = 64647;

/**
 * Parse `serve`'s `--port` flag.
 * - `undefined`: flag absent — caller uses config or built-in default.
 * - `null`: flag present but unusable (a usage fault).
 * - `number`: the parsed port.
 */
function servePort(args: string[]): number | null | undefined {
  const at = args.indexOf("--port");
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

async function main(argv: string[]): Promise<number> {
  const command = argv[0];

  if (command === "--version" || command === "version") {
    console.log(pkg.version);
    return 0;
  }

  if (command === "migrate") {
    return runMigrate(argv[1]);
  }

  if (command === "serve") {
    const args = argv.slice(1);
    const flagPort = servePort(args);
    if (flagPort === null) {
      console.error("✗ serve: --port expects an integer in 1–65535");
      return 2;
    }
    const noHunt = args.includes("--no-hunt");
    // Declared port wins: flag > global config > built-in default (MMR-47).
    const config = readServeConfig();
    if (config.problem !== undefined) {
      console.error(`⚠ serve: config ignored (${config.problem}) — ${configPath()}`);
    }
    const port = flagPort ?? config.port ?? DEFAULT_PORT;
    // Long-running: the server keeps the process alive; loopback-only by
    // design (ADR 0012 — the proxy is the boundary). Signals stop it cleanly.
    const db = await openMigrated(dbPath());
    let server: ReturnType<typeof createServer>;
    try {
      server = createServer(db, { port, version: pkg.version, hunt: !noHunt });
    } catch (err) {
      await db.destroy();
      if (err instanceof Error && "code" in err && err.code === "EADDRINUSE") {
        console.error(`✗ serve: ${err.message}`);
        console.error(
          noHunt
            ? "note: --no-hunt is set — free the port or change [serve] port in the config"
            : "note: pass --port to start the hunt elsewhere",
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
      await server.stop();
      await db.destroy();
      process.exit(0);
    };
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
    return 0;
  }

  if (command === "mcp") {
    // Long-running: connect and let the stdio transport keep the process alive.
    // The MCP rendering honors the same Project Binding (ADR 0011), resolved
    // from the server's spawn cwd.
    const db = await openMigrated(dbPath());
    await serveStdio(db, pkg.version, findBinding(process.cwd()));
    return 0;
  }

  // Read and write commands go through the CLI. The store is acquired lazily
  // (MMR-39): a verb that touches data asks for it, opening + migrating on
  // first ask; help, usage errors, and `skill install` never ask, so a bare
  // `mimir` / `mimir --help` never creates a file. main holds no verb list.
  let opened: Db | undefined;
  const getDb = async (): Promise<Db> => (opened ??= await openMigrated(dbPath()));
  try {
    // Project Binding (ADR 0011): the nearest .mimir.toml supplies the
    // default -s scope; resolved here so the CLI itself never reads cwd.
    return await runCli(argv, getDb, stdoutIo(), {
      scope: findBinding(process.cwd()),
      cwd: process.cwd(),
    });
  } finally {
    await opened?.destroy();
  }
}

process.exitCode = await main(process.argv.slice(2));

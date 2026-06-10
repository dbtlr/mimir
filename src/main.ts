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
import { runCli } from "./cli";
import type { Io } from "./cli";
import { createDb } from "./db/client";
import { migrateToLatest, migrationStatus } from "./db/migrator";
import type { Db } from "./core";
import { serveStdio } from "./mcp";

const READ_VERBS = new Set(["next", "get", "list", "status"]);
const WRITE_VERBS = new Set([
  "start",
  "done",
  "abandon",
  "park",
  "unpark",
  "block",
  "unblock",
  "depend",
  "undepend",
  "move",
  "reorder",
  "update",
  "annotate",
  "create",
  "attach",
  "tag",
  "untag",
]);

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

/** Create a client, ensuring the parent directory exists for a file-backed db. */
function openClient(path: string): Db {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  return createDb(path);
}

/** Open the database and apply any pending migrations under the migration lock. */
async function openMigrated(path: string): Promise<Db> {
  const db = openClient(path);
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
  const db = openClient(dbPath());
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

async function main(argv: string[]): Promise<number> {
  const command = argv[0];

  if (command === "--version" || command === "version") {
    console.log(pkg.version);
    return 0;
  }

  if (command === "migrate") {
    return runMigrate(argv[1]);
  }

  if (command === "mcp") {
    // Long-running: connect and let the stdio transport keep the process alive.
    const db = await openMigrated(dbPath());
    await serveStdio(db, pkg.version);
    return 0;
  }

  // Read and write commands go through the CLI. Only data commands need the
  // real database; help/unknown run against a throwaway in-memory db so a bare
  // `mimir` / `mimir --help` never creates a file.
  const needsData = command !== undefined && (READ_VERBS.has(command) || WRITE_VERBS.has(command));
  const db = needsData ? await openMigrated(dbPath()) : openClient(":memory:");
  try {
    return await runCli(argv, db, stdoutIo());
  } finally {
    await db.destroy();
  }
}

process.exitCode = await main(process.argv.slice(2));

/**
 * Entry point + composition root. Unlike the transport layers, `main` may wire
 * `db` and transports together. It opens the database (auto-applying migrations
 * on startup), then dispatches:
 *
 *   <verb> [args]   read commands (next/get/list/status) → CLI transport
 *   mcp             the agent envelope over stdio → MCP transport
 *   migrate [status] apply / inspect migrations
 *   --help, -h      help (handled by the CLI)
 */
import { runCli } from "./cli";
import type { Io } from "./cli";
import { createDb } from "./db/client";
import { migrateToLatest, migrationStatus } from "./db/migrator";
import type { Db } from "./core";
import { serveStdio } from "./mcp";

const DATA_COMMANDS = new Set(["next", "get", "list", "status"]);

function dbPath(): string {
  return process.env.MIMIR_DB ?? "mimir.db";
}

/** Open the database and apply any pending migrations under the migration lock. */
async function openMigrated(path: string): Promise<Db> {
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
  const db = createDb(dbPath());
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

  if (command === "migrate") {
    return runMigrate(argv[1]);
  }

  if (command === "mcp") {
    // Long-running: connect and let the stdio transport keep the process alive.
    const db = await openMigrated(dbPath());
    await serveStdio(db);
    return 0;
  }

  // Read commands + help/unknown go through the CLI. Only data commands need the
  // real database; help/unknown run against a throwaway in-memory db so a bare
  // `mimir` / `mimir --help` never creates a file.
  const needsData = command !== undefined && DATA_COMMANDS.has(command);
  const db = needsData ? await openMigrated(dbPath()) : createDb(":memory:");
  try {
    return await runCli(argv, db, stdoutIo());
  } finally {
    await db.destroy();
  }
}

process.exitCode = await main(process.argv.slice(2));

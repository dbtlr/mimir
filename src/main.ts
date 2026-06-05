/**
 * Entry point + composition root. Unlike the transport layers, `main` is
 * allowed to wire `db` and transports together — it is the one place the
 * layering does not constrain. It dispatches a subcommand and exits.
 *
 * Phase 0 wires only `migrate`; the read/write transports (`<verb>`, `mcp`,
 * `serve`) land in Phases 2–4.
 */
import { createDb } from "./db/client";
import { migrateToLatest, migrationStatus } from "./db/migrator";

const HELP = `mimir — source of truth for work state

Usage:
  mimir <command> [args]

Commands:
  migrate            Apply all pending migrations (forward-only)
  migrate status     Show each migration and whether it has been applied
  --help, -h         Show this help

Environment:
  MIMIR_DB           Database path (default: ./mimir.db)
`;

/** Resolve the database path from the environment, defaulting to ./mimir.db. */
function dbPath(): string {
  return process.env.MIMIR_DB ?? "mimir.db";
}

async function runMigrate(): Promise<number> {
  const db = createDb(dbPath());
  try {
    const { results, error } = await migrateToLatest(db);
    for (const r of results ?? []) {
      if (r.status === "Success") {
        console.log(`applied  ${r.migrationName}`);
      } else if (r.status === "Error") {
        console.error(`failed   ${r.migrationName}`);
      }
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

async function runMigrateStatus(): Promise<number> {
  const db = createDb(dbPath());
  try {
    const all = await migrationStatus(db);
    for (const m of all) {
      console.log(`${m.executedAt === undefined ? "pending " : "applied "} ${m.name}`);
    }
    if (all.length === 0) {
      console.log("no migrations defined");
    }
    return 0;
  } finally {
    await db.destroy();
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, sub] = argv;

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    console.log(HELP);
    return 0;
  }

  if (command === "migrate") {
    return sub === "status" ? runMigrateStatus() : runMigrate();
  }

  console.error(`unknown command: ${command}\n`);
  console.error(HELP);
  return 1;
}

process.exitCode = await main(process.argv.slice(2));

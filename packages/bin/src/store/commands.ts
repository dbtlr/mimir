/**
 * The `store` command family (ADR 0030) — the machinery noun for the store
 * itself. `store upgrade` is its first verb: the one explicit act that moves a
 * Postgres schema.
 *
 * It exists because a shared store is read by several binaries at once. No
 * binary migrates implicitly (`assertSchemaCurrent` refuses a schema it does
 * not exactly match), so the move has to be a command an operator runs once,
 * on one machine, after every binary is new enough to live with the result.
 *
 * Effects flow through {@link StoreDeps} so tests drive the layer against an
 * in-process Postgres; main wires the real config and the real pool.
 */
import { usage } from '../cli/errors';
import type { PostgresHandle, UpgradeReport } from '../core/store-postgres/index';
import { upgradeSchema } from '../core/store-postgres/index';
import { ok } from '../presentation';
import type { Format, Io } from '../presentation';
import type { GlobalConfig } from '../service/config';
import { DEFAULT_STORE_BACKEND } from '../service/config';
import { assertUsableStoreConfig } from '../store-backend';
import { postgresUrlMissing } from '../store-postgres-backend';

export type StoreDeps = {
  /** The global config — the backend fence and the connection URL. */
  readConfig: () => GlobalConfig;
  /** Open the Postgres connection named by `[store] url`. */
  openPostgres: (url: string) => PostgresHandle;
};

const SUBCOMMANDS = ['upgrade'] as const;

/**
 * What `store upgrade` reports on a Norn install. Not a refusal: the vault
 * converges itself on every open (ADR 0016), so there is nothing to move and
 * nothing the operator must do. Saying so is kinder than a usage error for an
 * operator following the shared-store guide on the wrong machine.
 */
const NORN_NOTE = 'store: the norn backend converges its vault on open — nothing to upgrade';

export async function cmdStore(
  positionals: string[],
  io: Io,
  deps: StoreDeps,
  format: Format,
): Promise<number> {
  const sub = positionals[1];
  if (sub !== 'upgrade') {
    throw usage(`store: unknown subcommand (expected: ${SUBCOMMANDS.join(' | ')})`);
  }
  return await cmdStoreUpgrade(io, deps, format);
}

async function cmdStoreUpgrade(io: Io, deps: StoreDeps, format: Format): Promise<number> {
  const config = deps.readConfig();
  assertUsableStoreConfig(config);
  const machine = format === 'json' || format === 'jsonl';

  if ((config.store.backend ?? DEFAULT_STORE_BACKEND) !== 'postgres') {
    if (machine) {
      io.write(JSON.stringify({ backend: 'norn', note: NORN_NOTE }));
    } else {
      ok(io, NORN_NOTE);
    }
    return 0;
  }

  const url = config.store.url;
  if (url === undefined) {
    throw postgresUrlMissing();
  }
  const handle = deps.openPostgres(url);
  try {
    // A stored schema NEWER than this binary is the migrator's own refusal — a
    // MimirError that renders through the normal error path. Nothing here
    // catches it: an upgrade command that swallowed it would be the one caller
    // able to pretend a downgrade happened.
    const report = await upgradeSchema(handle.db);
    if (machine) {
      io.write(JSON.stringify(report));
    } else {
      ok(io, describe(report));
    }
    return 0;
  } finally {
    await handle.close();
  }
}

/** A one-line human summary of an upgrade run. */
function describe(report: UpgradeReport): string {
  if (report.applied.length === 0) {
    return `store: schema at version ${String(report.to)} (already current)`;
  }
  return `store: schema upgraded from ${String(report.from)} to ${String(report.to)} (${report.applied.join(', ')})`;
}

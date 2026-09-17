/**
 * The `store` command family (ADR 0030) — the machinery noun for the store
 * itself. Three verbs: `upgrade` moves a Postgres schema, `export` and `import`
 * carry the store's stored facts across a backend or a machine (MMR-380).
 *
 * `upgrade` exists because a shared store is read by several binaries at once.
 * No binary migrates implicitly (`assertSchemaCurrent` refuses a schema it does
 * not exactly match), so the move has to be a command an operator runs once,
 * on one machine, after every binary is new enough to live with the result.
 *
 * `export`/`import` are the operator face of the seam's transfer document
 * (ADR 0030 Decision 4). They are backend-neutral by construction: they hold a
 * `Store`, not a connection, so the same pair backs up a vault, backs up a
 * Postgres database, and moves either onto the other.
 *
 * Effects flow through {@link StoreDeps} so tests drive the layer against an
 * in-process Postgres; main wires the real config and the real pool. The data
 * verbs take the same lazy `getStore` every data verb takes, so a usage error
 * is refused before any store opens.
 */
import { existsSync, statSync, writeFileSync } from 'node:fs';

import { usage } from '../cli/errors';
import type { ImportMode, ImportReport, StoreExport } from '../core/export';
import { canonicalJson } from '../core/export';
import type { Store } from '../core/store';
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
  /** The whole standard input, for `store import -`. An effect like the other
   * two, so a test can hand the layer a document without a real pipe. */
  readStdin: () => Promise<string>;
};

const SUBCOMMANDS = ['upgrade', 'export', 'import'] as const;

/** The flags `store import` owns (MMR-380). `export` takes none. */
export type StoreFlags = {
  /** Write the import instead of previewing it. */
  apply?: boolean;
  /** Re-run a partial import: skip what is already identical (ADR 0030). */
  resume?: boolean;
};

/** `-` is the standard stream stand-in: stdout for `export`, stdin for `import`. */
const STREAM = '-';

/**
 * What `store upgrade` reports on a Norn install. Not a refusal: the vault
 * converges itself on every open (ADR 0016), so there is nothing to move and
 * nothing the operator must do. Saying so is kinder than a usage error for an
 * operator following the shared-store guide on the wrong machine.
 */
const NORN_NOTE = 'store: the norn backend converges its vault on open — nothing to upgrade';

export async function cmdStore(
  positionals: string[],
  flags: StoreFlags,
  io: Io,
  deps: StoreDeps,
  format: Format,
  getStore: () => Store | Promise<Store>,
): Promise<number> {
  const sub = positionals[1];
  if (sub === 'upgrade') {
    refuseImportFlags('upgrade', flags);
    if (positionals.length > 2) {
      throw usage('store upgrade takes no arguments');
    }
    return await cmdStoreUpgrade(io, deps, format);
  }
  if (sub === 'export') {
    refuseImportFlags('export', flags);
    return await cmdStoreExport(requireFile(positionals, 'export', 'stdout'), io, format, getStore);
  }
  if (sub === 'import') {
    return await cmdStoreImport(
      requireFile(positionals, 'import', 'stdin'),
      flags,
      io,
      format,
      deps,
      getStore,
    );
  }
  throw usage(`store: unknown subcommand (expected: ${SUBCOMMANDS.join(' | ')})`);
}

/**
 * Refuse `--apply` and `--resume` on a subcommand that does not own them.
 *
 * The CLI's owned-flag guard owns this pair to the `store` VERB, which is as
 * fine-grained as that table gets — so `store export vault.json --apply` passes
 * it and lands on a verb that ignores the flag. Each one names a decision the
 * caller believes they made; saying nothing would be agreeing with them.
 */
function refuseImportFlags(sub: string, flags: StoreFlags): void {
  if (flags.apply === true) {
    throw usage(
      `'--apply' doesn't apply to store ${sub}`,
      `'--apply' writes a previewed import; use it with store import`,
    );
  }
  if (flags.resume === true) {
    throw usage(
      `'--resume' doesn't apply to store ${sub}`,
      `'--resume' re-runs a partial import, skipping what is already identical; use it with store import`,
    );
  }
}

/** The `code` of a Node filesystem error, or undefined for anything else. */
function errnoCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code: unknown = error.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** The refusal for an export path that is already taken. */
function alreadyExists(file: string): Error {
  return usage(
    `store export: ${file} already exists`,
    'export refuses to overwrite a backup — remove or rename the file, or name another path',
  );
}

/** The single file positional a transfer verb takes, refused before any store opens. */
function requireFile(positionals: string[], verb: string, stream: string): string {
  const file = positionals[2];
  if (file === undefined) {
    throw usage(`store ${verb} requires a file (or ${STREAM} for ${stream})`);
  }
  if (positionals.length > 3) {
    throw usage(`store ${verb} takes exactly one file`);
  }
  return file;
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

// ---------------------------------------------------------------------------
// export / import — the transfer document on the operator's side (MMR-380)
// ---------------------------------------------------------------------------

/**
 * Write the whole store as a transfer document.
 *
 * The file is refused when it already exists rather than overwritten: the one
 * thing a backup command must never do is destroy the backup taken before it,
 * and a shell that expanded a stale variable is the ordinary way that happens.
 * The operator removes or renames the file to say they meant it.
 */
async function cmdStoreExport(
  file: string,
  io: Io,
  format: Format,
  getStore: () => Store | Promise<Store>,
): Promise<number> {
  if (file !== STREAM && existsSync(file)) {
    throw alreadyExists(file);
  }
  const store = await getStore();
  const document = await store.export();
  // Two-space indent and a trailing newline: a backup is a file a human diffs
  // and a line-oriented tool reads, not a one-line blob. `canonicalJson` also
  // sorts the object keys, so two backends' documents of the same facts are
  // equal as FILES and not only as values — a `diff` of two backups then shows
  // the facts that changed rather than each backend's key order.
  const text = `${canonicalJson(document)}\n`;

  // On `-` the document IS the output — no summary, in any format, or the
  // stream a pipe consumes would carry two documents.
  if (file === STREAM) {
    io.write(text.trimEnd());
    return 0;
  }

  // Exclusive create (`wx`), not the check above alone: the check refuses
  // before the export is read, but a file created between the check and the
  // write would still be overwritten. The flag makes the refusal atomic.
  try {
    writeFileSync(file, text, { flag: 'wx' });
  } catch (error) {
    if (errnoCode(error) === 'EEXIST') {
      throw alreadyExists(file);
    }
    throw error;
  }
  const counts = {
    artifacts: document.artifacts.length,
    nodes: document.nodes.length,
    projects: document.projects.length,
    scratchpads: document.scratchpads.length,
    seeds: document.seeds.length,
  };
  if (format === 'json' || format === 'jsonl') {
    io.write(
      JSON.stringify({
        ...counts,
        exported_at: document.exported_at,
        path: file,
        schema_version: document.schema_version,
      }),
    );
  } else {
    const parts = [
      plural(counts.projects, 'project'),
      plural(counts.nodes, 'node'),
      plural(counts.artifacts, 'artifact'),
      plural(counts.seeds, 'seed'),
      plural(counts.scratchpads, 'scratchpad'),
    ];
    ok(io, `store: exported ${parts.join(', ')} to ${file}`);
  }
  return 0;
}

/**
 * Read a transfer document and hand it to the backend.
 *
 * The default is a PREVIEW: an import writes another store's identities into
 * this one, so the operator sees what it would do before it does it. `--apply`
 * is the deliberate second run.
 *
 * The shape check here is deliberately thin — an object carrying a numeric
 * `schema_version`. It exists only so a file that is plainly not a transfer
 * document is refused by NAME, which a backend error about a missing collection
 * would not do. The real validation (version, identities, the mode fences) is
 * the backend's, and its refusals render through the normal error path.
 */
async function cmdStoreImport(
  file: string,
  flags: StoreFlags,
  io: Io,
  format: Format,
  deps: StoreDeps,
  getStore: () => Store | Promise<Store>,
): Promise<number> {
  const document = await readDocument(file, deps);
  const mode: ImportMode = flags.resume === true ? 'resume' : 'fresh';
  const store = await getStore();
  const report = await store.import(document, { dryRun: flags.apply !== true, mode });

  if (format === 'json' || format === 'jsonl') {
    io.write(JSON.stringify(report));
  } else {
    ok(io, describeImport(report));
  }
  return 0;
}

/** Read and shape-check the document at `file` (`-` is stdin). */
async function readDocument(file: string, deps: StoreDeps): Promise<StoreExport> {
  if (file !== STREAM) {
    if (!existsSync(file)) {
      throw usage(`store import: ${file} doesn't exist`);
    }
    // A directory passes the existence check and then fails as a raw runtime
    // error on the read, which names neither the verb nor the reason. Refuse it
    // by name, like every other thing this file is not.
    if (statSync(file).isDirectory()) {
      throw usage(
        `store import: ${file} is not a file`,
        'pass the transfer document itself, or - to read it from stdin',
      );
    }
  }
  const source = file === STREAM ? 'stdin' : file;
  const text = file === STREAM ? await deps.readStdin() : await Bun.file(file).text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw usage(`store import: ${source} isn't valid JSON`);
  }
  if (!looksLikeDocument(parsed)) {
    throw usage(
      `store import: ${source} isn't a store export document (no numeric schema_version)`,
      "write one with 'mimir store export <file>'",
    );
  }
  return parsed;
}

/**
 * The thin shape check: an object carrying a numeric `schema_version`. It is
 * deliberately not a full parse — the backend validates the document, and the
 * narrowing here exists only so the file is refused by name.
 */
function looksLikeDocument(parsed: unknown): parsed is StoreExport {
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    typeof (parsed as { schema_version?: unknown }).schema_version === 'number'
  );
}

/** A one-line human summary of an import run — or of the apply a preview declined. */
function describeImport(report: ImportReport): string {
  if (report.applied) {
    return `store: imported ${String(report.created)}, skipped ${String(report.skipped)} (${report.mode})`;
  }
  return `store: import preview — would create ${String(report.created)}, skip ${String(report.skipped)} (${report.mode}); run again with --apply to write`;
}

/** `1 node` / `2 nodes` — every collection in the summary is a plain count. */
function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

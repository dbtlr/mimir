/**
 * The composition root of the Loom CLI, and the only module that imports
 * `@mimir/core` (lint-enforced). It builds the LocalEngine over the configured
 * store, the project binding over the clone's git config, and the Loom
 * Application, and hands commands only the ports they read through.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { Application, FatalError } from '@loomcli/core';
import { format } from '@loomcli/plugins/format';
import { help } from '@loomcli/plugins/help';
import { skills } from '@loomcli/plugins/skills';
import { MimirError } from '@mimir/contract';
import type { Engine } from '@mimir/contract';
import {
  artifactSummaryToWire,
  artifactToWire,
  assertDateFilters,
  assertUsableStoreConfig,
  BINDING_CONFIG_KEY,
  bindClone,
  bindingScope,
  buildStore,
  canonicalJson,
  configPath,
  DEFAULT_STORE_BACKEND,
  dateFilterWindows,
  findingLine,
  gitPortAt,
  LocalEngine,
  MAX_SEARCH_LIMIT,
  nodeToWire,
  openInstallationSqlite,
  openPostgres,
  overviewScratchpadToWire,
  overviewToWire,
  parseDateFilterTokens,
  parseFilterToken,
  parseIdentity,
  postgresUrlMissing,
  promoteToWire,
  readRuntimeConfig,
  requireTimeZone,
  resolveBinding,
  scratchpadReceiptToWire,
  scratchpadToWire,
  searchHitToWire,
  seedToWire,
  setToWire,
  treeToWire,
  triageToWire,
  upgradeSchema,
  warnConfigPermissions,
  withConfigDoctor,
} from '@mimir/core';
import type {
  BuiltStore,
  DoctorBackend,
  GitPort,
  GlobalConfig,
  PostgresHandle,
  SqliteHandle,
  Store,
} from '@mimir/core';

import { annotateCommand } from './commands/annotate';
import { artifactsCommand } from './commands/artifacts';
import { attachCommand } from './commands/attach';
import { bindCommand, LEGACY_BINDING_FILE } from './commands/bind';
import { createCommand } from './commands/create';
import { dependCommand, undependCommand } from './commands/depend';
import { doctorCommand } from './commands/doctor';
import { getCommand } from './commands/get';
import { groomCommand } from './commands/groom';
import { listCommand } from './commands/list';
import { nextCommand } from './commands/next';
import { overviewCommand } from './commands/overview';
import { moveCommand, reorderCommand } from './commands/place';
import { projectsCommand } from './commands/projects';
import { scratchCommand } from './commands/scratch';
import { searchCommand } from './commands/search';
import { promoteCommand, rejectCommand, resolveCommand, seedCommand } from './commands/seed';
import { seedsCommand } from './commands/seeds';
import { statusCommand } from './commands/status';
import { storeCommand } from './commands/store';
import { tagCommand, untagCommand } from './commands/tag';
import { treeCommand } from './commands/tree';
import { triageCommand } from './commands/triage';
import { updateCommand } from './commands/update';
import { versionCommand } from './commands/version';
import { defaultFormats } from './default-format';
import { failures, MimirUsageError } from './failures';
import { STREAM } from './machine';
import type { Machine } from './machine';
import { documentExists, readDocumentFile, writeDocumentFile } from './machine-files';
import type { Ports } from './ports';
import { MIMIR_SKILL } from './skill-files';
import { VERSION } from './version';

/** Where the CLI's work state and binding come from. */
export type CliSource = {
  /** The store, opened on first ask; the caller owns closing it. */
  store: () => Promise<Store>;
  /** The clone the binding is read from and written to. */
  git: GitPort;
  /** Ask a yes/no question on the terminal; defaults to a prompt on this process's streams. */
  confirm?: (question: string) => Promise<boolean>;
  /** The words of the run, which a failure's hint reads; defaults to this process's. */
  argv?: () => readonly string[];
  /** The machine-local services (MMR-553); a command that needs them refuses when absent. */
  machine?: MachineSource;
};

/** The edges the machine-local commands act through, so tests drive them over in-process stores. */
export type MachineSource = {
  /** The store backend's doctor, built on first ask. */
  doctor: () => Promise<Pick<DoctorBackend, 'diagnose'>>;
  /** The global config: the backend fence and the connection URL. */
  readConfig: () => GlobalConfig;
  /** Open the Postgres connection `[store] url` names. */
  openPostgres: (url: string) => PostgresHandle;
  /** Open, and so migrate, the installation's SQLite store. */
  openSqlite: () => Promise<SqliteHandle>;
  /** The whole standard input, for `store import -`. */
  readStdin: () => Promise<string>;
  /** The directory the retired binding file is looked for in. */
  cwd: string;
};

/**
 * Run an open of the store. A plain Error from opening it (a config fault, an
 * unregistered Postgres install) would reach the user as Loom's generic
 * internal failure, so it becomes a FatalError that carries its message.
 */
async function fatalOnOpen<T>(open: () => Promise<T>): Promise<T> {
  try {
    return await open();
  } catch (error) {
    if (error instanceof Error && !(error instanceof MimirError)) {
      throw new FatalError(error.message, { cause: error });
    }
    throw error;
  }
}

/** A `[y/N]` prompt on stderr, answered on stdin. */
async function promptYesNo(question: string): Promise<boolean> {
  const lines = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    return /^y(es)?$/i.test((await lines.question(`${question} [y/N] `)).trim());
  } finally {
    lines.close();
  }
}

/** A machine service that refuses: its command has no source in this context. */
const refuse = (what: string) => (): never => {
  throw new MimirUsageError(`${what} is unavailable in this context`);
};

/** The machine services for a context that supplies none: every use is a usage error. */
function unavailableMachine(): Machine {
  return {
    binding: {
      bind: refuse('bind'),
      check: refuse('bind'),
      configKey: BINDING_CONFIG_KEY,
      configured: refuse('doctor'),
      legacyFilePresent: () => false,
    },
    doctor: { diagnose: refuse('doctor') },
    store: {
      documentExists: refuse('store'),
      export: refuse('store'),
      import: refuse('store'),
      readDocument: refuse('store'),
      upgrade: refuse('store'),
      writeDocument: refuse('store'),
    },
    version: VERSION,
  };
}

/**
 * Move the configured database's schema. A SQLite store migrates whenever it
 * is opened, so opening it is the upgrade; a Postgres store moves only here.
 */
async function upgradeStore(source: MachineSource) {
  const config = source.readConfig();
  assertUsableStoreConfig(config);
  if ((config.store.backend ?? DEFAULT_STORE_BACKEND) === 'sqlite') {
    const handle = await fatalOnOpen(() => source.openSqlite());
    try {
      return handle.upgrade;
    } finally {
      await handle.close();
    }
  }
  const url = config.store.url;
  if (url === undefined) {
    throw postgresUrlMissing();
  }
  const handle = await fatalOnOpen(() => Promise.resolve(source.openPostgres(url)));
  try {
    // A stored schema newer than this binary is the migrator's own refusal; it
    // is not caught here, since an upgrade that swallowed it could pretend a
    // downgrade happened.
    return await upgradeSchema(handle.db);
  } finally {
    await handle.close();
  }
}

/** The machine services over one source, the clone, and the store, each opened on first ask. */
function machineOver(
  source: MachineSource,
  git: GitPort,
  getEngine: () => Promise<Engine>,
  getStore: () => Promise<Store>,
): Machine {
  return {
    binding: {
      bind: async (key) => {
        const { recordedRemote } = await bindClone(await getEngine(), git, key);
        return recordedRemote === undefined ? {} : { recordedRemote };
      },
      // Lazy: a git-config binding answers without opening the store.
      check: (notify) =>
        resolveBinding(
          { projectsByRemote: async (args) => (await getEngine()).projectsByRemote(args) },
          git,
          notify,
        ),
      configKey: BINDING_CONFIG_KEY,
      configured: async () => {
        const key = (await git.readConfig(BINDING_CONFIG_KEY))?.trim();
        return key === undefined || key === '' ? undefined : key;
      },
      legacyFilePresent: () => existsSync(join(source.cwd, LEGACY_BINDING_FILE)),
    },
    doctor: {
      diagnose: async (scope) => {
        const { findings, scope: match } = await (await fatalOnOpen(source.doctor)).diagnose(scope);
        return { findings, lines: findings.map(findingLine), scope: match };
      },
    },
    store: {
      // The data verbs run on whichever backend this install is configured for.
      documentExists,
      export: async () => {
        const document = await (await getStore()).export();
        return {
          counts: {
            artifacts: document.artifacts.length,
            nodes: document.nodes.length,
            projects: document.projects.length,
            scratchpads: document.scratchpads.length,
            seeds: document.seeds.length,
          },
          exportedAt: document.exported_at,
          schemaVersion: document.schema_version,
          // Sorted keys, so two backends' documents of the same facts are equal
          // as files and a diff shows the facts that changed.
          text: `${canonicalJson(document)}\n`,
        };
      },
      import: async (document, flags) =>
        (await getStore()).import(document, {
          dryRun: !flags.apply,
          mode: flags.resume ? 'resume' : 'fresh',
        }),
      readDocument: async (file) =>
        file === STREAM ? { kind: 'text', text: await source.readStdin() } : readDocumentFile(file),
      upgrade: () => upgradeStore(source),
      writeDocument: writeDocumentFile,
    },
    version: VERSION,
  };
}

/** The ports over one source: one Engine, opened lazily and shared by every ask. */
export function corePorts(source: CliSource): Ports {
  let engine: Promise<Engine> | undefined;
  const getEngine = (): Promise<Engine> => {
    engine ??= (async () => new LocalEngine(await fatalOnOpen(source.store)))();
    return engine;
  };
  return {
    confirm: source.confirm ?? promptYesNo,
    engine: getEngine,
    grammar: {
      assertDates: assertDateFilters,
      dateFilters: (tokens, field, zone) => {
        const filters = parseDateFilterTokens((op) => tokens[op], field);
        // Resolved now and the window thrown away: a bad date is refused before the store opens.
        dateFilterWindows(filters, zone);
        return filters;
      },
      filterToken: parseFilterToken,
      idKind: (token) => parseIdentity(token)?.kind,
      maxSearchLimit: MAX_SEARCH_LIMIT,
      timeZone: requireTimeZone,
    },
    machine:
      source.machine === undefined
        ? unavailableMachine()
        : machineOver(source.machine, source.git, getEngine, () => fatalOnOpen(source.store)),
    scope: (notify) => bindingScope(getEngine, source.git, notify)(),
    wire: {
      artifact: artifactToWire,
      artifactSummary: artifactSummaryToWire,
      node: nodeToWire,
      overview: overviewToWire,
      promotion: promoteToWire,
      scratchReceipt: scratchpadReceiptToWire,
      scratchRow: overviewScratchpadToWire,
      scratchpad: scratchpadToWire,
      searchHit: searchHitToWire,
      seed: seedToWire,
      set: setToWire,
      tree: treeToWire,
      triage: triageToWire,
    },
  };
}

/**
 * The Loom Application over one source. Mimir's failures come first, so a
 * refusal's own hint leads help's pointer; the destination defaults run ahead
 * of the formatter, so an explicit `-f` wins.
 */
export function createApp(source: CliSource) {
  const ports = corePorts(source);
  return (
    new Application('mimir', {
      description: 'Query and manage work state.',
      plugins: [
        failures(source.argv),
        help(),
        defaultFormats(),
        format({ short: 'f' }),
        // The skill files stay embedded, so the installed skill matches this binary.
        skills({ skills: [MIMIR_SKILL] }),
      ],
      version: VERSION,
    })
      .command(getCommand(ports))
      .command(nextCommand(ports))
      .command(listCommand(ports))
      .command(projectsCommand(ports))
      .command(statusCommand(ports))
      .command(treeCommand(ports))
      .command(overviewCommand(ports))
      .command(artifactsCommand(ports))
      .command(searchCommand(ports))
      .command(seedsCommand(ports))
      .command(seedCommand(ports))
      .command(promoteCommand(ports))
      .command(rejectCommand(ports))
      .command(resolveCommand(ports))
      .command(triageCommand(ports))
      .command(scratchCommand(ports))
      // MMR-551: structure and node writes.
      .command(createCommand(ports))
      .command(updateCommand(ports))
      .command(annotateCommand(ports))
      .command(attachCommand(ports))
      .command(dependCommand(ports))
      .command(undependCommand(ports))
      .command(moveCommand(ports))
      .command(reorderCommand(ports))
      .command(groomCommand(ports))
      .command(tagCommand(ports))
      .command(untagCommand(ports))
      // MMR-553: the machine-local commands. None opts in to MCP: the old MCP
      // server exposes the Engine alone, and these act on the machine.
      .command(bindCommand(ports))
      .command(doctorCommand(ports))
      .command(storeCommand(ports))
      .command(versionCommand(ports))
  );
}

/** Run this process's argv against the configured store, then release the store. */
export async function runMimir(): Promise<number> {
  let built: BuiltStore | undefined;
  const getBuilt = async (): Promise<BuiltStore> => {
    built ??= await buildStore();
    return built;
  };
  const app = createApp({
    git: gitPortAt(process.cwd()),
    machine: {
      cwd: process.cwd(),
      // The permission check needs only the config file, so a store that cannot
      // be built or read (down, bad credentials) must not hide it.
      doctor: () =>
        Promise.resolve({
          diagnose: async (scope) => {
            try {
              return await withConfigDoctor(
                (await fatalOnOpen(getBuilt)).doctor,
                configPath(),
              ).diagnose(scope);
            } catch (error) {
              warnConfigPermissions(scope, configPath(), (line) => {
                process.stderr.write(`${line}\n`);
              });
              throw error;
            }
          },
        }),
      openPostgres,
      openSqlite: () => openInstallationSqlite(),
      readConfig: readRuntimeConfig,
      readStdin: () => Bun.stdin.text(),
    },
    store: async () => (await getBuilt()).store,
  });
  try {
    return await app.run();
  } finally {
    await built?.close();
  }
}

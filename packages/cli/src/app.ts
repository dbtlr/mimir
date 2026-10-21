/**
 * The composition root of the Loom CLI, and the only module that imports
 * `@mimir/core` or `@mimir/wire` (lint-enforced). It builds the Engine — a
 * LocalEngine over the configured store, or a RemoteEngine when `[host]` names
 * the host that owns it (ADR 0038) — the project binding over the clone's git
 * config, and the Loom Application, and hands commands only the ports they
 * read through.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { Application, FatalError } from '@loomcli/core';
import { format } from '@loomcli/plugins/format';
import { help } from '@loomcli/plugins/help';
import { selfUpdate } from '@loomcli/plugins/self-update';
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
  configPath,
  credentialsPath,
  DEFAULT_STORE_BACKEND,
  exportedDocument,
  dateFilterWindows,
  findingLine,
  gitPortAt,
  hostOrigin,
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
  readCredentials,
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
  urlOrigin,
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
import { RemoteEngine } from '@mimir/wire/client';

import { annotateCommand } from './commands/annotate';
import { artifactsCommand } from './commands/artifacts';
import { attachCommand } from './commands/attach';
import { bindCommand, LEGACY_BINDING_FILE } from './commands/bind';
import { createCommand } from './commands/create';
import { dependCommand, undependCommand } from './commands/depend';
import { doctorCommand } from './commands/doctor';
import { getCommand } from './commands/get';
import { groomCommand } from './commands/groom';
import {
  abandonVerb,
  archiveVerb,
  blockVerb,
  doneVerb,
  parkVerb,
  queueVerb,
  reopenVerb,
  returnVerb,
  startVerb,
  submitVerb,
  unarchiveVerb,
  unblockVerb,
  unparkVerb,
  unqueueVerb,
} from './commands/lifecycle';
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

/** A host that owns the store, reached over the wire (ADR 0038). */
export type RemoteSource = {
  /** The Engine, built on first ask; a config or credentials refusal surfaces here. */
  engine: () => Promise<Engine>;
  /** The host's origin; refuses a broken `[host]` with its fix. */
  origin: () => string;
};

/**
 * Where the CLI's work state and binding come from. Work state is a local
 * store or a remote host, never both: each store has one owner.
 */
export type CliSource = CliSourceEdges &
  (
    | {
        /** The store, opened on first ask; the caller owns closing it. */
        store: () => Promise<Store>;
      }
    | { remote: RemoteSource }
  );

type CliSourceEdges = {
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

/**
 * `doctor` and `store` in remote mode, where the host owns the store and
 * mimir-host administers it (ADR 0038). Each refuses before it reads or writes
 * anything, and a broken `[host]` refuses first with its own fix.
 */
function remoteMachineWork(remote: RemoteSource): Pick<Machine, 'doctor' | 'store'> {
  const refuseStore = (): never => {
    throw new MimirError(
      'invariant',
      `mimir store acts on a local store, and this install's store lives on the host at ${remote.origin()}`,
      'export or import the board inside the host container: mimir-host store --help',
    );
  };
  return {
    doctor: {
      diagnose: () => {
        throw new MimirError(
          'invariant',
          `mimir doctor checks a local store, and this install's store lives on the host at ${remote.origin()}`,
          "check the store's health inside the host container: mimir-host doctor",
        );
      },
    },
    store: {
      documentExists: refuseStore,
      export: refuseStore,
      import: refuseStore,
      readDocument: refuseStore,
      upgrade: () => {
        throw new MimirError(
          'invariant',
          `this install's store lives on the host at ${remote.origin()}, which migrates it when it starts`,
          'update the host to upgrade its store',
        );
      },
      writeDocument: refuseStore,
    },
  };
}

/** Sends one request to the host; `fetch` outside tests. */
export type HostSend = (request: Request) => Promise<Response>;

type WireFetch = NonNullable<ConstructorParameters<typeof RemoteEngine>[0]['fetch']>;

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

/** A tRPC answer: an object holding a `result` or an `error` object. */
const isEnvelope = (body: unknown): boolean =>
  isObject(body) && (isObject(Reflect.get(body, 'result')) || isObject(Reflect.get(body, 'error')));

/**
 * The wire's fetch: each request goes to the host as sent, and the transport
 * failures a CLI can act on become refusals with their remedy. A redirect is
 * refused rather than followed, so the bearer token goes only to the origin it
 * was issued by.
 */
function hostFetch(origin: string, send: HostSend): WireFetch {
  const pair = `mimir pair ${origin}`;
  return async (input, init) => {
    let response: Response;
    try {
      response = await send(new Request(input, { ...init, redirect: 'manual' }));
    } catch (error) {
      throw new MimirError(
        'invariant',
        `cannot reach the host at ${origin}${error instanceof Error ? ` (${error.message})` : ''}`,
        'check that the host is running and that this machine can reach it',
      );
    }
    if (response.status === 401) {
      throw new MimirError('invariant', `the host at ${origin} refused this device's token`, pair);
    }
    if (response.status >= 300 && response.status < 400) {
      // Only the target's origin is shown: the parser normalizes it, so a
      // hostile Location header cannot write raw text to the terminal.
      const target = urlOrigin(response.headers.get('location'));
      throw new MimirError(
        'invariant',
        `the host at ${origin} redirected${target === undefined ? '' : ` to ${target}`}`,
        target === undefined
          ? 'set [host] url to the address the host serves, then pair with it'
          : `if the host now serves ${target}, pair with it: mimir pair ${target}`,
      );
    }
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      throw new MimirError(
        'invariant',
        `the host at ${origin} is unavailable (HTTP ${String(response.status)})`,
        'check that the host is running, then retry',
      );
    }
    // Something other than a host (a proxy's error page, another service, the
    // console's HTML shell) answers without the tRPC envelope the wire reads:
    // one JSON object holding a `result` or an `error` object.
    let body: unknown;
    try {
      body = JSON.parse(await response.text());
    } catch {
      body = undefined;
    }
    if (!isEnvelope(body)) {
      throw new MimirError(
        'invariant',
        `the host at ${origin} answered HTTP ${String(response.status)} without a Mimir response`,
        'check that [host] url names a mimir host',
      );
    }
    return { json: () => Promise.resolve(body), ok: response.ok };
  };
}

/**
 * The Engine with every failure that is not already a refusal (a fault inside
 * the host, an answer the wire cannot read) turned into one that names the
 * host, so it never reaches the user as an unhandled exception.
 */
function hostEngine(engine: Engine, origin: string): Engine {
  return new Proxy(engine, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') {
        return value;
      }
      return async (...args: unknown[]) => {
        try {
          return await Reflect.apply(value, target, args);
        } catch (error) {
          if (error instanceof MimirError) {
            throw error;
          }
          throw new MimirError(
            'invariant',
            `the host at ${origin} could not complete the request${error instanceof Error ? ` (${error.message})` : ''}`,
            "check the host's logs, or run mimir-host doctor inside the host container",
          );
        }
      };
    },
  });
}

/**
 * The host the config names, reached through RemoteEngine with this device's
 * bearer token and this CLI's version. The config and credentials are checked
 * on first ask, before any request is sent.
 */
export function remoteSource(options: {
  config: GlobalConfig;
  /** The config file the refusals name. */
  configFile: string;
  credentialsFile: string;
  fetch?: HostSend;
}): RemoteSource {
  const origin = () => hostOrigin(options.config, options.configFile);
  return {
    engine: async () => {
      const host = origin();
      const { token } = readCredentials(host, options.credentialsFile);
      return hostEngine(
        new RemoteEngine({
          fetch: hostFetch(host, options.fetch ?? ((request) => fetch(request))),
          headers: { authorization: `Bearer ${token}` },
          url: `${host}/trpc`,
          version: VERSION,
        }),
        host,
      );
    },
    origin,
  };
}

/**
 * Where a run's work state comes from: the host when the config has a
 * `[host]` section, usable or not, so a broken one refuses through remote mode
 * rather than opening a local store in the host's place; otherwise `store`.
 */
export function workStateSource(
  config: GlobalConfig,
  store: () => Promise<Store>,
  files: { configFile: string; credentialsFile: string },
): { store: () => Promise<Store> } | { remote: RemoteSource } {
  return config.host === undefined ? { store } : { remote: remoteSource({ config, ...files }) };
}

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

/** The machine services over one source, the clone, and the doctor and store services. */
function machineOver(
  source: MachineSource,
  git: GitPort,
  getEngine: () => Promise<Engine>,
  work: Pick<Machine, 'doctor' | 'store'>,
): Machine {
  return {
    ...work,
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
    version: VERSION,
  };
}

/** `doctor` and `store` over the local store, opened on first ask. */
function localMachineWork(
  source: MachineSource,
  getStore: () => Promise<Store>,
): Pick<Machine, 'doctor' | 'store'> {
  return {
    doctor: {
      diagnose: async (scope) => {
        const { findings, scope: match } = await (await fatalOnOpen(source.doctor)).diagnose(scope);
        return { findings, lines: findings.map(findingLine), scope: match };
      },
    },
    store: {
      // The data verbs run on whichever backend this install is configured for.
      documentExists,
      export: async () => exportedDocument(await getStore()),
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
  };
}

/** The ports over one source: one Engine, opened lazily and shared by every ask. */
export function corePorts(source: CliSource): Ports {
  let engine: Promise<Engine> | undefined;
  const getEngine = (): Promise<Engine> => {
    engine ??=
      'remote' in source
        ? source.remote.engine()
        : (async () => new LocalEngine(await fatalOnOpen(source.store)))();
    return engine;
  };
  // Remote mode refuses store even where no machine source is given.
  let machine: Machine;
  if ('remote' in source) {
    const work = remoteMachineWork(source.remote);
    machine =
      source.machine === undefined
        ? { ...unavailableMachine(), ...work }
        : machineOver(source.machine, source.git, getEngine, work);
  } else {
    machine =
      source.machine === undefined
        ? unavailableMachine()
        : machineOver(
            source.machine,
            source.git,
            getEngine,
            localMachineWork(source.machine, () => fatalOnOpen(source.store)),
          );
  }
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
    machine,
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
 * of the formatter, so an explicit `-f` wins. Loom's self-update replaces a
 * binary its `install.sh` placed (MMR-554); the old CLI printed no update
 * notices, so neither does this one. Mimir's own receipt follows the
 * replacement through core's installation record (ADR 0031).
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
        selfUpdate({ notices: false }),
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
      // MMR-550: the fourteen uniform lifecycle verbs.
      .command(queueVerb(ports))
      .command(unqueueVerb(ports))
      .command(startVerb(ports))
      .command(submitVerb(ports))
      .command(returnVerb(ports))
      .command(doneVerb(ports))
      .command(abandonVerb(ports))
      .command(reopenVerb(ports))
      .command(parkVerb(ports))
      .command(unparkVerb(ports))
      .command(blockVerb(ports))
      .command(unblockVerb(ports))
      .command(archiveVerb(ports))
      .command(unarchiveVerb(ports))
  );
}

/**
 * Run this process's argv against the configured store, or the host `[host]`
 * names, then release the store.
 */
export async function runMimir(): Promise<number> {
  const config = readRuntimeConfig();
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
    ...workStateSource(config, async () => (await getBuilt()).store, {
      configFile: configPath(),
      credentialsFile: credentialsPath(),
    }),
  });
  try {
    return await app.run();
  } finally {
    await built?.close();
  }
}

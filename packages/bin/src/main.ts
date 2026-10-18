/**
 * Entry point + composition root. Unlike the transport layers, `main` may wire
 * the store and transports together. It builds the store, then dispatches:
 *
 *   <verb> [args]   read/write commands → CLI transport
 *   mcp             the agent envelope over stdio → MCP transport
 *   --help, -h      help (handled by the CLI)
 *
 * `mcp`/`version` are machinery loners (ADR 0024) intercepted here, ahead of
 * `runCli`, because each has a real effect (hang on stdio, print a bare
 * version) a lazily-acquired store can't gate the way it gates every other
 * verb (MMR-39). `-h`/`--help` on either is the one exception: it's recognized
 * here and falls through to `runCli` instead, which renders that verb's
 * `COMMAND_HELP` descriptor without ever touching the store (MMR-294).
 */

import {
  bindingScope,
  buildStore,
  configPath,
  gitPortAt,
  INSTALLATION_PROTOCOL_RESPONSE,
  LocalEngine,
  openInstallationSqlite,
  openPostgres,
  readRuntimeConfig,
  runInstallationCommand,
  systemTimeZone,
  warnConfigPermissions,
  withConfigDoctor,
} from '@mimir/core';
import type { BuiltStore, DoctorBackend, Store } from '@mimir/core';

import { runCli } from './cli';
import type { Io } from './cli';
import { serveStdio } from './mcp';
import { manualFetch } from './self-update';
import type { SelfUpdateDeps } from './self-update';
import type { StoreDeps } from './store/commands';
import { VERSION } from './version';

const line = (stream: NodeJS.WriteStream) => (text: string) => {
  stream.write(text.endsWith('\n') ? text : `${text}\n`);
};

function stdoutIo(): Io {
  const isTTY = process.stdout.isTTY;
  // A downstream reader that closes early (`mimir … | head`) breaks the pipe;
  // the stream then emits EPIPE asynchronously, which is fatal if unhandled.
  // Exit quietly like a well-behaved Unix filter instead of surfacing a stack
  // trace — matters for any verb that writes line-by-line rather than in one
  // shot.
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
    zone: systemTimeZone(),
  };
}

/** True when `-h`/`--help` is present — the one case a machinery loner (mcp/version) doesn't intercept, falling through to `runCli`'s help instead (MMR-294). */
function wantsHelp(args: string[]): boolean {
  return args.includes('-h') || args.includes('--help');
}

/** The `self-update` edges: the binary it replaces, its version, and the release fetcher. */
function realSelfUpdateDeps(): SelfUpdateDeps {
  return { binPath: process.execPath, fetcher: manualFetch, version: VERSION };
}

/** The `store` machinery edges: the config this install reads, the pool it
 * opens, and stdin for `store import -`. Deliberately NOT the built store —
 * `store upgrade` runs before the schema gate would let a store exist. */
function realStoreDeps(): StoreDeps {
  return {
    openPostgres,
    openSqlite: () => openInstallationSqlite(),
    readConfig: readRuntimeConfig,
    readStdin: () => Bun.stdin.text(),
  };
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === 'installation-protocol') {
    console.log(INSTALLATION_PROTOCOL_RESPONSE);
    return 0;
  }
  if (command === 'installation-install') {
    try {
      runInstallationCommand(argv.slice(1));
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }

  if (command === '--version') {
    console.log(VERSION);
    return 0;
  }

  if (command === 'version' && !wantsHelp(argv.slice(1))) {
    console.log(VERSION);
    return 0;
  }

  if (command === 'mcp' && !wantsHelp(argv.slice(1))) {
    // Long-running: connect and let the stdio transport keep the process alive.
    // The MCP rendering honors the same Project Binding (ADR 0036), resolved
    // lazily from the server's spawn directory.
    const built = await buildStore();
    try {
      const scope = bindingScope(
        async () => new LocalEngine(built.store),
        gitPortAt(process.cwd()),
        line(process.stderr),
      );
      await serveStdio(built.store, VERSION, scope);
    } finally {
      // serveStdio resolves when the stdio transport closes; close releases the
      // store's connections so the process can exit.
      await built.close();
    }
    return 0;
  }

  // Read and write commands go through the CLI. The store is acquired lazily
  // (MMR-39): a verb that touches data asks for it, opening the store on first
  // ask; help, usage errors, and `skill install` never ask, so a bare
  // `mimir` / `mimir --help` never touches the store. main holds no verb list.
  let built: BuiltStore | undefined;
  const getBuilt = async (): Promise<BuiltStore> => {
    built ??= await buildStore();
    return built;
  };
  const getStore = async (): Promise<Store> => (await getBuilt()).store;
  const cliDoctor = async (): Promise<DoctorBackend> =>
    withConfigDoctor((await getBuilt()).doctor, configPath());
  try {
    // Project Binding (ADR 0036): the clone's git config supplies the default
    // -s scope, resolved lazily so only a command that needs one pays for it.
    const git = gitPortAt(process.cwd());
    return await runCli(argv, getStore, stdoutIo(), {
      cwd: process.cwd(),
      doctor: {
        // Every call first forces the lazy store build.
        diagnose: async (scope) => {
          try {
            return await (await cliDoctor()).diagnose(scope);
          } catch (err) {
            // The permission check needs only the config file, so a store that
            // cannot be built or read (down, bad credentials) must not hide it.
            warnConfigPermissions(scope, configPath(), line(process.stderr));
            throw err;
          }
        },
        facet: async (scope) => (await cliDoctor()).facet(scope),
      },
      git,
      scope: bindingScope(async () => new LocalEngine(await getStore()), git, line(process.stderr)),
      selfUpdate: realSelfUpdateDeps(),
      store: realStoreDeps(),
    });
  } finally {
    // close() releases the store's connections so the process can exit.
    await built?.close();
  }
}

process.exitCode = await main(process.argv.slice(2));

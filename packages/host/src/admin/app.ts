/**
 * The composition root of `mimir-host` (ADR 0038), the host's operator CLI.
 * It runs inside the host container (`docker exec mimir-host mimir-host
 * <command>`), reads the host configuration, and opens the host's store as the
 * host left it: it never creates or migrates it, because the host migrates on
 * boot (ADR 0035). Its commands administer pairing and device tokens, report
 * record health, and carry the transfer document. It has no `store upgrade`.
 */
import { join } from 'node:path';

import { Application, Command, FatalError } from '@loomcli/core';
import { format } from '@loomcli/plugins/format';
import { help } from '@loomcli/plugins/help';
import { exportCommand, importCommand } from '@mimir/cli/src/commands/store';
import { defaultFormats } from '@mimir/cli/src/default-format';
import { failures } from '@mimir/cli/src/failures';
import { STREAM } from '@mimir/cli/src/machine';
import { documentExists, readDocumentFile, writeDocumentFile } from '@mimir/cli/src/machine-files';
import { VERSION } from '@mimir/cli/src/version';
import { MimirError } from '@mimir/contract';
import { buildStore, exportedDocument, SQLITE_FILE } from '@mimir/core';
import type { BuiltStore } from '@mimir/core';

import { readHostConfig } from '../server/config';
import { doctorCommand } from './commands/doctor';
import { approveCommand, denyCommand, pendingCommand, unpairCommand } from './commands/pairing';
import { tokensCommand } from './commands/tokens';
import type { AdminPorts } from './ports';

/** Where `mimir-host` gets its store and input. */
export type AdminSource = {
  /** Open the host's store; the caller owns closing it. */
  open: () => Promise<BuiltStore>;
  /** The whole standard input, for `store import -`. */
  readStdin: () => Promise<string>;
  /** The current instant; defaults to the clock. */
  now?: () => Date;
};

/** Open the store the host configuration names, as the host left it. */
export function hostStoreOpener(env: NodeJS.ProcessEnv = process.env): () => Promise<BuiltStore> {
  return async () => {
    const config = await readHostConfig(env);
    return buildStore(
      { store: config.store },
      { existing: true, sqliteFile: join(config.dataDirectory, SQLITE_FILE) },
    );
  };
}

/**
 * Run an open of the store. A plain Error from opening it (an invalid host
 * configuration) would reach the operator as Loom's generic internal failure,
 * so it becomes a FatalError that carries its message.
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

/** The ports over one source: the store opens on first ask and is shared by every ask. */
export function adminPorts(source: AdminSource): AdminPorts {
  let built: Promise<BuiltStore> | undefined;
  const store = (): Promise<BuiltStore> => {
    built ??= fatalOnOpen(source.open);
    return built;
  };
  return {
    doctor: async (scope) => (await store()).doctor.facet(scope),
    now: source.now ?? (() => new Date()),
    tokens: async () => (await store()).tokens,
    transfer: {
      documentExists,
      export: async () => exportedDocument((await store()).store),
      import: async (document, flags) =>
        (await store()).store.import(document, {
          dryRun: !flags.apply,
          mode: flags.resume ? 'resume' : 'fresh',
        }),
      readDocument: async (file) =>
        file === STREAM ? { kind: 'text', text: await source.readStdin() } : readDocumentFile(file),
      writeDocument: writeDocumentFile,
    },
  };
}

/** The `mimir-host` Application over one source. */
export function createAdminApp(source: AdminSource) {
  const ports = adminPorts(source);
  return new Application('mimir-host', {
    description:
      'Administer the Mimir host: approve pairing, list and revoke device tokens, report record health, and move the transfer document.',
    plugins: [failures(), help(), defaultFormats(), format({ short: 'f' })],
    version: VERSION,
  })
    .command(pendingCommand(ports))
    .command(approveCommand(ports))
    .command(denyCommand(ports))
    .command(unpairCommand(ports))
    .command(tokensCommand(ports))
    .command(doctorCommand(ports))
    .command(
      new Command('store', {
        description:
          "Carry the host store's transfer document. The host migrates its store on boot, so there is no upgrade.",
      })
        .command(exportCommand(ports.transfer))
        .command(importCommand(ports.transfer, 'mimir-host')),
    );
}

/** Run this process's argv against the host's store, then release the store. */
export async function runMimirHost(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let built: BuiltStore | undefined;
  const open = hostStoreOpener(env);
  const app = createAdminApp({
    open: async () => {
      built = await open();
      return built;
    },
    readStdin: () => Bun.stdin.text(),
  });
  try {
    return await app.run();
  } finally {
    await built?.close();
  }
}

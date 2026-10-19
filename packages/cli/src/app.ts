/**
 * The composition root of the Loom CLI, and the only module that imports
 * `@mimir/core` (lint-enforced). It builds the LocalEngine over the configured
 * store, the project binding over the clone's git config, and the Loom
 * Application, and hands commands only the ports they read through.
 */
import { Application, FatalError } from '@loomcli/core';
import { format } from '@loomcli/plugins/format';
import { help } from '@loomcli/plugins/help';
import { MimirError } from '@mimir/contract';
import type { Engine } from '@mimir/contract';
import {
  artifactSummaryToWire,
  artifactToWire,
  assertDateFilters,
  bindingScope,
  buildStore,
  dateFilterWindows,
  gitPortAt,
  LocalEngine,
  MAX_SEARCH_LIMIT,
  nodeToWire,
  overviewScratchpadToWire,
  overviewToWire,
  parseDateFilterTokens,
  parseFilterToken,
  parseIdentity,
  promoteToWire,
  requireTimeZone,
  scratchpadReceiptToWire,
  scratchpadToWire,
  searchHitToWire,
  seedToWire,
  setToWire,
  treeToWire,
  triageToWire,
} from '@mimir/core';
import type { BuiltStore, GitPort, Store } from '@mimir/core';

import pkg from '../package.json';
import { artifactsCommand } from './commands/artifacts';
import { getCommand } from './commands/get';
import { listCommand } from './commands/list';
import { nextCommand } from './commands/next';
import { overviewCommand } from './commands/overview';
import { projectsCommand } from './commands/projects';
import { scratchCommand } from './commands/scratch';
import { searchCommand } from './commands/search';
import { promoteCommand, rejectCommand, resolveCommand, seedCommand } from './commands/seed';
import { seedsCommand } from './commands/seeds';
import { statusCommand } from './commands/status';
import { treeCommand } from './commands/tree';
import { triageCommand } from './commands/triage';
import { defaultFormats } from './default-format';
import { failures } from './failures';
import type { Ports } from './ports';

/** Where the CLI's work state and binding come from. */
export type CliSource = {
  /** The store, opened on first ask; the caller owns closing it. */
  store: () => Promise<Store>;
  /** The clone the binding is read from and written to. */
  git: GitPort;
};

/**
 * Open the source's store. A plain Error from opening it (a config fault, an
 * unregistered Postgres install) would reach the user as Loom's generic
 * internal failure, so it becomes a FatalError that carries its message.
 */
async function openStore(source: CliSource): Promise<Store> {
  try {
    return await source.store();
  } catch (error) {
    if (error instanceof Error && !(error instanceof MimirError)) {
      throw new FatalError(error.message, { cause: error });
    }
    throw error;
  }
}

/** The ports over one source: one Engine, opened lazily and shared by every ask. */
export function corePorts(source: CliSource): Ports {
  let engine: Promise<Engine> | undefined;
  const getEngine = (): Promise<Engine> => {
    engine ??= (async () => new LocalEngine(await openStore(source)))();
    return engine;
  };
  return {
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
  return new Application('mimir', {
    description: 'Query and manage work state.',
    plugins: [failures(), help(), defaultFormats(), format({ short: 'f' })],
    version: pkg.version,
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
    .command(scratchCommand(ports));
}

/** Run this process's argv against the configured store, then release the store. */
export async function runMimir(): Promise<number> {
  let built: BuiltStore | undefined;
  const app = createApp({
    git: gitPortAt(process.cwd()),
    store: async () => {
      built ??= await buildStore();
      return built.store;
    },
  });
  try {
    return await app.run();
  } finally {
    await built?.close();
  }
}

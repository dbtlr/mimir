/**
 * The composition root of the Loom CLI, and the only module that imports
 * `@mimir/core` (lint-enforced). It builds the LocalEngine over the configured
 * store, the project binding over the clone's git config, and the Loom
 * Application, and hands commands only the ports they read through.
 */
import { Application } from '@loomcli/core';
import { format } from '@loomcli/plugins/format';
import { help } from '@loomcli/plugins/help';
import type { Engine } from '@mimir/contract';
import {
  artifactToWire,
  assertDateFilters,
  bindingScope,
  buildStore,
  gitPortAt,
  LocalEngine,
  nodeToWire,
  parseFilterToken,
  parseIdentity,
  requireTimeZone,
  seedToWire,
  setToWire,
} from '@mimir/core';
import type { BuiltStore, GitPort, Store } from '@mimir/core';

import pkg from '../package.json';
import { getCommand } from './commands/get';
import { nextCommand } from './commands/next';
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

/** The ports over one source: one Engine, opened lazily and shared by every ask. */
export function corePorts(source: CliSource): Ports {
  let engine: Promise<Engine> | undefined;
  const getEngine = (): Promise<Engine> => {
    engine ??= (async () => new LocalEngine(await source.store()))();
    return engine;
  };
  return {
    engine: getEngine,
    grammar: {
      assertDates: assertDateFilters,
      filterToken: parseFilterToken,
      idKind: (token) => parseIdentity(token)?.kind,
      timeZone: requireTimeZone,
    },
    scope: (notify) => bindingScope(getEngine, source.git, notify)(),
    wire: { artifact: artifactToWire, node: nodeToWire, seed: seedToWire, set: setToWire },
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
    .command(nextCommand(ports));
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

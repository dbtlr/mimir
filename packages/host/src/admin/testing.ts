/**
 * The `mimir-host` test fixture: a host data directory whose SQLite store the
 * host's own open created and migrated, and a runner that drives the admin
 * Application over it exactly as the image does, through the host
 * configuration. Test-only.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runArgv } from '@mimir/cli/src/testing/run';
import type { ArgvRun } from '@mimir/cli/src/testing/run';
import { buildStore, SQLITE_FILE } from '@mimir/core';
import type { BuiltStore } from '@mimir/core';

import { createAdminApp, hostStoreOpener } from './app';

export type AdminFixture = {
  /** The host configuration `mimir-host` reads. */
  env: Record<string, string>;
  /** The store file the host owns. */
  file: string;
  /** The host's own handle on its store, as the serving process holds it. */
  host: BuiltStore;
  /**
   * Run `mimir-host` with `argv`; `stdin` feeds `store import -`, `tty` makes stdout a terminal,
   * and `columns` narrows that terminal's width.
   */
  run: (
    argv: string[],
    opts?: { stdin?: string; tty?: boolean; columns?: number; now?: Date },
  ) => Promise<ArgvRun>;
  close: () => Promise<void>;
};

/** A host data directory; `create: false` leaves the store unborn. */
export async function adminFixture({ create = true } = {}): Promise<AdminFixture> {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'mimir-host-admin-'));
  const env = { MIMIR_DATA_DIR: dataDirectory };
  const file = join(dataDirectory, SQLITE_FILE);
  const host = create
    ? await buildStore({ store: { backend: 'sqlite' } }, { sqliteFile: file, upgrade: true })
    : undefined;
  return {
    close: async () => {
      await host?.close();
      await rm(dataDirectory, { force: true, recursive: true });
    },
    env,
    file,
    get host(): BuiltStore {
      if (host === undefined) {
        throw new Error('this fixture has no host store');
      }
      return host;
    },
    run: async (argv, opts = {}) => {
      const opened: BuiltStore[] = [];
      const open = hostStoreOpener(env);
      const app = createAdminApp({
        now: () => opts.now ?? new Date(),
        open: async () => {
          const built = await open();
          opened.push(built);
          return built;
        },
        readStdin: () => Promise.resolve(opts.stdin ?? ''),
      });
      try {
        return await runArgv(app, argv, {
          env: {
            NO_COLOR: '1',
            TERM: 'dumb',
            ...(opts.columns === undefined ? {} : { COLUMNS: String(opts.columns) }),
          },
          stdin: opts.stdin,
          tty: opts.tty,
        });
      } finally {
        await Promise.all(opened.map((built) => built.close()));
      }
    },
  };
}

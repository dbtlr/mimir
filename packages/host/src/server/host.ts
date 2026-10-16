import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createApiHandler } from '@mimir/api';
import { buildStore, MimirError, SQLITE_FILE } from '@mimir/core';

import type { HostConfig } from './config';

/** Open the host-owned store and finish migrations before exposing handlers. */
export async function openHost(
  config: HostConfig,
  version: string,
  log: (line: string) => void = (line) => console.error(line),
) {
  if (config.store.backend === 'sqlite') {
    try {
      await mkdir(config.dataDirectory, { recursive: true });
      await access(config.dataDirectory, constants.W_OK);
      const file = join(config.dataDirectory, SQLITE_FILE);
      try {
        await access(file, constants.W_OK);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          throw error;
        }
      }
    } catch {
      throw new Error('MIMIR_DATA_DIR must name a writable SQLite directory');
    }
  }
  try {
    const built = await buildStore(
      { serve: config.serve, store: config.store },
      {
        onMigration: (name) => log(`host: applied migration ${name}`),
        sqliteFile: join(config.dataDirectory, SQLITE_FILE),
        upgrade: true,
      },
    );
    return {
      close: built.close,
      handle: createApiHandler(built.store, { doctor: built.doctor.facet, version }),
    };
  } catch (error) {
    if (error instanceof MimirError && error.hint?.includes('newer schema')) {
      throw new Error(`${error.message}; update the image; a newer schema is never downgraded`, {
        cause: error,
      });
    }
    throw error;
  }
}

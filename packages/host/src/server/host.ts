import { constants } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createApiHandler } from '@mimir/api';
import { buildSqliteStore, SQLITE_FILE } from '@mimir/core';

/** Open only the explicitly named SQLite store, without CLI configuration. */
export async function openHost(dataDirectory: string, version: string) {
  await mkdir(dataDirectory, { recursive: true });
  await access(dataDirectory, constants.W_OK);
  const file = join(dataDirectory, SQLITE_FILE);
  try {
    await access(file, constants.W_OK);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  const built = await buildSqliteStore(file);
  return {
    close: built.close,
    handle: createApiHandler(built.store, { doctor: built.doctor.facet, version }),
  };
}

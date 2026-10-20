import { join } from 'node:path';

import { buildStore, SQLITE_FILE } from '@mimir/core';

import { readHostConfig } from '../src/server/config';

/** Issue a pairing code against a fixture host's already-opened, isolated store. */
export async function issueFixtureCode(device: string, env: NodeJS.ProcessEnv): Promise<string> {
  const config = await readHostConfig(env);
  const built = await buildStore(
    { store: config.store },
    { sqliteFile: join(config.dataDirectory, SQLITE_FILE) },
  );
  try {
    return await built.tokens.issueCode(device);
  } finally {
    await built.close();
  }
}

if (import.meta.main) {
  const device = process.argv[2];
  if (device === undefined) {
    throw new Error('a fixture device name is required');
  }
  console.log(await issueFixtureCode(device, process.env));
}

import { join } from 'node:path';

import { buildStore, SQLITE_FILE } from '@mimir/core';

import { readHostConfig } from '../src/server/config';

/** Approve a pairing request by its code against a fixture host's already-opened, isolated store. */
export async function approveFixtureRequest(
  userCode: string,
  env: NodeJS.ProcessEnv,
): Promise<{ device: string; rotates: boolean }> {
  const config = await readHostConfig(env);
  const built = await buildStore(
    { store: config.store },
    { sqliteFile: join(config.dataDirectory, SQLITE_FILE) },
  );
  try {
    const approved = await built.tokens.approve(userCode);
    if (approved === null) {
      throw new Error('no live pairing request matches that code');
    }
    return approved;
  } finally {
    await built.close();
  }
}

if (import.meta.main) {
  const userCode = process.argv[2];
  if (userCode === undefined) {
    throw new Error('a pairing code is required');
  }
  console.log(JSON.stringify(await approveFixtureRequest(userCode, process.env)));
}

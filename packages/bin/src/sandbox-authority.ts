import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

import { z } from 'zod';

const authoritySchema = z
  .object({
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    id: z.uuid(),
    image: z.string().regex(/@sha256:[a-f0-9]{64}$/),
    paths: z.object({ cache: z.string(), config: z.string(), data: z.string() }).strict(),
    postgresUrl: z
      .string()
      .regex(/^postgres:\/\/mimir_sandbox:[a-f0-9]{64}@127\.0\.0\.1:[0-9]+\/mimir_sandbox$/),
    root: z.string(),
    version: z.literal(1),
  })
  .strict();

export type SandboxAuthority = z.infer<typeof authoritySchema>;

/** An authority file identifies generated resources; it never accepts a general database URL. */
export function readSandboxAuthority(file: string): SandboxAuthority {
  try {
    if (!isAbsolute(file) || basename(file) !== 'authority.json') {
      throw new Error('path');
    }
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const authority = authoritySchema.parse(value);
    if (
      realpathSync(file) !== file ||
      dirname(file) !== authority.root ||
      realpathSync(authority.root) !== authority.root
    ) {
      throw new Error('root');
    }
    const port = Number(new URL(authority.postgresUrl).port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('port');
    }
    for (const kind of ['config', 'data', 'cache'] as const) {
      const path = authority.paths[kind];
      if (path !== join(authority.root, kind, 'mimir') || realpathSync(path) !== path) {
        throw new Error('directory');
      }
    }
    const config = join(authority.paths.config, 'config.toml');
    const configStat = lstatSync(config, { throwIfNoEntry: false });
    if (configStat !== undefined && (!configStat.isFile() || realpathSync(config) !== config)) {
      throw new Error('configuration');
    }
    return authority;
  } catch {
    throw new Error('Invalid sandbox authority. Recreate the sandbox with bun run sandbox create.');
  }
}

export function sandboxAuthorityFromEnvironment(): SandboxAuthority | undefined {
  if (process.env.MIMIR_TEST_POSTGRES_URL !== undefined) {
    throw new Error('Arbitrary Postgres test URLs are disabled. Use bun run sandbox test.');
  }
  const file = process.env.MIMIR_SANDBOX_AUTHORITY;
  return file === undefined ? undefined : readSandboxAuthority(file);
}

/** Only the generated schema option may differ from the launcher-owned endpoint. */
export function assertSandboxPostgresUrl(url: string, authority: SandboxAuthority): void {
  const endpoint = new URL(url);
  const options = [...endpoint.searchParams.entries()];
  if (
    options.length > 1 ||
    options.some(
      ([key, value]) =>
        key !== 'options' || !/^-c search_path=mimir_test_[a-f0-9]{32}$/.test(value),
    )
  ) {
    throw new Error('Postgres URL does not match sandbox authority.');
  }
  endpoint.search = '';
  if (endpoint.href !== authority.postgresUrl) {
    throw new Error('Postgres URL does not match sandbox authority.');
  }
}

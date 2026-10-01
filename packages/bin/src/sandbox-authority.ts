import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

import { z } from 'zod';

const pathsSchema = z.object({ cache: z.string(), config: z.string(), data: z.string() }).strict();

/** A database sandbox: an owned Postgres container and its generated endpoint. */
const databaseAuthoritySchema = z
  .object({
    containerId: z.string().regex(/^[a-f0-9]{64}$/),
    id: z.uuid(),
    image: z.string().regex(/@sha256:[a-f0-9]{64}$/),
    paths: pathsSchema,
    postgresUrl: z
      .string()
      .regex(/^postgres:\/\/mimir_sandbox:[a-f0-9]{64}@127\.0\.0\.1:[0-9]+\/mimir_sandbox$/),
    root: z.string(),
    version: z.literal(1),
  })
  .strict();

/** A vault sandbox (MMR-54): owned directories and no database at all. Its store is
 *  the Norn vault in its own data directory, so it runs where Docker cannot. */
const vaultAuthoritySchema = z
  .object({
    id: z.uuid(),
    kind: z.literal('vault'),
    paths: pathsSchema,
    root: z.string(),
    version: z.literal(1),
  })
  .strict();

const authoritySchema = z.union([databaseAuthoritySchema, vaultAuthoritySchema]);

export type DatabaseSandboxAuthority = z.infer<typeof databaseAuthoritySchema>;
export type SandboxAuthority = z.infer<typeof authoritySchema>;

export function isDatabaseAuthority(
  authority: SandboxAuthority,
): authority is DatabaseSandboxAuthority {
  return 'postgresUrl' in authority;
}

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
    if (isDatabaseAuthority(authority)) {
      const port = Number(new URL(authority.postgresUrl).port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('port');
      }
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

/** A database sandbox's authority; a vault sandbox here is a caller error. */
export function readDatabaseAuthority(file: string): DatabaseSandboxAuthority {
  const authority = readSandboxAuthority(file);
  if (!isDatabaseAuthority(authority)) {
    throw new Error(`Sandbox ${authority.id} has no database authority.`);
  }
  return authority;
}

/** The generated endpoint of the database sandbox named by the environment, if any. */
export function sandboxPostgresUrlFromEnvironment(): string | undefined {
  const authority = sandboxAuthorityFromEnvironment();
  return authority !== undefined && isDatabaseAuthority(authority)
    ? authority.postgresUrl
    : undefined;
}

export function sandboxAuthorityFromEnvironment(): SandboxAuthority | undefined {
  if (process.env.MIMIR_TEST_POSTGRES_URL !== undefined) {
    throw new Error('Arbitrary Postgres test URLs are disabled. Use bun run sandbox test.');
  }
  const file = process.env.MIMIR_SANDBOX_AUTHORITY;
  return file === undefined ? undefined : readSandboxAuthority(file);
}

/** Only the generated schema option may differ from the launcher-owned endpoint.
 *  A vault sandbox owns no endpoint, so no URL matches it. */
export function assertSandboxPostgresUrl(url: string, authority: SandboxAuthority): void {
  if (!isDatabaseAuthority(authority)) {
    throw new Error(
      'Postgres URL does not match sandbox authority: a vault sandbox has no database.',
    );
  }
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

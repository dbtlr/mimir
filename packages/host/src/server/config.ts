import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { isHostName, normalizeServeUrl } from '@mimir/core';
import type { ServeConfig, StoreConfig } from '@mimir/core';
import { parse } from 'pg-connection-string';

/** Read and validate host configuration without consulting CLI configuration. */
export async function readHostConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.MIMIR_DATABASE_URL !== undefined && env.MIMIR_DATABASE_URL_FILE !== undefined) {
    throw new Error('MIMIR_DATABASE_URL and MIMIR_DATABASE_URL_FILE cannot both be set');
  }
  let url = env.MIMIR_DATABASE_URL;
  const urlVariable =
    env.MIMIR_DATABASE_URL_FILE === undefined ? 'MIMIR_DATABASE_URL' : 'MIMIR_DATABASE_URL_FILE';
  if (env.MIMIR_DATABASE_URL_FILE !== undefined) {
    try {
      url = (await readFile(env.MIMIR_DATABASE_URL_FILE, 'utf8')).trim();
    } catch {
      throw new Error('MIMIR_DATABASE_URL_FILE must name a readable connection URL file');
    }
  }
  const store: StoreConfig = { backend: 'sqlite' };
  if (url !== undefined) {
    try {
      if (!/^postgres(?:ql)?:\/\//i.test(url) || /[\r\n\0]/.test(url)) {
        throw new Error('invalid Postgres URL');
      }
      // Match the driver's socket and credential syntax instead of WHATWG URL rules.
      const { host } = parse(url);
      if (!host || /[\r\n\0]/.test(host) || (!host.startsWith('/') && /\s/.test(host))) {
        throw new Error('Postgres URL must name a host or socket directory');
      }
    } catch {
      throw new Error(`${urlVariable} must contain a Postgres connection URL`);
    }
    store.backend = 'postgres';
    store.url = url;
  }
  const port = env.MIMIR_PORT === undefined ? 64647 : Number(env.MIMIR_PORT);
  if (
    (env.MIMIR_PORT !== undefined && !/^\d+$/.test(env.MIMIR_PORT)) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error('MIMIR_PORT must be an integer from 1 to 65535');
  }
  const dataDirectory = env.MIMIR_DATA_DIR ?? resolve('.dev/host');
  if (dataDirectory.trim() === '' || dataDirectory.includes('\0')) {
    throw new Error('MIMIR_DATA_DIR must name a directory');
  }
  const serve: ServeConfig = {};
  if (env.MIMIR_HOSTS !== undefined) {
    const hosts =
      env.MIMIR_HOSTS === '' ? [] : env.MIMIR_HOSTS.split(',').map((host) => host.trim());
    if (!hosts.every(isHostName)) {
      throw new Error('MIMIR_HOSTS must contain comma-separated bare hostnames');
    }
    serve.hosts = hosts;
  }
  if (env.MIMIR_URL !== undefined) {
    const origin = normalizeServeUrl(env.MIMIR_URL);
    if (origin === undefined) {
      throw new Error('MIMIR_URL must be an HTTP or HTTPS origin without a path');
    }
    serve.url = origin;
  }
  return { dataDirectory, port, serve, store };
}

export type HostConfig = Awaited<ReturnType<typeof readHostConfig>>;

declare global {
  // The launcher, Nitro plugins, and Start routes are separate bundles.
  var mimirHostConfiguration: Promise<HostConfig> | undefined;
}

/** Preserve one validated boot snapshot across the host's server bundles. */
export function hostConfig() {
  globalThis.mimirHostConfiguration ??= readHostConfig();
  return globalThis.mimirHostConfiguration;
}

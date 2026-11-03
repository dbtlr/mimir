import type { Engine } from '@mimir/contract';
import { openSecret, sealSecret, tryNormalizeRemote } from '@mimir/core';
import type { HostSecretStore, SecretKey } from '@mimir/core';
import { z } from 'zod';

import { logEvent, openMcpSession, T3RequestError } from './t3-http';
import type { McpSession, T3Fetch, T3Http } from './t3-http';
import {
  authorizationUrl,
  createPendingAuthorizations,
  discoverAuthServer,
  exchangeCode,
  mcpResource,
  randomToken,
  registerClient,
  T3_OPERATE_SCOPE,
} from './t3-oauth';
import { isLoopbackHostname } from './t3-settings';
import type { T3Settings } from './t3-settings';
import { T3_RUNTIME_MODES } from './t3-states';
import type {
  T3CallbackReason,
  T3Catalog,
  T3ConnectResult,
  T3Provider,
  T3RuntimeMode,
  T3Status,
  T3System,
  T3Unavailable,
} from './t3-states';

/*
 * The T3 Code adapter (ADR 0040): Connect, its callback, the Devices page's
 * status, and one project's launch catalog. It reaches work state only through
 * the Engine and its credential only through the host-secret store, and it
 * re-reads T3 on every call instead of mirroring it. Every T3 failure becomes
 * a tagged state here, before the fault boundary.
 */

/** The host secret holding the sealed access token, its expiry, and its issuer. */
export const T3_SECRET_NAME = 't3.oauth';

/** The path T3 returns the browser to. */
export const T3_CALLBACK_PATH = '/auth/t3/callback';

const DEFAULT_TIMEOUT_MS = 10_000;
const PROJECT_PAGE_LIMIT = 100;
/** A bound on `t3_project_list` pages, so a cursor that never ends cannot loop forever. */
const MAX_PROJECT_PAGES = 100;

export type T3AdapterOptions = {
  settings: T3Settings;
  secrets: HostSecretStore;
  /** The Engine read the catalog uses to find a project's stored remote. */
  engine: Pick<Engine, 'getNode'>;
  /** The host build, sent as the MCP client version. */
  version: string;
  fetch?: T3Fetch;
  log?: (line: string) => void;
  clock?: () => number;
  timeoutMs?: number;
};

const sealedSchema = z.strictObject({
  accessToken: z.string().min(1),
  expiresAt: z.iso.datetime(),
  issuer: z.string(),
});

const environmentSchema = z.looseObject({
  environmentId: z.string().min(1),
  label: z.string(),
  preferences: z.looseObject({ defaultThreadEnvMode: z.string().nullish() }).nullish(),
});

const linksSchema = z.looseObject({
  links: z.array(
    z.looseObject({ environmentId: z.string().min(1), label: z.string(), status: z.string() }),
  ),
});

const projectPageSchema = z.looseObject({
  nextCursor: z.number().int().nonnegative().nullish(),
  projects: z.array(
    z.looseObject({
      defaultModelSelection: z.looseObject({ instanceId: z.string(), model: z.string() }).nullish(),
      id: z.string(),
      repositoryIdentity: z
        .looseObject({
          locator: z.looseObject({ remoteUrl: z.string().nullish() }).nullish(),
        })
        .nullish(),
      title: z.string(),
    }),
  ),
});

const optionValue = z.union([z.string(), z.number(), z.boolean()]);

const capabilitiesSchema = z.looseObject({
  providers: z.array(
    z.looseObject({
      constraints: z.array(z.unknown()).nullish(),
      displayName: z.string(),
      models: z.array(
        z.looseObject({
          id: z.string(),
          label: z.string().nullish(),
          options: z
            .array(
              z.looseObject({
                default: optionValue.nullish(),
                id: z.string(),
                values: z.array(optionValue).nullish(),
              }),
            )
            .nullish(),
        }),
      ),
      providerInstanceId: z.string(),
      runtimeModes: z.array(z.string()).nullish(),
    }),
  ),
  runtimeMode: z.enum(T3_RUNTIME_MODES),
});

/** Check a tool's reply against its schema; a reply that fails reads as unreachable. */
function parseReply<T>(schema: z.ZodType<T>, payload: unknown, tool: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new T3RequestError('unreachable', `/mcp ${tool}`);
  }
  return parsed.data;
}

/** The runtime modes a provider may launch with: its own (or all four), no broader than the ceiling. */
function launchModes(listed: string[] | null | undefined, ceiling: T3RuntimeMode): T3RuntimeMode[] {
  const limit = T3_RUNTIME_MODES.indexOf(ceiling);
  const offered = new Set(listed ?? T3_RUNTIME_MODES);
  return T3_RUNTIME_MODES.filter((mode, rank) => rank <= limit && offered.has(mode));
}

function enabledProviders(capabilities: z.output<typeof capabilitiesSchema>): T3Provider[] {
  return capabilities.providers
    .filter((provider) => (provider.constraints ?? []).length === 0)
    .map((provider) => ({
      displayName: provider.displayName,
      models: provider.models.map((model) => ({
        id: model.id,
        label: model.label ?? null,
        options: (model.options ?? []).map((option) => ({
          default: option.default ?? null,
          id: option.id,
          values: option.values ?? [],
        })),
      })),
      providerInstanceId: provider.providerInstanceId,
      runtimeModes: launchModes(provider.runtimeModes, capabilities.runtimeMode),
    }));
}

/** A disconnected or unreachable state for a T3 failure; anything else is a fault and rethrows. */
function failureState(error: unknown): T3Unavailable {
  if (error instanceof T3RequestError) {
    return error.kind === 'rejected'
      ? { reason: 'rejected', state: 'disconnected' }
      : { state: 'unreachable' };
  }
  throw error;
}

/** Every page of one system's projects that match `remote`. */
async function matchingProjects(mcp: McpSession, environmentId: string, remote: string) {
  const matches: z.output<typeof projectPageSchema>['projects'] = [];
  let cursor: number | undefined;
  for (let page = 0; page < MAX_PROJECT_PAGES; page += 1) {
    const reply = parseReply(
      projectPageSchema,
      await mcp.call('t3_project_list', {
        environmentId,
        limit: PROJECT_PAGE_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
      }),
      't3_project_list',
    );
    matches.push(
      ...reply.projects.filter((project) => {
        const remoteUrl = project.repositoryIdentity?.locator?.remoteUrl;
        return typeof remoteUrl === 'string' && tryNormalizeRemote(remoteUrl) === remote;
      }),
    );
    if (reply.nextCursor === null || reply.nextCursor === undefined) {
      return matches;
    }
    cursor = reply.nextCursor;
  }
  throw new T3RequestError('unreachable', '/mcp t3_project_list');
}

/**
 * One system's catalog entry, or undefined when it has no matching project.
 * A failed read marks only this system unreachable; a `401` rethrows, since
 * it rejects the token everywhere.
 */
async function readSystem(
  mcp: McpSession,
  system: { environmentId: string; label: string },
  remote: string,
  defaultThreadEnvMode: () => Promise<string | null>,
): Promise<T3System | undefined> {
  try {
    const [projects, capabilities, envMode] = await Promise.all([
      matchingProjects(mcp, system.environmentId, remote),
      mcp
        .call('orchestrator_capabilities', { environmentId: system.environmentId })
        .then((reply) => parseReply(capabilitiesSchema, reply, 'orchestrator_capabilities')),
      defaultThreadEnvMode(),
    ]);
    if (projects.length === 0) {
      return undefined;
    }
    return {
      defaultThreadEnvMode: envMode,
      environmentId: system.environmentId,
      label: system.label,
      projects: projects.map((project) => ({
        defaultModelSelection:
          project.defaultModelSelection === null || project.defaultModelSelection === undefined
            ? null
            : {
                instanceId: project.defaultModelSelection.instanceId,
                model: project.defaultModelSelection.model,
              },
        id: project.id,
        title: project.title,
      })),
      providers: enabledProviders(capabilities),
      status: 'reachable',
    };
  } catch (error) {
    if (error instanceof T3RequestError && error.kind !== 'rejected') {
      return { environmentId: system.environmentId, label: system.label, status: 'unreachable' };
    }
    throw error;
  }
}

/** The linked peers; with linked environments off the tool is absent, which reads as none. */
async function readPeers(mcp: McpSession) {
  try {
    return parseReply(
      linksSchema,
      await mcp.call('t3_environment_links', {}),
      't3_environment_links',
    ).links;
  } catch (error) {
    if (error instanceof T3RequestError && error.kind === 'tool') {
      return [];
    }
    throw error;
  }
}

async function readEnvironment(mcp: McpSession, environmentId?: string) {
  return parseReply(
    environmentSchema,
    await mcp.call('t3_environment_read', environmentId === undefined ? {} : { environmentId }),
    't3_environment_read',
  );
}

/**
 * The console origin T3 returns the browser to: `MIMIR_URL`, or a loopback
 * request origin when it is unset (T3 accepts HTTPS or loopback redirects only).
 */
function consoleOrigin(consoleUrl: string | undefined, requestOrigin: string): string | undefined {
  if (consoleUrl !== undefined) {
    return consoleUrl;
  }
  const url = URL.parse(requestOrigin);
  return url !== null && isLoopbackHostname(url.hostname) ? url.origin : undefined;
}

const MIMIR_URL_UNSET: T3Unavailable = {
  problem: 'unset',
  setting: 'MIMIR_URL',
  state: 'misconfigured',
};

/** Build the T3 adapter over its settings, the host-secret store, and an Engine read. */
export function createT3Adapter(options: T3AdapterOptions) {
  const { settings, secrets, engine, version } = options;
  const http: T3Http = {
    clock: options.clock ?? Date.now,
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    log: options.log ?? ((line) => console.error(line)),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  const pending = createPendingAuthorizations(http.clock);

  type Ready = { t3: string; key: SecretKey; consoleUrl: string | undefined };

  /** The settings when the feature is usable, or the state that says why not. */
  const ready = (): Ready | T3Unavailable => {
    if (!settings.enabled) {
      return { state: 'unconfigured' };
    }
    const [problem] = settings.problems;
    if (problem !== undefined || settings.url === undefined || settings.key === undefined) {
      return {
        state: 'misconfigured',
        ...(problem ?? { problem: 'malformed', setting: 'MIMIR_T3_URL' }),
      };
    }
    return { consoleUrl: settings.consoleUrl, key: settings.key, t3: settings.url };
  };

  type Connection = { token: string; expiresAt: string };

  /** The sealed token, or why there is none to send. A row that fails to open reads as absent. */
  const readConnection = async (setup: Ready): Promise<Connection | T3Unavailable> => {
    const sealed = await secrets.read(T3_SECRET_NAME);
    if (sealed === undefined) {
      return { reason: 'none', state: 'disconnected' };
    }
    const opened = openSecret(setup.key, T3_SECRET_NAME, sealed);
    if (opened === undefined) {
      logEvent(http, 'host_secret_unopenable', {
        cause: 'the row failed authentication: the key changed or the row was altered',
        name: T3_SECRET_NAME,
      });
      return { reason: 'none', state: 'disconnected' };
    }
    let saved: z.output<typeof sealedSchema>;
    try {
      saved = sealedSchema.parse(JSON.parse(opened));
    } catch {
      logEvent(http, 'host_secret_unreadable', { name: T3_SECRET_NAME });
      return { reason: 'none', state: 'disconnected' };
    }
    // A token issued by another server is never sent to this one.
    if (saved.issuer !== setup.t3) {
      return { reason: 'rejected', state: 'disconnected' };
    }
    if (Date.parse(saved.expiresAt) <= http.clock()) {
      return { reason: 'expired', state: 'disconnected' };
    }
    return { expiresAt: saved.expiresAt, token: saved.accessToken };
  };

  const session = (setup: Ready, connection: Connection) =>
    openMcpSession(http, new URL(mcpResource(setup.t3)), connection.token, version);

  const redirectTo = (reason: T3CallbackReason) => {
    logEvent(http, 't3_connect_callback', { outcome: reason });
    return new Response(null, {
      headers: {
        'cache-control': 'no-store',
        location: `/devices?t3=${reason}`,
        'referrer-policy': 'no-referrer',
      },
      status: 303,
    });
  };

  return {
    /**
     * `GET /auth/t3/callback`: consume the pending authorization `state`
     * names, check `iss`, exchange the code, and seal the grant as
     * `t3.oauth`. Every outcome redirects to `/devices?t3=<reason>`; only
     * `connected` writes.
     */
    callback: async (request: Request): Promise<Response> => {
      const setup = ready();
      if ('state' in setup) {
        return redirectTo('misconfigured');
      }
      const query = new URL(request.url).searchParams;
      const entry = pending.take(query.get('state') ?? '');
      if (entry === undefined) {
        return redirectTo('stale');
      }
      if (query.get('iss') !== setup.t3) {
        return redirectTo('issuer');
      }
      const error = query.get('error');
      if (error !== null) {
        return redirectTo(error === 'access_denied' ? 'denied' : 'failed');
      }
      const code = query.get('code');
      if (code === null || code === '') {
        return redirectTo('failed');
      }
      let grant;
      try {
        grant = await exchangeCode(http, setup.t3, entry, code);
      } catch (failure) {
        if (failure instanceof T3RequestError) {
          return redirectTo('failed');
        }
        throw failure;
      }
      // A grant that cannot launch is discarded, not kept for reads.
      if (!grant.scopes.includes(T3_OPERATE_SCOPE)) {
        return redirectTo('read_only');
      }
      const plaintext = JSON.stringify({
        accessToken: grant.accessToken,
        expiresAt: new Date(grant.expiresAt).toISOString(),
        issuer: setup.t3,
      });
      try {
        await secrets.write(T3_SECRET_NAME, sealSecret(setup.key, T3_SECRET_NAME, plaintext));
      } catch {
        logEvent(http, 'host_secret_write_fault', { name: T3_SECRET_NAME });
        return redirectTo('failed');
      }
      return redirectTo('connected');
    },

    /** One Mimir project's launch catalog: the systems holding a project with its remote. */
    catalog: async (project: string): Promise<T3Catalog> => {
      const setup = ready();
      if ('state' in setup) {
        return setup;
      }
      const connection = await readConnection(setup);
      if ('state' in connection) {
        return connection;
      }
      const { remote } = await engine.getNode({ id: project });
      try {
        const mcp = await session(setup, connection);
        const configured = await readEnvironment(mcp);
        const connected = { expiresAt: connection.expiresAt, state: 'connected' } as const;
        if (remote === null || remote === undefined) {
          return { ...connected, noRemote: true, systems: [] };
        }
        const peers = (await readPeers(mcp)).filter(
          (peer) => peer.environmentId !== configured.environmentId,
        );
        const systems = await Promise.all([
          readSystem(
            mcp,
            configured,
            remote,
            async () => configured.preferences?.defaultThreadEnvMode ?? null,
          ),
          ...peers.map(async (peer): Promise<T3System | undefined> =>
            peer.status === 'reachable'
              ? readSystem(
                  mcp,
                  peer,
                  remote,
                  async () =>
                    (await readEnvironment(mcp, peer.environmentId)).preferences
                      ?.defaultThreadEnvMode ?? null,
                )
              : { environmentId: peer.environmentId, label: peer.label, status: 'unreachable' },
          ),
        ]);
        return {
          ...connected,
          noRemote: false,
          systems: systems.filter((system) => system !== undefined),
        };
      } catch (error) {
        return failureState(error);
      }
    },

    /**
     * Connect T3: discover and pin T3's authorization server, register a
     * client, hold the pending authorization, and answer the URL to send the
     * browser to. Every refusal comes before the browser is sent anywhere.
     */
    connect: async (requestOrigin: string): Promise<T3ConnectResult> => {
      const setup = ready();
      if ('state' in setup) {
        return setup;
      }
      const origin = consoleOrigin(setup.consoleUrl, requestOrigin);
      if (origin === undefined) {
        return MIMIR_URL_UNSET;
      }
      const redirectUri = `${origin}${T3_CALLBACK_PATH}`;
      try {
        const server = await discoverAuthServer(http, setup.t3);
        const clientId = await registerClient(http, server, redirectUri);
        const entry = {
          clientId,
          createdAt: http.clock(),
          redirectUri,
          state: randomToken(),
          tokenEndpoint: server.tokenEndpoint,
          verifier: randomToken(),
        };
        pending.add(entry);
        return { state: 'authorize', url: authorizationUrl(setup.t3, server, entry) };
      } catch (error) {
        // Any failed check or answer here, a 401 included, is T3's metadata failing.
        if (error instanceof T3RequestError) {
          return { state: 'unreachable' };
        }
        throw error;
      }
    },

    /** The Devices page's read: the configured server's label and the token's expiry. */
    status: async (requestOrigin: string): Promise<T3Status> => {
      const setup = ready();
      if ('state' in setup) {
        return setup;
      }
      if (consoleOrigin(setup.consoleUrl, requestOrigin) === undefined) {
        return MIMIR_URL_UNSET;
      }
      const connection = await readConnection(setup);
      if ('state' in connection) {
        return connection;
      }
      try {
        const environment = await readEnvironment(await session(setup, connection));
        return { expiresAt: connection.expiresAt, label: environment.label, state: 'connected' };
      } catch (error) {
        return failureState(error);
      }
    },
  };
}

export type T3Adapter = ReturnType<typeof createT3Adapter>;

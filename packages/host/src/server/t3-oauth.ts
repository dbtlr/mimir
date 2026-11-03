import { createHash, randomBytes } from 'node:crypto';

import { z } from 'zod';

import { readJson, T3RequestError, t3Request } from './t3-http';
import type { T3Http } from './t3-http';

/*
 * The T3 Connect flow's OAuth steps (ADR 0040, Connect 1–6): pinned
 * discovery, dynamic registration of a public client, the pending
 * authorizations held in host memory, and the code exchange. Each failure is a
 * {@link T3RequestError}; nothing here logs a code, a verifier, or a token.
 */

/** The scopes Connect asks for; a grant without `orchestration:operate` cannot launch. */
export const T3_SCOPES = ['orchestration:read', 'orchestration:operate'] as const;
export const T3_OPERATE_SCOPE = 'orchestration:operate';

/** T3's MCP endpoint, which is also the OAuth resource. */
export const mcpResource = (t3: string) => `${t3}/mcp`;

/** The authorization server's endpoints, each checked to share T3's origin. */
export type T3AuthServer = {
  authorizationEndpoint: URL;
  registrationEndpoint: URL;
  tokenEndpoint: URL;
};

const protectedResourceSchema = z.looseObject({
  authorization_servers: z.array(z.string()),
  resource: z.string(),
});

const authServerSchema = z.looseObject({
  authorization_endpoint: z.string(),
  issuer: z.string(),
  registration_endpoint: z.string(),
  token_endpoint: z.string(),
});

async function getJson(http: T3Http, url: URL): Promise<unknown> {
  const response = await t3Request(http, url, {
    headers: { accept: 'application/json' },
    method: 'GET',
  });
  return readJson(response, url.pathname);
}

/** An endpoint on T3's own origin, or a failure: metadata cannot point the host elsewhere. */
function sameOrigin(t3: string, value: string, endpoint: string): URL {
  const url = URL.parse(value);
  if (url === null || url.origin !== t3) {
    throw new T3RequestError('unreachable', endpoint);
  }
  return url;
}

/**
 * Read and pin T3's OAuth metadata (Connect step 1). The protected resource
 * must be `<t3>/mcp` with `authorization_servers` exactly `[t3]`, and the
 * authorization server's issuer must equal `t3` (RFC 8414 §3.3) with every
 * endpoint on that origin. The first failed check stops the flow.
 */
export async function discoverAuthServer(http: T3Http, t3: string): Promise<T3AuthServer> {
  const resourcePath = '/.well-known/oauth-protected-resource/mcp';
  const resource = protectedResourceSchema.safeParse(
    await getJson(http, new URL(resourcePath, t3)),
  );
  if (
    !resource.success ||
    resource.data.resource !== mcpResource(t3) ||
    resource.data.authorization_servers.length !== 1 ||
    resource.data.authorization_servers[0] !== t3
  ) {
    throw new T3RequestError('unreachable', resourcePath);
  }
  const serverPath = '/.well-known/oauth-authorization-server';
  const server = authServerSchema.safeParse(await getJson(http, new URL(serverPath, t3)));
  if (!server.success || server.data.issuer !== t3) {
    throw new T3RequestError('unreachable', serverPath);
  }
  return {
    authorizationEndpoint: sameOrigin(t3, server.data.authorization_endpoint, serverPath),
    registrationEndpoint: sameOrigin(t3, server.data.registration_endpoint, serverPath),
    tokenEndpoint: sameOrigin(t3, server.data.token_endpoint, serverPath),
  };
}

/** Register a public client for one Connect (step 2); T3's client ids are stateless, so none is kept. */
export async function registerClient(
  http: T3Http,
  server: T3AuthServer,
  redirectUri: string,
): Promise<string> {
  const endpoint = server.registrationEndpoint;
  const response = await t3Request(http, endpoint, {
    body: JSON.stringify({
      client_name: 'Mimir',
      grant_types: ['authorization_code'],
      redirect_uris: [redirectUri],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    method: 'POST',
  });
  const client = z
    .looseObject({ client_id: z.string().min(1) })
    .safeParse(await readJson(response, endpoint.pathname));
  if (!client.success) {
    throw new T3RequestError('unreachable', endpoint.pathname);
  }
  return client.data.client_id;
}

/** One Connect awaiting its callback (step 3). */
export type PendingAuthorization = {
  state: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
  /** The pinned token endpoint, so the callback exchanges at the server discovery checked. */
  tokenEndpoint: URL;
  createdAt: number;
};

const PENDING_TTL_MS = 10 * 60 * 1000;
const PENDING_CAP = 16;

/**
 * The pending authorizations, in host memory: each lives 10 minutes and is
 * consumed by its first callback, and at most 16 are held, a new one evicting
 * the oldest.
 */
export function createPendingAuthorizations(clock: () => number) {
  const pending = new Map<string, PendingAuthorization>();
  const live = (entry: PendingAuthorization) => clock() - entry.createdAt < PENDING_TTL_MS;
  return {
    add: (entry: PendingAuthorization) => {
      for (const [state, held] of pending) {
        if (!live(held)) {
          pending.delete(state);
        }
      }
      while (pending.size >= PENDING_CAP) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) {
          break;
        }
        pending.delete(oldest);
      }
      pending.set(entry.state, entry);
    },
    /** Consume the authorization `state` names; unknown, used, and expired all answer undefined. */
    take: (state: string): PendingAuthorization | undefined => {
      const entry = pending.get(state);
      pending.delete(state);
      return entry !== undefined && live(entry) ? entry : undefined;
    },
  };
}

/** A fresh `state` or PKCE verifier: 256 random bits, base64url. */
export const randomToken = () => randomBytes(32).toString('base64url');

/** The S256 challenge for a PKCE verifier. */
export const pkceChallenge = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');

/** The authorization URL the browser is sent to (step 4). */
export function authorizationUrl(
  t3: string,
  server: T3AuthServer,
  entry: PendingAuthorization,
): string {
  const url = new URL(server.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', entry.clientId);
  url.searchParams.set('redirect_uri', entry.redirectUri);
  url.searchParams.set('code_challenge', pkceChallenge(entry.verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', entry.state);
  url.searchParams.set('resource', mcpResource(t3));
  url.searchParams.set('scope', T3_SCOPES.join(' '));
  return url.href;
}

/** What the token endpoint granted. */
export type T3Grant = { accessToken: string; expiresAt: number; scopes: string[] };

/** The longest grant the host keeps: ten years, in seconds. */
const MAX_EXPIRES_IN_S = 10 * 365 * 24 * 60 * 60;

const tokenSchema = z.looseObject({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive().max(MAX_EXPIRES_IN_S),
  scope: z.string().optional(),
  token_type: z.string().regex(/^bearer$/i),
});

/**
 * Exchange the code with the verifier (step 6). The granted scope is the
 * response's `scope`, or the requested scopes when it has none (RFC 6749 §5.1).
 */
export async function exchangeCode(
  http: T3Http,
  t3: string,
  entry: PendingAuthorization,
  code: string,
): Promise<T3Grant> {
  const endpoint = entry.tokenEndpoint;
  const response = await t3Request(http, endpoint, {
    body: new URLSearchParams({
      client_id: entry.clientId,
      code,
      code_verifier: entry.verifier,
      grant_type: 'authorization_code',
      redirect_uri: entry.redirectUri,
      resource: mcpResource(t3),
    }),
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    method: 'POST',
  });
  const token = tokenSchema.safeParse(await readJson(response, endpoint.pathname));
  if (!token.success) {
    throw new T3RequestError('unreachable', endpoint.pathname);
  }
  return {
    accessToken: token.data.access_token,
    expiresAt: http.clock() + token.data.expires_in * 1000,
    scopes:
      token.data.scope === undefined
        ? [...T3_SCOPES]
        : token.data.scope.split(' ').filter((scope) => scope !== ''),
  };
}

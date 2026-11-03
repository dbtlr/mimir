// A test double, not a test body: the T3 Code server the adapter tests talk to.
import { createHash } from 'node:crypto';

import type { HostSecretStore } from '@mimir/core';
import { z } from 'zod';

/*
 * A stub T3 Code 0.1.6 server as a fetch handler: the OAuth metadata,
 * registration, and token endpoints, and MCP's streamable HTTP JSON-RPC
 * (initialize, notifications/initialized, tools/call). Reply shapes follow
 * real T3 samples, trimmed. Each test changes one option to break one check.
 */

export type StubProject = {
  id: string;
  title: string;
  remoteUrl?: string;
  defaultModelSelection?: { instanceId: string; model: string } | null;
};

export type StubEnvironment = {
  label: string;
  defaultThreadEnvMode?: string;
  projects: StubProject[];
  /** The caller's runtime-mode ceiling on this system. */
  runtimeMode?: string;
  providers?: unknown[];
  /** Every tool call naming this environment fails. */
  failing?: boolean;
};

export type StubOptions = {
  origin: string;
  configured: string;
  environments: Record<string, StubEnvironment>;
  /** Peers T3 lists, or `absent` when linked environments are off. */
  links?: { environmentId: string; label: string; status: string }[] | 'absent';
  issuer?: string;
  resource?: string;
  authorizationServers?: readonly string[];
  /** The origin T3's metadata names its endpoints on. */
  endpointOrigin?: string;
  /** Answer the protected-resource metadata with a redirect. */
  redirectMetadata?: boolean;
  registrationStatus?: number;
  tokenStatus?: number;
  /** The token response's `scope`; null leaves it out. */
  grantedScope?: string | null;
  sessionId?: string;
  /** Answer JSON-RPC requests as single-event SSE streams. */
  sse?: boolean;
  /** Projects per `t3_project_list` page. */
  pageSize?: number;
};

const rpcSchema = z.looseObject({
  id: z.number().optional(),
  method: z.string(),
  params: z
    .looseObject({
      arguments: z.record(z.string(), z.unknown()).optional(),
      name: z.string().optional(),
    })
    .optional(),
});

export const STUB_ACCESS_TOKEN = 'stub-access-token-7f3a';

/** A recorded request: method, URL, and body text. */
export type StubRequest = { method: string; url: string; body: string; headers: Headers };

const json = (body: unknown, init: ResponseInit = {}) => Response.json(body, init);

export function stubT3(options: StubOptions) {
  const requests: StubRequest[] = [];
  const codes = new Map<string, { challenge: string; clientId: string; redirectUri: string }>();
  const state = { acceptToken: true, codeCounter: 0 };
  const { origin } = options;
  const endpoints = options.endpointOrigin ?? origin;

  const toolResult = (name: string, args: Record<string, unknown>) => {
    const environmentId =
      typeof args.environmentId === 'string' ? args.environmentId : options.configured;
    const environment = options.environments[environmentId];
    if (environment === undefined || environment.failing === true) {
      return { content: [{ text: 'environment unavailable', type: 'text' }], isError: true };
    }
    let payload: unknown;
    if (name === 't3_environment_read') {
      payload = {
        environmentId,
        label: environment.label,
        platform: { os: 'darwin' },
        preferences: { defaultThreadEnvMode: environment.defaultThreadEnvMode ?? 'worktree' },
        serverVersion: '0.1.6',
      };
    } else if (name === 't3_environment_links') {
      payload = {
        environmentId,
        links: (options.links === 'absent' ? [] : (options.links ?? [])).map(
          ({ environmentId: id, label, status }) => ({
            access: 'full-access',
            environmentId: id,
            expiresAt: '2026-12-01T00:00:00.000Z',
            label,
            lastError: null,
            status,
          }),
        ),
      };
    } else if (name === 't3_project_list') {
      const size = options.pageSize ?? 100;
      const start = typeof args.cursor === 'number' ? args.cursor : 0;
      const page = environment.projects.slice(start, start + size);
      payload = {
        nextCursor: start + size < environment.projects.length ? start + size : null,
        projects: page.map((project) => ({
          defaultModelSelection: project.defaultModelSelection ?? null,
          id: project.id,
          repositoryIdentity:
            project.remoteUrl === undefined
              ? null
              : {
                  canonicalKey: 'github.com/dbtlr/mimir',
                  locator: {
                    remoteName: 'origin',
                    remoteUrl: project.remoteUrl,
                    source: 'git-remote',
                  },
                },
          title: project.title,
        })),
      };
    } else if (name === 'orchestrator_capabilities') {
      payload = {
        interactionMode: 'default',
        providers: environment.providers ?? [],
        runtimeMode: environment.runtimeMode ?? 'full-access',
      };
    } else {
      return undefined;
    }
    return { content: [{ text: JSON.stringify(payload), type: 'text' }] };
  };

  const rpcReply = (message: unknown) =>
    options.sse === true
      ? new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        })
      : json(message);

  const mcp = async (request: Request, body: string) => {
    if (
      request.headers.get('authorization') !== `Bearer ${STUB_ACCESS_TOKEN}` ||
      !state.acceptToken
    ) {
      return new Response('unauthorized', { status: 401 });
    }
    const message = rpcSchema.parse(JSON.parse(body));
    if (message.method === 'initialize') {
      const reply = rpcReply({
        id: message.id,
        jsonrpc: '2.0',
        result: {
          capabilities: { tools: {} },
          protocolVersion: '2025-06-18',
          serverInfo: { name: 't3' },
        },
      });
      if (options.sessionId !== undefined) {
        reply.headers.set('mcp-session-id', options.sessionId);
      }
      return reply;
    }
    if (
      options.sessionId !== undefined &&
      request.headers.get('mcp-session-id') !== options.sessionId
    ) {
      return new Response('missing session', { status: 400 });
    }
    if (message.method === 'notifications/initialized') {
      return new Response(null, { status: 202 });
    }
    const name = String(message.params?.name);
    if (name === 't3_environment_links' && options.links === 'absent') {
      return rpcReply({
        error: { code: -32602, message: 'Tool not found' },
        id: message.id,
        jsonrpc: '2.0',
      });
    }
    const result = toolResult(name, message.params?.arguments ?? {});
    return result === undefined
      ? rpcReply({
          error: { code: -32602, message: 'Tool not found' },
          id: message.id,
          jsonrpc: '2.0',
        })
      : rpcReply({ id: message.id, jsonrpc: '2.0', result });
  };

  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const body = request.method === 'GET' ? '' : await request.text();
    requests.push({ body, headers: request.headers, method: request.method, url: request.url });
    const url = new URL(request.url);
    if (url.origin !== origin) {
      throw new TypeError('fetch failed');
    }
    switch (url.pathname) {
      case '/.well-known/oauth-protected-resource/mcp': {
        return options.redirectMetadata === true
          ? new Response(null, { headers: { location: 'https://elsewhere.example/' }, status: 302 })
          : json({
              authorization_servers: options.authorizationServers ?? [origin],
              resource: options.resource ?? `${origin}/mcp`,
              scopes_supported: ['orchestration:read', 'orchestration:operate'],
            });
      }
      case '/.well-known/oauth-authorization-server': {
        return json({
          authorization_endpoint: `${endpoints}/oauth/mcp/authorize`,
          authorization_response_iss_parameter_supported: true,
          code_challenge_methods_supported: ['S256'],
          issuer: options.issuer ?? origin,
          registration_endpoint: `${endpoints}/oauth/mcp/register`,
          token_endpoint: `${endpoints}/oauth/mcp/token`,
          token_endpoint_auth_methods_supported: ['none'],
        });
      }
      case '/oauth/mcp/register': {
        if (options.registrationStatus !== undefined) {
          return json({ error: 'invalid_client_metadata' }, { status: options.registrationStatus });
        }
        const metadata = z
          .looseObject({ redirect_uris: z.array(z.string()) })
          .parse(JSON.parse(body));
        return json({ client_id: `client-for:${metadata.redirect_uris[0]}` }, { status: 201 });
      }
      case '/oauth/mcp/token': {
        const form = new URLSearchParams(body);
        const issued = codes.get(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        if (
          options.tokenStatus !== undefined ||
          issued === undefined ||
          createHash('sha256').update(verifier).digest('base64url') !== issued.challenge ||
          form.get('client_id') !== issued.clientId ||
          form.get('redirect_uri') !== issued.redirectUri ||
          form.get('resource') !== `${origin}/mcp` ||
          form.get('grant_type') !== 'authorization_code'
        ) {
          return json({ error: 'invalid_grant' }, { status: options.tokenStatus ?? 400 });
        }
        codes.delete(form.get('code') ?? '');
        return json({
          access_token: STUB_ACCESS_TOKEN,
          expires_in: 2_592_000,
          token_type: 'Bearer',
          ...(options.grantedScope === null
            ? {}
            : { scope: options.grantedScope ?? 'orchestration:read orchestration:operate' }),
        });
      }
      case '/mcp': {
        return mcp(request, body);
      }
      default: {
        return new Response('not found', { status: 404 });
      }
    }
  };

  return {
    /**
     * Play the operator approving on T3's screen: read the authorization URL
     * and answer the callback URL T3 would send the browser to.
     */
    approve(authorizeUrl: string, query: Record<string, string> = {}): string {
      const url = new URL(authorizeUrl);
      state.codeCounter += 1;
      const code = `stub-code-${String(state.codeCounter)}`;
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      codes.set(code, {
        challenge: url.searchParams.get('code_challenge') ?? '',
        clientId: url.searchParams.get('client_id') ?? '',
        redirectUri,
      });
      const callback = new URL(redirectUri);
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', url.searchParams.get('state') ?? '');
      callback.searchParams.set('iss', origin);
      for (const [key, value] of Object.entries(query)) {
        if (value === '') {
          callback.searchParams.delete(key);
        } else {
          callback.searchParams.set(key, value);
        }
      }
      return callback.href;
    },
    fetch,
    /** Every request the adapter sent, in order. */
    requests,
    /** Make T3 refuse the saved token from now on, as after it revokes it. */
    revokeToken() {
      state.acceptToken = false;
    },
  };
}

/** An in-memory host-secret store that counts its writes. */
export function memorySecrets(): HostSecretStore & { rows: Map<string, string>; writes: number } {
  const rows = new Map<string, string>();
  const store = {
    read: async (name: string) => rows.get(name),
    remove: async (name: string) => {
      rows.delete(name);
    },
    rows,
    write: async (name: string, sealed: string) => {
      store.writes += 1;
      rows.set(name, sealed);
    },
    writes: 0,
  };
  return store;
}

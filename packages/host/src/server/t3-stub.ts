// A test double, not a test body: the T3 Code server the adapter tests talk to.
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

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
  /** Every tool call naming this environment fails as an `isError` result. */
  failing?: boolean;
  /** Every tool call naming this environment answers `401`. */
  rejecting?: boolean;
  /** Every `t3_project_list` page names a next cursor, so the list never ends. */
  endlessPages?: boolean;
};

export type StubOptions = {
  origin: string;
  configured: string;
  environments: Record<string, StubEnvironment>;
  /** Peers T3 lists, or `absent` when linked environments are off. */
  links?: { environmentId: string; label: string; status: string }[] | 'absent';
  /** Make `t3_environment_links` fail: an `isError` result, or a JSON-RPC error. */
  linksError?:
    | 'internal'
    | 'invalid_params'
    | 'is_error'
    | 'method_not_found'
    | 'other_not_found'
    | 'other_tool_not_found';
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
  /** The token response's `expires_in`; 30 days unless set. */
  expiresIn?: unknown;
  /** The token response's `token_type`; `Bearer` unless set. */
  tokenType?: string;
  /** The protocol version T3 answers on initialize. */
  protocolVersion?: string;
  /** Answer every JSON-RPC request under another id. */
  mismatchedReplyId?: boolean;
  sessionId?: string;
  /** Answer JSON-RPC requests as single-event SSE streams. */
  sse?: boolean;
  /** Projects per `t3_project_list` page. */
  pageSize?: number;
  /** How `t3_thread_launch` answers at first; `setLaunchReply` changes it. */
  launchReply?: StubLaunchReply;
  /** Milliseconds `t3_thread_launch` takes before it answers. */
  launchDelayMs?: number;
  /** Tools this T3 does not expose: each answers as T3 0.1.6 answers an unknown tool. */
  missingTools?: readonly string[];
};

/**
 * How `t3_thread_launch` answers: with the thread (`answer`), a tool error
 * (`is_error`), a reply without a `threadId` (`no_thread`), or, after making
 * the thread, no reply at all: the connection drops (`drop`) or the request
 * hangs until its timeout aborts it (`hang`).
 */
export type StubLaunchReply =
  | 'answer'
  | 'drop'
  | 'hang'
  | 'is_error'
  | 'no_thread'
  | 'unknown_tool';

/** The text of the stub's launch refusal: T3's words, which never reach a log or the console. */
export const STUB_LAUNCH_REFUSAL = "Branch 'feature/taken' already exists";

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

/**
 * What T3 0.1.6 answers a `tools/call` naming a tool it does not expose (its
 * Effect MCP server maps `ToolNotFound` to InvalidParams): a JSON-RPC error.
 */
const unknownTool = (name: string) => ({ code: -32602, message: `Tool '${name}' not found` });

export function stubT3(options: StubOptions) {
  const requests: StubRequest[] = [];
  const codes = new Map<string, { challenge: string; clientId: string; redirectUri: string }>();
  const state: { acceptToken: boolean; codeCounter: number; launchReply: StubLaunchReply } = {
    acceptToken: true,
    codeCounter: 0,
    launchReply: options.launchReply ?? 'answer',
  };
  /** Each `t3_thread_launch` call's arguments, in order. */
  const launches: Record<string, unknown>[] = [];
  /** The thread made for each `clientRequestId`: T3 answers the same thread for the same id. */
  const threads = new Map<string, string>();
  const { origin } = options;
  const endpoints = options.endpointOrigin ?? origin;

  const toolResult = (name: string, args: Record<string, unknown>) => {
    const environmentId =
      typeof args.environmentId === 'string' ? args.environmentId : options.configured;
    const environment = options.environments[environmentId];
    if (environment === undefined || environment.failing === true) {
      return { content: [{ text: 'environment unavailable', type: 'text' }], isError: true };
    }
    if (environment.rejecting === true) {
      return 'rejected' as const;
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
        nextCursor:
          environment.endlessPages === true || start + size < environment.projects.length
            ? start + size
            : null,
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

  const rpcReply = (reply: { id?: number } & Record<string, unknown>) => {
    const message =
      options.mismatchedReplyId === true ? { ...reply, id: (reply.id ?? 0) + 1000 } : reply;
    return options.sse === true
      ? new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        })
      : json(message);
  };

  const linksFailure = (id: number | undefined) => {
    switch (options.linksError) {
      case 'internal': {
        return rpcReply({ error: { code: -32603, message: 'internal error' }, id, jsonrpc: '2.0' });
      }
      case 'invalid_params': {
        return rpcReply({
          error: { code: -32602, message: 'Invalid arguments' },
          id,
          jsonrpc: '2.0',
        });
      }
      case 'other_not_found': {
        return rpcReply({
          error: { code: -32602, message: 'Project not found' },
          id,
          jsonrpc: '2.0',
        });
      }
      case 'other_tool_not_found': {
        return rpcReply({
          error: { code: -32602, message: "Tool 'other_tool' not found" },
          id,
          jsonrpc: '2.0',
        });
      }
      case 'method_not_found': {
        return rpcReply({
          error: { code: -32601, message: 'Method not found' },
          id,
          jsonrpc: '2.0',
        });
      }
      case 'is_error': {
        return rpcReply({
          id,
          jsonrpc: '2.0',
          // Well-formed links data, so only the isError flag marks the read failed.
          result: {
            content: [
              {
                text: JSON.stringify({ environmentId: options.configured, links: [] }),
                type: 'text',
              },
            ],
            isError: true,
          },
        });
      }
      default: {
        return undefined;
      }
    }
  };

  /** `t3_thread_launch`: make (or find) the thread for the request id, then answer as set. */
  const launch = async (
    id: number | undefined,
    args: Record<string, unknown>,
    signal: AbortSignal | null | undefined,
  ) => {
    launches.push(args);
    const environmentId =
      typeof args.environmentId === 'string' ? args.environmentId : options.configured;
    const environment = options.environments[environmentId];
    if (environment?.rejecting === true) {
      return new Response('unauthorized', { status: 401 });
    }
    if (environment === undefined || environment.failing === true) {
      return rpcReply({
        id,
        jsonrpc: '2.0',
        result: { content: [{ text: 'environment unavailable', type: 'text' }], isError: true },
      });
    }
    if (state.launchReply === 'is_error') {
      return rpcReply({
        id,
        jsonrpc: '2.0',
        result: { content: [{ text: STUB_LAUNCH_REFUSAL, type: 'text' }], isError: true },
      });
    }
    if (state.launchReply === 'unknown_tool') {
      return rpcReply({
        error: { code: -32602, message: "Tool 't3_thread_launch' not found" },
        id,
        jsonrpc: '2.0',
      });
    }
    if (options.launchDelayMs !== undefined) {
      await sleep(options.launchDelayMs);
    }
    const key = String(args.clientRequestId);
    const threadId = threads.get(key) ?? `thread-${String(threads.size + 1)}`;
    threads.set(key, threadId);
    if (state.launchReply === 'drop') {
      throw new TypeError('fetch failed');
    }
    if (state.launchReply === 'hang') {
      await once(signal ?? new EventTarget(), 'abort');
      throw new Error('aborted');
    }
    const payload = {
      environmentId,
      link: `t3-thread://${environmentId}/${threadId}`,
      projectId: args.projectId,
      ...(state.launchReply === 'no_thread' ? {} : { threadId }),
    };
    return rpcReply({
      id,
      jsonrpc: '2.0',
      result: { content: [{ text: JSON.stringify(payload), type: 'text' }] },
    });
  };

  const mcp = async (request: Request, body: string, signal: AbortSignal | null | undefined) => {
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
          protocolVersion: options.protocolVersion ?? '2025-06-18',
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
    if (options.missingTools?.includes(name) === true) {
      return rpcReply({ error: unknownTool(name), id: message.id, jsonrpc: '2.0' });
    }
    if (name === 't3_thread_launch') {
      return launch(message.id, message.params?.arguments ?? {}, signal);
    }
    if (name === 't3_environment_links') {
      if (options.links === 'absent') {
        return rpcReply({ error: unknownTool(name), id: message.id, jsonrpc: '2.0' });
      }
      const failure = linksFailure(message.id);
      if (failure !== undefined) {
        return failure;
      }
    }
    const result = toolResult(name, message.params?.arguments ?? {});
    if (result === 'rejected') {
      return new Response('unauthorized', { status: 401 });
    }
    return result === undefined
      ? rpcReply({ error: unknownTool(name), id: message.id, jsonrpc: '2.0' })
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
          expires_in: options.expiresIn ?? 2_592_000,
          token_type: options.tokenType ?? 'Bearer',
          ...(options.grantedScope === null
            ? {}
            : { scope: options.grantedScope ?? 'orchestration:read orchestration:operate' }),
        });
      }
      case '/mcp': {
        return mcp(request, body, init.signal);
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
    /** Each `t3_thread_launch` call's arguments, in order. */
    launches,
    /** Every request the adapter sent, in order. */
    requests,
    /** Make T3 refuse the saved token from now on, as after it revokes it. */
    revokeToken() {
      state.acceptToken = false;
    },
    /** Change how `t3_thread_launch` answers from now on. */
    setLaunchReply(reply: StubLaunchReply) {
      state.launchReply = reply;
    },
    /** The thread made for each `clientRequestId`. */
    threads,
  };
}

/** An in-memory host-secret store that counts its writes. */
export function memorySecrets(): HostSecretStore & { rows: Map<string, string>; writes: number } {
  const rows = new Map<string, string>();
  const store = {
    read: async (name: string) => rows.get(name),
    rows,
    write: async (name: string, sealed: string) => {
      store.writes += 1;
      rows.set(name, sealed);
    },
    writes: 0,
  };
  return store;
}

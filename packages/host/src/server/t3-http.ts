/*
 * The T3 adapter's outbound HTTP (ADR 0040): every request has a timeout and
 * follows no redirect, and every failure becomes a {@link T3RequestError} whose
 * message names only the endpoint and the HTTP status. Logs follow the same
 * rule: never a body, a code, a verifier, or a token.
 */

/** The fetch the adapter calls through; tests pass a stub T3. */
export type T3Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** The adapter's outbound dependencies. */
export type T3Http = {
  fetch: T3Fetch;
  log: (line: string) => void;
  clock: () => number;
  /** Milliseconds each request may take, its body included. */
  timeoutMs: number;
};

/**
 * Why a T3 request failed: `rejected` is T3's `401`; `unknown_tool` is T3
 * saying it exposes no such tool; `refused` is a tool error (`isError`) from
 * `t3_thread_launch`, which T3 answers the same on every try; `unreachable` is
 * everything else (no answer, a timeout, a redirect, another status, another
 * JSON-RPC error, another tool's failed result, or a reply that fails its
 * checks).
 */
export type T3FailureKind = 'refused' | 'rejected' | 'unknown_tool' | 'unreachable';

/** A failed T3 request. Its message names the endpoint and status alone. */
export class T3RequestError extends Error {
  readonly kind: T3FailureKind;

  constructor(kind: T3FailureKind, endpoint: string, status?: number) {
    super(`T3 ${endpoint} ${status === undefined ? kind : `answered ${String(status)}`}`);
    this.name = 'T3RequestError';
    this.kind = kind;
  }
}

/** Log one adapter event as a JSON line, with its time. */
export function logEvent(
  http: Pick<T3Http, 'clock' | 'log'>,
  event: string,
  fields: Record<string, number | string> = {},
): void {
  http.log(JSON.stringify({ event, ...fields, time: new Date(http.clock()).toISOString() }));
}

/**
 * Send one request to T3. A redirect is never followed: with `manual`, a 3xx
 * (or the opaque redirect a browser-like fetch returns) is a failure like any
 * other non-2xx status. `endpoint` is the path the logs and errors name.
 */
export async function t3Request(
  http: T3Http,
  url: URL,
  init: RequestInit,
  endpoint: string = url.pathname,
  detail: Record<string, string> = {},
): Promise<Response> {
  let response: Response;
  try {
    response = await http.fetch(url.href, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(http.timeoutMs),
    });
  } catch {
    logEvent(http, 't3_request_failed', { endpoint, ...detail });
    throw new T3RequestError('unreachable', endpoint);
  }
  if (response.status >= 200 && response.status < 300) {
    return response;
  }
  await response.body?.cancel().catch(() => undefined);
  logEvent(http, 't3_request_failed', { endpoint, status: response.status, ...detail });
  throw new T3RequestError(
    response.status === 401 ? 'rejected' : 'unreachable',
    endpoint,
    response.status,
  );
}

/** Read a reply body as JSON; a body that does not parse fails as `unreachable`. */
export async function readJson(response: Response, endpoint: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new T3RequestError('unreachable', endpoint);
  }
}

/** The T3 tools the adapter may call: a fixed list, never a name from the browser. */
export type T3Tool =
  | 'orchestrator_capabilities'
  | 't3_environment_links'
  | 't3_environment_read'
  | 't3_project_list'
  | 't3_thread_launch';

/** A JSON value the adapter sends as a tool argument. */
export type T3JsonValue =
  | boolean
  | number
  | string
  | null
  | T3JsonValue[]
  | { [key: string]: T3JsonValue };

/**
 * One MCP session over streamable HTTP: initialized, then reused for each tool
 * call. A call may set its own timeout; otherwise it takes the session's.
 */
export type McpSession = {
  call: (tool: T3Tool, args: Record<string, T3JsonValue>, timeoutMs?: number) => Promise<unknown>;
};

const MCP_PROTOCOL_VERSION = '2025-06-18';

type RpcMessage = { id?: unknown; result?: unknown; error?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** The reply to request `id`: a JSON body, or the matching event of a single-event SSE stream. */
async function readRpcReply(response: Response, id: number, endpoint: string): Promise<RpcMessage> {
  const type = response.headers.get('content-type') ?? '';
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new T3RequestError('unreachable', endpoint);
  }
  const candidates: unknown[] = [];
  try {
    if (type.includes('text/event-stream')) {
      for (const event of text.split(/\r?\n\r?\n/)) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data !== '') {
          candidates.push(JSON.parse(data));
        }
      }
    } else {
      candidates.push(JSON.parse(text));
    }
  } catch {
    throw new T3RequestError('unreachable', endpoint);
  }
  const reply = candidates.map(asRecord).find((message) => message?.id === id);
  if (reply === undefined) {
    throw new T3RequestError('unreachable', endpoint);
  }
  return reply;
}

/**
 * Whether a JSON-RPC error says the tool does not exist. T3 0.1.6's MCP server
 * answers a `tools/call` for a tool it does not expose (as `t3_environment_links`
 * with linked environments off) with InvalidParams, `-32602`, and the message
 * `Tool '<name>' not found`. Since `-32602` also covers bad arguments and other
 * missing things, it counts only with exactly that message for the tool called;
 * `-32601` (no such method) counts too, for a server with no tools at all.
 */
function isUnknownTool(error: unknown, tool: T3Tool | undefined): boolean {
  const record = asRecord(error);
  return (
    record?.code === -32601 ||
    (tool !== undefined && record?.code === -32602 && record.message === `Tool '${tool}' not found`)
  );
}

/**
 * A tool result's payload: `structuredContent` when T3 sends an object there,
 * else the JSON in its first text content. A result marked `isError` is a
 * failed read, `unreachable`, like any other bad reply, except from
 * `t3_thread_launch`, where it is T3 refusing the launch: `refused`.
 */
function toolPayload(result: unknown, endpoint: string, tool: T3Tool): unknown {
  const record = asRecord(result);
  if (record === undefined) {
    throw new T3RequestError('unreachable', endpoint);
  }
  if (record.isError === true) {
    throw new T3RequestError(tool === 't3_thread_launch' ? 'refused' : 'unreachable', endpoint);
  }
  if (asRecord(record.structuredContent) !== undefined) {
    return record.structuredContent;
  }
  const content = Array.isArray(record.content) ? record.content : [];
  const text = content.map(asRecord).find((item) => item?.type === 'text')?.text;
  if (typeof text !== 'string') {
    throw new T3RequestError('unreachable', endpoint);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new T3RequestError('unreachable', endpoint);
  }
}

/**
 * Open an MCP session at `mcpUrl` with a bearer token: `initialize`, then
 * `notifications/initialized`. It carries `Mcp-Session-Id` when T3 returns
 * one, and the protocol version T3 chose.
 */
export async function openMcpSession(
  http: T3Http,
  mcpUrl: URL,
  token: string,
  clientVersion: string,
): Promise<McpSession> {
  const endpoint = mcpUrl.pathname;
  // What T3 answers on initialize, carried on every later request.
  const negotiated: { sessionId?: string; protocolVersion?: string } = {};
  let nextId = 0;
  const post = async (message: Record<string, unknown>, tool?: T3Tool, timeoutMs?: number) => {
    const headers: Record<string, string> = {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    if (negotiated.sessionId !== undefined) {
      headers['mcp-session-id'] = negotiated.sessionId;
    }
    if (negotiated.protocolVersion !== undefined) {
      headers['mcp-protocol-version'] = negotiated.protocolVersion;
    }
    const response = await t3Request(
      timeoutMs === undefined ? http : { ...http, timeoutMs },
      mcpUrl,
      { body: JSON.stringify({ jsonrpc: '2.0', ...message }), headers, method: 'POST' },
      endpoint,
      tool === undefined ? { method: String(message.method) } : { tool },
    );
    negotiated.sessionId = response.headers.get('mcp-session-id') ?? negotiated.sessionId;
    return response;
  };
  const request = async (
    method: string,
    params: Record<string, unknown>,
    tool?: T3Tool,
    timeoutMs?: number,
  ) => {
    nextId += 1;
    const id = nextId;
    const reply = await readRpcReply(
      await post({ id, method, params }, tool, timeoutMs),
      id,
      endpoint,
    );
    if (reply.error !== undefined) {
      logEvent(http, 't3_request_failed', {
        endpoint,
        ...(tool === undefined ? { method } : { tool }),
      });
      throw new T3RequestError(
        isUnknownTool(reply.error, tool) ? 'unknown_tool' : 'unreachable',
        endpoint,
      );
    }
    return reply.result;
  };
  const initialized = asRecord(
    await request('initialize', {
      capabilities: {},
      clientInfo: { name: 'mimir', version: clientVersion },
      protocolVersion: MCP_PROTOCOL_VERSION,
    }),
  );
  if (initialized === undefined) {
    throw new T3RequestError('unreachable', endpoint);
  }
  negotiated.protocolVersion =
    typeof initialized.protocolVersion === 'string'
      ? initialized.protocolVersion
      : MCP_PROTOCOL_VERSION;
  const notified = await post({ method: 'notifications/initialized' });
  await notified.body?.cancel().catch(() => undefined);
  return {
    call: async (tool, args, timeoutMs) =>
      toolPayload(
        await request('tools/call', { arguments: args, name: tool }, tool, timeoutMs),
        endpoint,
        tool,
      ),
  };
}

/**
 * Both MCP servers, driven in process for the capability and structured-content
 * parity tests: the old SDK server over a store, and Loom's generated server
 * over an Application on piped stdio. Test-only.
 */
import { PassThrough } from 'node:stream';

import { processHandle } from '@loomcli/core';
import type { Application } from '@loomcli/core';
import { buildMcpServer } from '@mimir/bin/src/mcp';
import type { Store } from '@mimir/core';
import { parseJson } from '@mimir/helpers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/** What a tool call answered, in the shape both servers share. */
export type ToolAnswer = {
  isError: boolean;
  /** The structured content: the old server's JSON text parsed, Loom's `structuredContent`. */
  structured: unknown;
  text: string;
};

/** A tool's input schema: each property's JSON Schema type, and the required names. */
export type ToolSchema = {
  properties: Record<string, { type?: string }>;
  required: string[];
};

type ListedTool = { name: string; inputSchema?: Partial<ToolSchema> };

const schemaOf = (tools: readonly ListedTool[], name: string): ToolSchema => {
  const tool = tools.find((one) => one.name === name);
  if (tool === undefined) {
    throw new Error(`no tool named ${name}`);
  }
  return {
    properties: tool.inputSchema?.properties ?? {},
    required: tool.inputSchema?.required ?? [],
  };
};

/** One MCP server a test calls tools on. */
export type McpSession = {
  /** Every tool name the server lists. */
  tools: () => Promise<string[]>;
  call: (name: string, args: Record<string, unknown>) => Promise<ToolAnswer>;
  /** A tool's input property names, as `tools/list` advertises them. */
  schema: (name: string) => Promise<ToolSchema>;
  close: () => Promise<void>;
};

/** A stream that is not a terminal. */
const pipe = { columns: undefined, isTTY: false, rows: undefined };

const PROTOCOL_META = {
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
};

type Reply = { error?: { message: string }; result?: Record<string, unknown> };

/** The text parts of a result's content, joined. */
function textOf(content: unknown): string {
  const parts = Array.isArray(content) ? content : [];
  return parts
    .map((part: { text?: unknown }) => (typeof part.text === 'string' ? part.text : ''))
    .join('');
}

/** The old server over `store`, its binding `bound`, on an in-memory transport. */
export async function oldMcpSession(store: Store, bound?: string): Promise<McpSession> {
  const server = buildMcpServer(store, '0.0.0', () => Promise.resolve(bound));
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'parity', version: '0.0.0' });
  await client.connect(clientSide);
  return {
    call: async (name, args) => {
      const result = await client.callTool({ arguments: args, name });
      const text = textOf(result.content);
      const isError = result.isError === true;
      return { isError, structured: isError ? undefined : parseJson(text), text };
    },
    close: async () => {
      await client.close();
    },
    schema: async (name) => schemaOf((await client.listTools()).tools, name),
    tools: async () => (await client.listTools()).tools.map((tool) => tool.name),
  };
}

/** Loom's server: `<app> mcp` run over piped stdio, one request at a time. */
export function loomMcpSession(app: Pick<Application, 'run'>): McpSession {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const replies = new Map<number, (reply: Reply) => void>();
  let buffered = '';
  stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines.filter((l) => l !== '')) {
      const message = parseJson<Reply & { id: number }>(line);
      replies.get(message.id)?.(message);
    }
  });
  const errors: Buffer[] = [];
  stderr.on('data', (chunk: Buffer) => errors.push(chunk));
  // run() sets the process exit code too; the test process keeps its own.
  const before = process.exitCode;
  const running = app.run({
    process: processHandle({
      argv: ['mcp'],
      env: { TERM: 'xterm-256color' },
      home: '',
      stderr,
      stdin,
      stdout,
      terminal: {
        stderr: pipe,
        stdin: { isTTY: false },
        stdout: pipe,
      },
    }),
  });
  let id = 0;
  const request = (method: string, params: Record<string, unknown>): Promise<Reply> => {
    id += 1;
    const mine = id;
    const { promise: answered, resolve } = Promise.withResolvers<Reply>();
    replies.set(mine, resolve);
    stdin.write(
      `${JSON.stringify({ id: mine, jsonrpc: '2.0', method, params: { _meta: PROTOCOL_META, ...params } })}\n`,
    );
    return answered;
  };
  const listed = async (): Promise<ListedTool[]> => {
    const { result } = await request('tools/list', {});
    const tools = result?.tools;
    return Array.isArray(tools) ? tools.map((tool: ListedTool) => tool) : [];
  };
  return {
    call: async (name, args) => {
      const { error, result } = await request('tools/call', { arguments: args, name });
      if (result === undefined) {
        throw new Error(`protocol error calling ${name}: ${error?.message ?? 'no result'}`);
      }
      return {
        isError: result.isError === true,
        structured: result.structuredContent,
        text: textOf(result.content),
      };
    },
    close: async () => {
      stdin.end();
      const exitCode = await running;
      process.exitCode = before ?? 0;
      const logged = Buffer.concat(errors).toString('utf8');
      if (exitCode !== 0 || logged !== '') {
        throw new Error(`mcp server ended with exit ${String(exitCode)}: ${logged}`);
      }
    },
    schema: async (name) => schemaOf(await listed(), name),
    tools: async () => (await listed()).map((tool) => tool.name),
  };
}

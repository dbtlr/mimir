import { parseJson } from '@mimir/helpers';
/**
 * The persistent Norn MCP client (MMR-141, ADR 0016): one `norn mcp`
 * subprocess per vault, spoken to over stdio via the official SDK — warm
 * cache, no per-call spawn. Mimir stays an MCP server to agents while being
 * an MCP client to Norn.
 *
 * Contract points this class encodes (docs/mcp-server.md, norn side):
 *
 * - **Calls are serialized.** Norn asks clients to await each response before
 *   the next call — enforced structurally with an internal queue, so no
 *   caller can pipeline, and mutation ordering is by construction.
 * - **Lazy spawn, reconnect-on-next-call.** The subprocess starts on first
 *   use. If it dies, the in-flight call fails with a typed error and the
 *   *next* call respawns — never an automatic in-flight retry, so a
 *   `confirm: true` mutation can't double-apply on an ambiguous failure.
 *   Read wrappers opt into one transparent retry (reads are safe to replay).
 * - **Results are the `structuredContent` payload** (observed against norn
 *   v0.41.0; the text content mirrors it as JSON). `isError` results raise a
 *   `validation` MimirError carrying norn's message.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { MimirError, invariant, validation } from '../core/errors';

/** The subset of the norn tool catalog the artifact path drives. */
export type NornToolName =
  | 'vault.find'
  | 'vault.count'
  | 'vault.get'
  | 'vault.new'
  | 'vault.set'
  | 'vault.edit'
  | 'vault.validate'
  | 'vault.describe';

/** `vault.find` / `vault.count` selection params (probed from the live catalog). */
export type NornSelection = {
  eq?: string[];
  not_eq?: string[];
  in?: string[];
  not_in?: string[];
  has?: string[];
  missing?: string[];
  contains?: string[];
  starts_with?: string[];
  ends_with?: string[];
  path?: string;
  text?: string;
};

export type NornFindArgs = NornSelection & {
  col?: string[];
  sort?: string;
  desc?: boolean;
  limit?: number;
  no_limit?: boolean;
};

export type NornDocument = {
  path: string;
  frontmatter?: Record<string, unknown>;
  [key: string]: unknown;
};

export type NornNewArgs = {
  path?: string;
  title?: string;
  field?: string[];
  field_json?: string[];
  body?: string;
  parents?: boolean;
  confirm?: boolean;
};

export type NornSetArgs = {
  target: string;
  set?: Record<string, unknown>;
  remove?: string[];
  body?: string;
  confirm?: boolean;
};

export type NornClientOptions = {
  vaultPath: string;
  /** The norn executable (default `norn` on PATH). */
  command?: string;
  /** Test seam: supply the transport instead of spawning a subprocess. */
  transportFactory?: () => Transport | Promise<Transport>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNornDocument(value: unknown): value is NornDocument {
  return isRecord(value) && typeof value.path === 'string';
}

/** The first text block of a tool result — norn's error carrier. */
function firstText(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      return block.text;
    }
  }
  return null;
}

export class NornClient {
  private readonly options: NornClientOptions;
  private session: Client | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: NornClientOptions) {
    this.options = options;
  }

  private async connect(): Promise<Client> {
    const transport = this.options.transportFactory
      ? await this.options.transportFactory()
      : new StdioClientTransport({
          args: ['mcp', '--cwd', this.options.vaultPath],
          command: this.options.command ?? 'norn',
        });
    const session = new Client({ name: 'mimir', version: '0' });
    // The SDK's lifecycle surface is these on-properties; there is no
    // addEventListener counterpart.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    session.onclose = () => {
      // The subprocess died (or closed): drop the session so the next call
      // respawns. In-flight calls fail through the SDK's own rejection.
      if (this.session === session) {
        this.session = null;
      }
    };
    await session.connect(transport);
    this.session = session;
    return session;
  }

  /** One serialized tool call. `retry` replays once on a connection-level failure. */
  private async call(
    name: NornToolName,
    args: Record<string, unknown>,
    retry: boolean,
  ): Promise<unknown> {
    const invoke = async (): Promise<unknown> => {
      const attempt = async (): Promise<unknown> => {
        const session = this.session ?? (await this.connect());
        return session.callTool({ arguments: args, name });
      };
      let result: unknown;
      try {
        result = await attempt();
      } catch (error) {
        if (error instanceof MimirError) {
          throw error;
        }
        this.session = null;
        if (!retry) {
          throw validation(
            `norn call ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
            'the norn subprocess may have died; the next call reconnects',
          );
        }
        result = await attempt();
      }
      return this.unwrap(name, result);
    };
    // Chain onto the tail so calls can never pipeline (norn's ordering
    // contract) — each caller still sees only its own failure, and a
    // predecessor's failure never poisons the queue.
    const previous = this.tail;
    const turn = (async () => {
      try {
        await previous;
      } catch {
        // the predecessor's caller already saw this failure
      }
      return invoke();
    })();
    this.tail = (async () => {
      try {
        await turn;
      } catch {
        // swallowed here only for the queue; `turn` carries it to the caller
      }
    })();
    return turn;
  }

  private unwrap(name: NornToolName, result: unknown): unknown {
    if (!isRecord(result)) {
      throw invariant(`norn ${name} returned a non-object tool result`);
    }
    if (result.isError === true) {
      const message = firstText(result.content) ?? 'norn returned an error with no message';
      throw validation(`norn ${name}: ${message}`);
    }
    if (result.structuredContent !== undefined) {
      return result.structuredContent;
    }
    const text = firstText(result.content);
    if (text !== null) {
      try {
        return parseJson(text);
      } catch {
        return text;
      }
    }
    throw invariant(`norn ${name} returned no structured content and no text`);
  }

  /** Shape-check a payload has the expected top-level array field. */
  private records(name: NornToolName, payload: unknown, field: string): unknown[] {
    if (isRecord(payload)) {
      const value = payload[field];
      if (Array.isArray(value)) {
        return value;
      }
    }
    throw invariant(`norn ${name} response is missing the "${field}" array`);
  }

  // ─── Read tools (safe to replay → one transparent reconnect retry) ───

  async find(args: NornFindArgs): Promise<NornDocument[]> {
    const payload = await this.call('vault.find', args, true);
    const documents = this.records('vault.find', payload, 'documents');
    if (!documents.every(isNornDocument)) {
      throw invariant('norn vault.find returned a document without a path');
    }
    return documents;
  }

  async count(args: NornSelection & { by?: string }): Promise<unknown> {
    return this.call('vault.count', args, true);
  }

  async get(targets: string[], col?: string[]): Promise<unknown[]> {
    const payload = await this.call('vault.get', { col, targets }, true);
    return this.records('vault.get', payload, 'records');
  }

  async validate(): Promise<unknown> {
    return this.call('vault.validate', {}, true);
  }

  async describe(): Promise<unknown> {
    return this.call('vault.describe', {}, true);
  }

  // ─── Mutation tools (never auto-retried — a confirmed write must not double-apply) ───

  async newDoc(args: NornNewArgs): Promise<unknown> {
    return this.call('vault.new', args, false);
  }

  async set(args: NornSetArgs): Promise<unknown> {
    return this.call('vault.set', args, false);
  }

  async edit(target: string, edits: unknown[], confirm: boolean): Promise<unknown> {
    return this.call('vault.edit', { confirm, edits, target }, false);
  }

  /** Close the session and its subprocess; the next call reconnects. */
  async close(): Promise<void> {
    const session = this.session;
    this.session = null;
    if (session !== null) {
      await session.close();
    }
  }
}

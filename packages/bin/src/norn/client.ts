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
 *   `validation` MimirError carrying norn's message; connection-level
 *   failures raise `invariant` (infra state, not a rejected input).
 *
 * Known, accepted window: a mutation issued between a subprocess death and
 * the SDK's onclose delivery fails with the ambiguous error even though the
 * send never reached norn. The ambiguity is irreducible in RPC-over-pipe
 * (the response-lost case is indistinguishable); the error hint tells the
 * caller to verify before re-issuing a confirm.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { MimirError } from '../core/errors';
import { invariant, validation } from '../core/errors';
import type { MigrationPlan } from './plan';

/** The subset of the norn tool catalog the artifact and node paths drive. */
export type NornToolName =
  | 'vault.find'
  | 'vault.count'
  | 'vault.get'
  | 'vault.new'
  | 'vault.set'
  | 'vault.edit'
  | 'vault.validate'
  | 'vault.describe'
  | 'vault.apply';

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
  /** Per-call timeout (default 5 minutes — the SDK's own 60s default would
   * doom a long validate/find on a large vault). */
  timeoutMs?: number;
  /** Test seam: supply the transport instead of spawning a subprocess. */
  transportFactory?: () => Transport | Promise<Transport>;
};

/** Norn ops are local; five minutes is generous without being unbounded. */
const DEFAULT_CALL_TIMEOUT_MS = 300_000;

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

  /**
   * Run a job with the queue's serialization guarantee (norn's
   * await-each-response contract): jobs never overlap, each caller sees only
   * its own failure, and a predecessor's failure never poisons the queue.
   * `close()` goes through here too, so shutdown can't race an in-flight
   * call or a connect.
   */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    const run = async (): Promise<T> => {
      try {
        await previous;
      } catch {
        // the predecessor's caller already saw that failure
      }
      return job();
    };
    const turn = run();
    this.tail = (async () => {
      try {
        await turn;
      } catch {
        // swallowed only for the queue; `turn` carries it to this caller
      }
    })();
    return turn;
  }

  /**
   * Drop (and best-effort close) a session after a call-level failure. The
   * error may not be a subprocess death — an SDK timeout or protocol error
   * leaves the child alive — so closing is what prevents an orphaned `norn
   * mcp` accumulating per failure.
   */
  private async discard(session: Client): Promise<void> {
    if (this.session === session) {
      this.session = null;
    }
    try {
      await session.close();
    } catch {
      // already dead — that's fine, dropping it was the point
    }
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

  /** A connection-level failure, typed: infra state, not a rejected input. */
  private connectionFailure(name: NornToolName, retry: boolean, error: unknown): MimirError {
    const detail = error instanceof Error ? error.message : String(error);
    return invariant(
      `norn call ${name} failed: ${detail}`,
      retry
        ? 'the norn subprocess may have died; the next call reconnects'
        : // A mutation's failure is ambiguous by construction (the response
          // was lost, not necessarily the write) — the caller must verify
          // before re-issuing a confirm.
          'the write may or may not have applied — verify before retrying; the next call reconnects',
    );
  }

  /** One serialized tool call. `retry` replays once on a connection-level failure.
   * `tolerateStructuredError` returns an `isError` result's structured payload
   * instead of throwing, for a caller that classifies it itself (see {@link unwrap}). */
  private async call(
    name: NornToolName,
    args: Record<string, unknown>,
    retry: boolean,
    tolerateStructuredError = false,
  ): Promise<unknown> {
    return this.enqueue(async () => {
      const attempt = async (): Promise<unknown> => {
        const session = this.session ?? (await this.connect());
        try {
          return await session.callTool({ arguments: args, name }, undefined, {
            timeout: this.options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
          });
        } catch (error) {
          // Not necessarily a death (timeout, protocol error) — close so a
          // still-alive child never leaks; the next attempt/call respawns.
          await this.discard(session);
          throw error;
        }
      };
      let result: unknown;
      try {
        result = await attempt();
      } catch (error) {
        if (!retry) {
          throw this.connectionFailure(name, retry, error);
        }
        try {
          result = await attempt();
        } catch (secondError) {
          throw this.connectionFailure(name, retry, secondError);
        }
      }
      return this.unwrap(name, result, tolerateStructuredError);
    });
  }

  private unwrap(name: NornToolName, result: unknown, tolerateStructuredError = false): unknown {
    if (!isRecord(result)) {
      throw invariant(`norn ${name} returned a non-object tool result`);
    }
    if (result.isError === true) {
      // norn 0.45.1 (NRN-219): a mutation that doesn't fully apply sets
      // `isError: true` but PRESERVES the `{ report }` payload. A caller that
      // classifies that report itself (applyPlan) takes it from here — but ONLY a
      // genuine apply report. A non-report error envelope (or none) still throws, so
      // norn's diagnostic text is never swallowed into a generic classification.
      if (
        tolerateStructuredError &&
        isRecord(result.structuredContent) &&
        'report' in result.structuredContent
      ) {
        return result.structuredContent;
      }
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

  /** `col` is comma-separated `norn get --col` syntax — dot-prefixed facets
   * (`.body`) opt heavy fields in; bare names select frontmatter fields. */
  async get(targets: string[], col?: string): Promise<unknown[]> {
    const payload = await this.call('vault.get', { col, targets }, true);
    return this.records('vault.get', payload, 'records');
  }

  /**
   * Read named body sections natively (`vault.get { section }`, NRN-102/NRN-173) —
   * norn slices each `## <heading>` with `edit`'s exact boundary semantics, so a
   * section read mirrors a section write. Returns the `records` array; each record
   * carries a `sections` map (heading → the section's raw markdown, heading line
   * included — decode with {@link import('./decode').pathAndSections}). A heading
   * missing/ambiguous in a document is warn-and-omitted for that document (the
   * record still returns, just without that key); the call never fails as a whole,
   * so it replaces the whole-`.body`-fetch-then-client-slice workaround (MMR-187).
   */
  async getSections(targets: string[], sections: string[]): Promise<unknown[]> {
    const payload = await this.call('vault.get', { section: sections, targets }, true);
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

  /**
   * Apply a whole {@link MigrationPlan} atomically (MMR-153) — the node write
   * path's single mutation per `transact`. `confirm: false` is norn's dry-run
   * (forecast, no write); `confirm: true` acquires the vault mutation lock and
   * executes every op. Never auto-retried: a confirmed batch must not
   * double-apply on an ambiguous failure.
   *
   * Returns norn's raw `ApplyReport` payload for the write path
   * ({@link runTransact}) to classify by `outcome`. A precondition refusal (CAS
   * drift) or partial failure carries a report whose `outcome` is
   * `refused`/`failed` and whose failed ops carry a structured `error.code`. norn
   * **0.45.1 (NRN-219)** sets `isError: true` on that not-applied result while
   * preserving the report, so this call passes `tolerateStructuredError` to take
   * the report from the `isError` path rather than throwing. (A genuine tool or
   * connection error, which carries no structured report, still throws.)
   *
   * `parents: true` (norn 0.45 / NRN-174) makes `create_document` auto-create a
   * missing parent directory — the first node of a new project no longer needs a
   * local `mkdirSync`, so the write path issues no direct filesystem writes (the
   * ADR 0018 invariant: Mimir talks to Norn, never touches the vault directly).
   */
  async applyPlan(plan: MigrationPlan, confirm: boolean): Promise<unknown> {
    return this.call('vault.apply', { confirm, parents: true, plan }, false, true);
  }

  /**
   * Close the session and its subprocess; the next call reconnects.
   * Serialized through the queue, so an in-flight call (and any connect it
   * started) completes first — a subprocess can't outlive a resolved close.
   */
  async close(): Promise<void> {
    return this.enqueue(async () => {
      const session = this.session;
      this.session = null;
      if (session !== null) {
        try {
          await session.close();
        } catch {
          // already dead — nothing left to shut down
        }
      }
    });
  }
}

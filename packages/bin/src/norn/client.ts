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
 *   failures raise `invariant` (infra state, not a rejected input). Two
 *   `isError`-with-structured-payload exceptions are handed back as data instead
 *   of thrown (see {@link unwrap}): an apply report (norn 0.45.1 / NRN-219) and a
 *   `vault.get` that didn't resolve its target/sections (norn 0.46 / NRN-214).
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
  | 'vault.get'
  | 'vault.new'
  | 'vault.set'
  | 'vault.validate'
  | 'vault.apply';

/** `vault.find` selection params (probed from the live catalog). */
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
  path?: string[];
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

export type NornSectionRead = { records: unknown[]; sectionFailures: string[] };

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
  /**
   * Ergonomic record surface for the fields to write. norn 0.47 (NRN-238) retired
   * `vault.set`'s map-shaped `set` param — the wire contract is now ordered
   * `KEY=JSON` tokens (`field_json`, the same shape `vault.new` takes). {@link set}
   * serializes this record into those tokens (`${key}=${JSON.stringify(value)}`);
   * mimir's usage has unique keys, so the map→ordered-token mapping is identical.
   */
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

/**
 * Is `error` the create-exclusive path collision — the only failure a `vault.new`
 * caller may safely retry (a concurrent create won the sequence)? Norn's `vault.new`
 * on an existing path fails with "destination already exists" (verified against
 * v0.41.0); the NornClient wraps it, so callers match the message text. The single
 * shared match every derived-seq store (artifacts, seeds) and migration uses.
 */
export function isPathCollision(error: unknown): boolean {
  return error instanceof Error && /already exists/i.test(error.message);
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
      // norn 0.46 (NRN-214): a `vault.get` whose target doesn't resolve, or whose
      // every `--section` heading misses, sets `isError: true` but PRESERVES the
      // structured read payload (`records`, `section_failures`, `notes`). Hand that
      // payload back so each read seam keeps its documented semantics: the
      // section-failure channel reports rather than aborts (triage's corrupt-anchor
      // quarantine), and an absent-doc lookup fails loud with a clean mimir-side
      // message off empty `records` — never norn's raw JSON blob. A genuine tool or
      // connection error carries no such payload and still throws below.
      if (
        name === 'vault.get' &&
        isRecord(result.structuredContent) &&
        ('records' in result.structuredContent || 'section_failures' in result.structuredContent)
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
   * missing or *ambiguous* (a hand-edited duplicate) in a document is
   * warn-and-omitted — absent from that record's `sections` map; if NONE of the
   * requested headings resolve for a document, that document is reported in the
   * response's `section_failures` and does not appear in `records` at all.
   *
   * This returns only `records`, so a warn-and-omitted section reads as empty
   * downstream — deliberate graceful degradation (ADR 0017): an ambiguous
   * `## History` reads empty rather than the retired slicer's arbitrary
   * first-of-two pick. The `section_failures` channel is dropped here; surfacing
   * it as a `mimir doctor` diagnostic (so the drop isn't silent) is MMR-239. The
   * call never fails as a whole, replacing the whole-`.body`-then-client-slice
   * workaround (MMR-187).
   */
  async getSections(targets: string[], sections: string[]): Promise<unknown[]> {
    return (await this.getSectionsResult(targets, sections)).records;
  }

  /** One section operation with both success records and failed physical targets.
   * Consumers that enforce logical identity need both channels from the same
   * cache refresh; `col` can opt frontmatter into those same records so type
   * validation does not reopen an ambiguity race with a second call. */
  async getSectionsResult(
    targets: string[],
    sections: string[],
    col?: string,
  ): Promise<NornSectionRead> {
    const args =
      col === undefined ? { section: sections, targets } : { col, section: sections, targets };
    const payload = await this.call('vault.get', args, true);
    const failures = isRecord(payload) ? payload.section_failures : undefined;
    const sectionFailures: string[] = [];
    if (Array.isArray(failures)) {
      for (const entry of failures) {
        if (typeof entry === 'string') {
          sectionFailures.push(entry);
        } else if (isRecord(entry) && typeof entry.path === 'string') {
          sectionFailures.push(entry.path);
        }
      }
    }
    return { records: this.records('vault.get', payload, 'records'), sectionFailures };
  }

  /**
   * The `section_failures` channel {@link getSections} drops (MMR-239): the paths
   * of documents where NONE of the requested headings resolved — a hand-edited
   * duplicate (ambiguous) or a missing heading — so the section read degrades to
   * empty (ADR 0017). `mimir doctor` surfaces these so the silent loss is
   * diagnosable. Each entry is decoded to a bare path string, tolerating either a
   * raw path or a `{ path }` object; an absent/empty channel yields `[]`.
   */
  async sectionFailures(targets: string[], sections: string[]): Promise<string[]> {
    return (await this.getSectionsResult(targets, sections)).sectionFailures;
  }

  async validate(): Promise<unknown> {
    return this.call('vault.validate', {}, true);
  }

  // ─── Mutation tools (never auto-retried — a confirmed write must not double-apply) ───

  async newDoc(args: NornNewArgs): Promise<unknown> {
    return this.call('vault.new', args, false);
  }

  async set(args: NornSetArgs): Promise<unknown> {
    // norn 0.47 (NRN-238): serialize the record-shaped `set` into the
    // `field_json` ordered `KEY=JSON` tokens the new wire contract requires (the
    // retired map param is silently ignored). `remove` and `body` pass through.
    const { set, ...rest } = args;
    const wire: Record<string, unknown> = { ...rest };
    if (set !== undefined) {
      wire.field_json = Object.entries(set).map(
        ([key, value]) => `${key}=${JSON.stringify(value)}`,
      );
    }
    return this.call('vault.set', wire, false);
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

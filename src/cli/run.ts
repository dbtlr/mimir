import { parseArgs } from "node:util";
import {
  CHEAP_FACETS,
  FACET_NAMES,
  type FacetName,
  type NodeView,
  PRIORITY_VALUES,
  type Priority,
  SIZE_VALUES,
  type SetResult,
  type Size,
} from "../contract";
import {
  type ListPredicate,
  formatIds,
  formatNodeJson,
  formatSetJson,
  formatSetJsonl,
  formatStatusJson,
  getNode,
  listNodes,
  nextTasks,
  statusOfNode,
} from "../core";
import type { Db } from "../core";
import { FULL_HELP, TERSE_HELP } from "./help";
import { type Io, renderRecords, renderStatus, renderTable } from "./render";
import { exitCodeFor, isRenderable, renderError, usage } from "./errors";

const FORMATS = ["table", "records", "ids", "json", "jsonl"] as const;
type Format = (typeof FORMATS)[number];

const LIST_PREDICATES: readonly ListPredicate[] = [
  "all",
  "ready",
  "awaiting",
  "blocked",
  "stale",
  "blocking",
  "orphaned",
];

const OPTIONS = {
  scope: { type: "string", short: "s" },
  priority: { type: "string", short: "p" },
  size: { type: "string" },
  predicate: { type: "string" },
  tag: { type: "string", short: "t" },
  type: { type: "string" },
  limit: { type: "string", short: "n" },
  col: { type: "string", multiple: true },
  format: { type: "string", short: "f" },
  ascii: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

/**
 * Run the CLI for one invocation. `argv` is the args after `mimir`; `db` is an
 * open, migrated database; `io` is the injected sink + presentation context.
 * Returns the process exit code.
 */
export async function runCli(argv: string[], db: Db, io: Io): Promise<number> {
  let values: {
    scope?: string;
    priority?: string;
    size?: string;
    predicate?: string;
    tag?: string;
    type?: string;
    limit?: string;
    col?: string[];
    format?: string;
    ascii?: boolean;
    help?: boolean;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const fmt = errorFormat(argv);
    renderError(usage(msg), fmt, io);
    if (fmt !== "json" && fmt !== "jsonl") io.error(TERSE_HELP);
    return 2;
  }

  const command = positionals[0];
  if (command === undefined || values.help === true) {
    io.write(argv.includes("--help") ? FULL_HELP : TERSE_HELP);
    return 0;
  }

  const ctx: Io = { ...io, plain: io.plain || values.ascii === true };

  try {
    switch (command) {
      case "next":
        return runSet(
          await nextTasks(db, {
            scope: values.scope,
            priority: parsePriority(values.priority),
            size: parseSize(values.size),
            limit: parseLimit(values.limit),
            facets: parseFacets(values.col),
          }),
          values.format,
          ctx,
        );
      case "list":
        return runSet(
          await listNodes(db, {
            scope: values.scope,
            predicate: parsePredicate(values.predicate),
            priority: parsePriority(values.priority),
            size: parseSize(values.size),
            tag: values.tag,
            limit: parseLimit(values.limit),
            facets: parseFacets(values.col),
          }),
          values.format,
          ctx,
        );
      case "get": {
        const id = requireId(positionals[1], "get");
        const facets = parseFacets(values.col);
        const node = await getNode(db, id, {
          facets: facets.length > 0 ? [...new Set([...CHEAP_FACETS, ...facets])] : undefined,
        });
        return renderSingle(node, values.format, ctx);
      }
      case "status": {
        const id = requireId(positionals[1], "status");
        const status = await statusOfNode(db, id);
        const format = pickFormat(values.format, "status", ctx);
        ctx.write(format === "json" ? formatStatusJson(status) : renderStatus(status, ctx));
        return 0;
      }
      default:
        throw usage(`unknown command: ${command}`);
    }
  } catch (error) {
    if (isRenderable(error)) {
      renderError(error, errorFormat(argv), ctx);
      return exitCodeFor(error);
    }
    throw error;
  }
}

/**
 * Determine the error rendering format from the raw argv. Returns "json" or
 * "jsonl" iff the user explicitly requested it, else "records" (human default).
 * Scanning raw argv avoids depending on the already-parsed values, which may
 * not be available when a parseArgs failure occurs.
 *
 * Handles both separate-token form (`--format json`) and equals form
 * (`--format=json`, `-f=json`).
 */
function errorFormat(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    // Equals form: --format=json or -f=json
    const eqMatch = /^(?:--format|-f)=(.+)$/.exec(arg);
    if (eqMatch) {
      const val = eqMatch[1];
      if (val === "json" || val === "jsonl") return val;
      continue;
    }
    // Separate-token form: --format json or -f json
    if ((arg === "-f" || arg === "--format") && i < argv.length - 1) {
      const val = argv[i + 1] ?? "";
      if (val === "json" || val === "jsonl") return val;
    }
  }
  return "records";
}

function runSet(result: SetResult<NodeView>, explicit: string | undefined, io: Io): number {
  const format = pickFormat(explicit, "set", io);
  switch (format) {
    case "ids":
      io.write(formatIds(result.items));
      break;
    case "json":
      io.write(formatSetJson(result));
      break;
    case "jsonl":
      io.write(formatSetJsonl(result.items));
      break;
    case "records":
      io.write(result.items.map((n) => renderRecords(n, io)).join("\n\n"));
      break;
    case "table":
      io.write(renderTable(result, io));
      break;
  }
  return 0;
}

function renderSingle(node: NodeView, explicit: string | undefined, io: Io): number {
  const format = pickFormat(explicit, "single", io);
  switch (format) {
    case "ids":
      io.write(node.id);
      break;
    case "json":
    case "jsonl":
      io.write(formatNodeJson(node));
      break;
    case "table":
      io.write(renderTable({ total: 1, returned: 1, startsAt: 0, items: [node] }, io));
      break;
    case "records":
      io.write(renderRecords(node, io));
      break;
  }
  return 0;
}

function pickFormat(
  explicit: string | undefined,
  kind: "set" | "single" | "status",
  io: Io,
): Format {
  if (explicit !== undefined) {
    if (!(FORMATS as readonly string[]).includes(explicit)) {
      throw usage(`unknown format: ${explicit} (expected ${FORMATS.join("|")})`);
    }
    return explicit as Format;
  }
  if (!io.isTTY) {
    return kind === "status" ? "json" : "ids";
  }
  if (kind === "set") return "table";
  return kind === "status" ? "json" : "records";
}

function requireId(id: string | undefined, command: string): string {
  if (id === undefined) {
    throw usage(`${command} requires a node id (KEY-seq)`);
  }
  return id;
}

function parseFacets(cols: string[] | undefined): FacetName[] {
  const facets: FacetName[] = [];
  for (const col of cols ?? []) {
    if (col.startsWith(".")) {
      const name = col.slice(1);
      if (!(FACET_NAMES as readonly string[]).includes(name)) {
        throw usage(`unknown facet: ${col}`);
      }
      facets.push(name as FacetName);
    }
  }
  return facets;
}

function parsePriority(value: string | undefined): Priority | undefined {
  if (value === undefined) return undefined;
  if (!(PRIORITY_VALUES as readonly string[]).includes(value)) {
    throw usage(`invalid priority: ${value} (expected ${PRIORITY_VALUES.join("|")})`);
  }
  return value as Priority;
}

function parseSize(value: string | undefined): Size | undefined {
  if (value === undefined) return undefined;
  if (!(SIZE_VALUES as readonly string[]).includes(value)) {
    throw usage(`invalid size: ${value} (expected ${SIZE_VALUES.join("|")})`);
  }
  return value as Size;
}

function parsePredicate(value: string | undefined): ListPredicate | undefined {
  if (value === undefined) return undefined;
  if (!(LIST_PREDICATES as readonly string[]).includes(value)) {
    throw usage(`invalid predicate: ${value} (expected ${LIST_PREDICATES.join("|")})`);
  }
  return value as ListPredicate;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) {
    throw usage(`invalid limit: ${value}`);
  }
  return n;
}

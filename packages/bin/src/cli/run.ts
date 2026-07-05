import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';

import { CHEAP_FACETS, FACET_NAMES, STATUS_SELECTOR_VALUES, VERDICT_VALUES } from '@mimir/contract';
import type {
  FacetName,
  FieldFilter,
  NodeView,
  SetResult,
  StatusSelector,
  VerdictSelector,
} from '@mimir/contract';
import { isMember } from '@mimir/helpers';

import {
  MimirError,
  emitWire,
  formatIds,
  formatSetJson,
  formatSetJsonl,
  formatStatusJson,
  getArtifact,
  getNode,
  listNodes,
  listProjects,
  nextTasks,
  nodeTree,
  parseFilterToken,
  parseIdentity,
  statusOfNode,
  treeToWire,
} from '../core';
import type { Db, Store } from '../core';
import { defaultVaultPath } from '../env';
import { cmdSelfUpdate, cmdService } from '../service';
import type { ServiceDeps } from '../service';
import { cmdVault } from '../vault/commands';
import type { VaultDeps } from '../vault/commands';
import { BINDING_FILE, writeBinding } from './binding';
import { exitCodeFor, isRenderable, renderError, renderWarnings, usage } from './errors';
import { FULL_HELP, TERSE_HELP, helpForCommand } from './help';
import { cmdMigrateArtifacts } from './migrate-artifacts';
import { cmdMigrateNodes } from './migrate-nodes';
import {
  cmdAbandon,
  cmdAnnotate,
  cmdArchive,
  cmdAttach,
  cmdBlock,
  cmdCreate,
  cmdDepend,
  cmdDone,
  cmdMove,
  cmdPark,
  cmdReopen,
  cmdReorder,
  cmdReturn,
  cmdStart,
  cmdSubmit,
  cmdTag,
  cmdUnarchive,
  cmdUnblock,
  cmdUndepend,
  cmdUnpark,
  cmdUntag,
  cmdUpdate,
} from './mutations';
import type { Ctx } from './mutations';
import { parsePriority, parseSize } from './parse';
import {
  FORMATS,
  renderArtifactDetail,
  renderNodeView,
  renderRecords,
  renderStatus,
  renderTable,
  renderTree,
} from './render';
import type { Format, Io } from './render';
import { resolveProject } from './resolve';
import { cmdSetup } from './setup';
import { SKILL_AGENTS, SKILL_FILES, skillDirFor } from './skill-assets';

// Deliberately grouped query-flags-then-write-flags (see the divider comment),
// not alphabetical — the operator cluster reads as a unit.
/* oxlint-disable sort-keys */
const OPTIONS = {
  scope: { short: 's', type: 'string' },
  priority: { short: 'p', type: 'string' },
  size: { type: 'string' },
  status: { type: 'string' },
  is: { multiple: true, type: 'string' },
  'not-is': { multiple: true, type: 'string' },
  eq: { multiple: true, type: 'string' },
  'not-eq': { multiple: true, type: 'string' },
  in: { multiple: true, type: 'string' },
  'not-in': { multiple: true, type: 'string' },
  has: { multiple: true, type: 'string' },
  missing: { multiple: true, type: 'string' },
  before: { multiple: true, type: 'string' },
  on: { multiple: true, type: 'string' },
  after: { multiple: true, type: 'string' },
  'not-before': { multiple: true, type: 'string' },
  'not-after': { multiple: true, type: 'string' },
  tag: { multiple: true, short: 't', type: 'string' },
  note: { type: 'string' },
  limit: { short: 'n', type: 'string' },
  col: { multiple: true, type: 'string' },
  format: { short: 'f', type: 'string' },
  ascii: { type: 'boolean' },
  help: { short: 'h', type: 'boolean' },
  // Write-surface flags — `--on` / `--before` / `--after` are shared with the
  // query date-ops above (multiple); the write verbs read the last value.
  to: { type: 'string' },
  parent: { type: 'string' },
  key: { type: 'string' },
  name: { type: 'string' },
  desc: { type: 'string' },
  summary: { type: 'string' },
  target: { type: 'string' },
  ref: { type: 'string' },
  file: { type: 'string' },
  link: { type: 'string' },
  project: { type: 'string' },
  top: { type: 'boolean' },
  bottom: { type: 'boolean' },
  title: { type: 'string' },
  yes: { short: 'y', type: 'boolean' },
  // skill install
  global: { type: 'boolean' },
  local: { type: 'boolean' },
  agent: { type: 'string' },
  // service flag
  port: { type: 'string' },
  // setup wizard (MMR-145)
  vault: { type: 'string' },
  'install-service': { type: 'boolean' },
  'install-snapshot': { type: 'boolean' },
  'snapshot-interval': { type: 'string' },
  upstream: { type: 'string' },
  // migrate artifacts (cutover, MMR-144)
  'dry-run': { type: 'boolean' },
  // self-update selectors (--tag reuses the multiple `tag` flag above,
  // last-wins like the other shared write-surface flags)
  next: { type: 'boolean' },
} as const;
/* oxlint-enable sort-keys */

/**
 * Per-invocation environment defaults resolved by the composition root —
 * the Project Binding scope (ADR 0011) and the directory `bind` writes into.
 * Injected so the CLI stays testable without touching the real cwd.
 */
export type Defaults = {
  scope?: string;
  cwd?: string;
  /** Real service/self-update edges; absent where supervision is unavailable (tests). */
  service?: ServiceDeps;
  /** Real vault edges (git snapshot); absent where the vault is unavailable (tests). */
  vault?: VaultDeps;
  /**
   * The DB schema migrator (`migrate schema`). Injected because it opens the
   * store UN-migrated to inspect/apply migrations, so it can't ride the normal
   * auto-migrating store provider; absent in tests that don't exercise it.
   */
  migrateSchema?: (sub: string | undefined) => Promise<number>;
};

/**
 * The effective `-s` scope: an explicit flag wins; the literal `all` is the
 * cross-project escape (a key is uppercase, so `all` can never collide);
 * otherwise the Project Binding's key, if any.
 */
function effectiveScope(
  explicit: string | undefined,
  bound: string | undefined,
): string | undefined {
  if (explicit === 'all') {
    return undefined;
  }
  return explicit ?? bound;
}

/**
 * Run the CLI for one invocation. `argv` is the args after `mimir`; `getStore`
 * lazily supplies the Store over an open, migrated database — it must be
 * idempotent (the caller owns the connection's lifecycle) and is called only
 * by verbs that touch data, so help/usage/`skill` paths never open a store
 * (MMR-39); `io` is the injected sink + presentation context. Returns the
 * process exit code.
 */
export async function runCli(
  argv: string[],
  getStore: () => Store | Promise<Store>,
  io: Io,
  defaults: Defaults = {},
): Promise<number> {
  // Unconverted read paths still want the raw executor (Phase 2a/2b scope).
  const getDb = async (): Promise<Db> => (await getStore()).db;
  let values: {
    scope?: string;
    priority?: string;
    size?: string;
    status?: string;
    is?: string[];
    'not-is'?: string[];
    eq?: string[];
    'not-eq'?: string[];
    in?: string[];
    'not-in'?: string[];
    has?: string[];
    missing?: string[];
    before?: string[];
    on?: string[];
    after?: string[];
    'not-before'?: string[];
    'not-after'?: string[];
    tag?: string[];
    note?: string;
    limit?: string;
    col?: string[];
    format?: string;
    ascii?: boolean;
    help?: boolean;
    // Write-surface flags
    to?: string;
    parent?: string;
    key?: string;
    name?: string;
    desc?: string;
    summary?: string;
    target?: string;
    ref?: string;
    file?: string;
    link?: string;
    project?: string;
    top?: boolean;
    bottom?: boolean;
    title?: string;
    yes?: boolean;
    global?: boolean;
    local?: boolean;
    agent?: string;
    port?: string;
    vault?: string;
    'install-service'?: boolean;
    'install-snapshot'?: boolean;
    'snapshot-interval'?: string;
    upstream?: string;
    next?: boolean;
    'dry-run'?: boolean;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({ allowPositionals: true, args: argv, options: OPTIONS });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const fmt = errorFormat(argv);
    renderError(usage(msg), fmt, io);
    if (fmt !== 'json' && fmt !== 'jsonl') {
      io.error(TERSE_HELP);
    }
    return 2;
  }

  const command = positionals[0];
  const full = argv.includes('--help');
  if (command === undefined) {
    io.write(full ? FULL_HELP : TERSE_HELP);
    return 0;
  }
  // `<cmd> -h` / `<cmd> --help` prints THAT command's help (MMR-118), falling
  // back to the top-level help for a verb without a descriptor. Returns before
  // any dispatch, so help never opens the store.
  if (values.help === true) {
    io.write(helpForCommand(command, positionals[1], full) ?? (full ? FULL_HELP : TERSE_HELP));
    return 0;
  }

  const ctx: Io = { ...io, plain: io.plain || values.ascii === true };

  try {
    // The write echo's format, picked inside the try block so a bad --format
    // value is caught and rendered.
    const singleFormat = pickFormat(values.format, 'single', ctx);
    // Mutation context shared across all write-verb handlers — built lazily so
    // the store is acquired only by verbs that actually touch data (MMR-39):
    // help, usage errors, and `skill install` never open or create it.
    const mkCtx = async (): Promise<Ctx> => {
      const store = await getStore();
      return {
        db: store.db,
        format: singleFormat,
        io: ctx,
        positionals,
        store,
        values: values as Record<string, unknown>,
      };
    };

    switch (command) {
      case 'next': {
        const nextScope = effectiveScope(values.scope, defaults.scope);
        const nextEmptyMsg =
          nextScope !== undefined
            ? `No ready tasks in ${nextScope} — mimir list --status awaiting -s ${nextScope} shows what's queued`
            : "No ready tasks — mimir list --status awaiting shows what's queued";
        return runSet(
          await nextTasks(await getStore(), {
            facets: parseFacets(values.col),
            filters: parseFilters(values),
            limit: parseLimit(values.limit),
            priority: parsePriority(values.priority),
            scope: nextScope,
            size: parseSize(values.size),
            verdicts: parseVerdicts(values.is, values['not-is']),
          }),
          values.format,
          ctx,
          nextEmptyMsg,
        );
      }
      case 'list': {
        // The archived-projects shelf (ADR 0015) — the sole door to hidden
        // projects; lists projects, not nodes, so it bypasses listNodes.
        if (values.status === 'archived') {
          const projects = await listProjects(
            await getStore(),
            ['distribution', 'tags'],
            'archived',
          );
          return runSet(
            { items: projects, returned: projects.length, startsAt: 0, total: projects.length },
            values.format,
            ctx,
            'No archived projects',
          );
        }
        return runSet(
          await listNodes(await getStore(), {
            facets: parseFacets(values.col),
            filters: parseFilters(values),
            limit: parseLimit(values.limit),
            priority: parsePriority(values.priority),
            scope: effectiveScope(values.scope, defaults.scope),
            size: parseSize(values.size),
            status: parseStatus(values.status),
            tag: values.tag?.[0],
            verdicts: parseVerdicts(values.is, values['not-is']),
          }),
          values.format,
          ctx,
          'No tasks match — try --status all, or drop a filter',
        );
      }
      case 'get': {
        const id = requireId(positionals[1], 'get');
        if (parseIdentity(id)?.kind === 'artifact') {
          const content = (values.col ?? []).includes('content');
          renderArtifactDetail(
            await getArtifact(await getStore(), id, { content }),
            pickFormat(values.format, 'single', ctx),
            ctx,
          );
          return 0;
        }
        const facets = parseFacets(values.col);
        const node = await getNode(await getStore(), id, {
          facets: facets.length > 0 ? [...new Set([...CHEAP_FACETS, ...facets])] : undefined,
        });
        return renderSingle(node, values.format, ctx);
      }
      case 'status': {
        const id = requireId(positionals[1], 'status');
        const status = await statusOfNode(await getStore(), id);
        const format = pickFormat(values.format, 'status', ctx);
        ctx.write(format === 'json' ? formatStatusJson(status) : renderStatus(status, ctx));
        return 0;
      }
      case 'tree': {
        const id = requireId(positionals[1], 'tree');
        const tree = await nodeTree(await getStore(), id);
        const format = pickFormat(values.format, 'single', ctx);
        switch (format) {
          case 'json': {
            ctx.write(emitWire(treeToWire(tree), true));
            break;
          }
          case 'jsonl': {
            ctx.write(emitWire(treeToWire(tree), false));
            break;
          }
          case 'ids': {
            ctx.write(tree.id);
            break;
          }
          case 'records':
          case 'table': {
            ctx.write(renderTree(tree, ctx));
            break;
          }
        }
        return 0;
      }
      case 'start': {
        return await cmdStart(await mkCtx());
      }
      case 'submit': {
        return await cmdSubmit(await mkCtx());
      }
      case 'return': {
        return await cmdReturn(await mkCtx());
      }
      case 'done': {
        return await cmdDone(await mkCtx());
      }
      case 'abandon': {
        return await cmdAbandon(await mkCtx());
      }
      case 'reopen': {
        return await cmdReopen(await mkCtx());
      }
      case 'park': {
        return await cmdPark(await mkCtx());
      }
      case 'unpark': {
        return await cmdUnpark(await mkCtx());
      }
      case 'block': {
        return await cmdBlock(await mkCtx());
      }
      case 'unblock': {
        return await cmdUnblock(await mkCtx());
      }
      case 'depend': {
        return await cmdDepend(await mkCtx());
      }
      case 'undepend': {
        return await cmdUndepend(await mkCtx());
      }
      case 'move': {
        return await cmdMove(await mkCtx());
      }
      case 'reorder': {
        return await cmdReorder(await mkCtx());
      }
      case 'update': {
        return await cmdUpdate(await mkCtx());
      }
      case 'annotate': {
        return await cmdAnnotate(await mkCtx());
      }
      case 'attach': {
        return await cmdAttach(await mkCtx());
      }
      case 'create': {
        return await cmdCreate(await mkCtx());
      }
      case 'tag': {
        return await cmdTag(await mkCtx());
      }
      case 'untag': {
        return await cmdUntag(await mkCtx());
      }
      case 'archive': {
        return await cmdArchive(await mkCtx());
      }
      case 'unarchive': {
        return await cmdUnarchive(await mkCtx());
      }
      case 'skill': {
        const sub = positionals[1];
        if (sub !== 'install') {
          throw usage('skill: unknown subcommand (expected: skill install)');
        }
        if (values.global === true && values.local === true) {
          throw usage('skill install takes --global or --local, not both');
        }
        const agent = values.agent ?? 'claude';
        if (!isMember(agent, SKILL_AGENTS)) {
          throw usage(`unknown agent: ${agent} (expected ${SKILL_AGENTS.join('|')})`);
        }
        const base = values.local === true ? (defaults.cwd ?? process.cwd()) : homedir();
        const dir = skillDirFor(agent, base);
        for (const f of SKILL_FILES) {
          const target = `${dir}/${f.path}`;
          mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true });
          writeFileSync(target, f.content);
        }
        if (singleFormat === 'json' || singleFormat === 'jsonl') {
          ctx.write(JSON.stringify({ installed: { agent, files: SKILL_FILES.length, path: dir } }));
        } else if (singleFormat === 'ids') {
          ctx.write(dir);
        } else {
          const glyph = ctx.plain ? '[ok]' : '\x1b[32m✓\x1b[0m';
          ctx.write(`${glyph} installed the mimir skill → ${dir} (${SKILL_FILES.length} files)`);
        }
        return 0;
      }
      case 'bind': {
        const key = positionals[1];
        if (key === undefined) {
          throw usage('bind requires a project KEY');
        }
        await resolveProject(await getDb(), key); // validates the project exists (not_found otherwise)
        writeBinding(defaults.cwd ?? process.cwd(), key);
        if (singleFormat === 'json' || singleFormat === 'jsonl') {
          ctx.write(JSON.stringify({ bound: { file: BINDING_FILE, project: key } }));
        } else if (singleFormat === 'ids') {
          ctx.write(key);
        } else {
          const glyph = ctx.plain ? '[ok]' : '\x1b[32m✓\x1b[0m';
          ctx.write(`${glyph} bound to ${key} (${BINDING_FILE})`);
        }
        return 0;
      }
      case 'migrate': {
        // One dispatch for the whole `migrate` namespace (`-h`/`--help` on any
        // of it is already handled above, before the store is ever touched).
        // `schema` runs the DB migrator through an injected capability — it
        // opens the store UN-migrated, so it can't ride the auto-migrating
        // provider; the data subcommands run over a normally-migrated store.
        const sub = positionals[1];
        if (sub === 'schema') {
          if (defaults.migrateSchema === undefined) {
            throw usage('migrate schema is unavailable in this context');
          }
          return await defaults.migrateSchema(positionals[2]);
        }
        if (sub === 'artifacts') {
          return await cmdMigrateArtifacts(await getDb(), ctx, {
            dryRun: values['dry-run'] === true,
            json: values.format === 'json' || values.format === 'jsonl',
          });
        }
        if (sub === 'nodes') {
          return await cmdMigrateNodes(await getDb(), ctx, {
            dryRun: values['dry-run'] === true,
            json: values.format === 'json' || values.format === 'jsonl',
          });
        }
        if (sub === undefined) {
          ctx.write(helpForCommand('migrate', undefined, full) ?? TERSE_HELP);
          return 0;
        }
        throw usage(`unknown migrate subcommand '${sub}' — expected: schema, artifacts, nodes`);
      }
      case 'setup': {
        if (defaults.service === undefined || defaults.vault === undefined) {
          throw usage('setup is unavailable in this context');
        }
        const format = pickFormat(values.format, 'report', ctx);
        return await cmdSetup(
          {
            installService: values['install-service'],
            installSnapshot: values['install-snapshot'],
            port: values.port,
            snapshotInterval: values['snapshot-interval'],
            upstream: values.upstream,
            vault: values.vault,
            yes: values.yes,
          },
          ctx,
          {
            defaultVaultPath: defaultVaultPath(),
            service: defaults.service,
            vault: defaults.vault,
          },
          format,
        );
      }
      case 'service': {
        if (defaults.service === undefined) {
          throw usage('service is unavailable in this context');
        }
        const format = pickFormat(values.format, 'report', ctx);
        return await cmdService(positionals, { port: values.port }, ctx, defaults.service, format);
      }
      case 'vault': {
        if (defaults.vault === undefined) {
          throw usage('vault is unavailable in this context');
        }
        const format = pickFormat(values.format, 'report', ctx);
        return await cmdVault(positionals, ctx, defaults.vault, format);
      }
      case 'self-update': {
        if (defaults.service === undefined) {
          throw usage('self-update is unavailable in this context');
        }
        const format = pickFormat(values.format, 'report', ctx);
        return await cmdSelfUpdate(
          ctx,
          defaults.service,
          { next: values.next === true, tag: values.tag?.at(-1) },
          format,
        );
      }
      default: {
        throw usage(`unknown command: ${command}`);
      }
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
    const arg = argv[i] ?? '';
    // Equals form: --format=json or -f=json
    const eqMatch = /^(?:--format|-f)=(.+)$/.exec(arg);
    if (eqMatch) {
      const val = eqMatch[1];
      if (val === 'json' || val === 'jsonl') {
        return val;
      }
      continue;
    }
    // Separate-token form: --format json or -f json
    if ((arg === '-f' || arg === '--format') && i < argv.length - 1) {
      const val = argv[i + 1] ?? '';
      if (val === 'json' || val === 'jsonl') {
        return val;
      }
    }
  }
  return 'records';
}

function runSet(
  result: SetResult<NodeView>,
  explicit: string | undefined,
  io: Io,
  emptyMsg?: string,
): number {
  const format = pickFormat(explicit, 'set', io);
  if (result.warnings !== undefined && result.warnings.length > 0) {
    renderWarnings(result.warnings, format, io);
  }
  switch (format) {
    case 'ids': {
      io.write(formatIds(result.items));
      break;
    }
    case 'json': {
      io.write(formatSetJson(result));
      break;
    }
    case 'jsonl': {
      io.write(formatSetJsonl(result.items));
      break;
    }
    case 'records': {
      if (result.items.length === 0 && io.isTTY && emptyMsg !== undefined) {
        io.write(emptyMsg);
      } else {
        io.write(result.items.map((n) => renderRecords(n, io)).join('\n\n'));
      }
      break;
    }
    case 'table': {
      io.write(renderTable(result, io, emptyMsg));
      break;
    }
  }
  return 0;
}

function renderSingle(node: NodeView, explicit: string | undefined, io: Io): number {
  renderNodeView(node, pickFormat(explicit, 'single', io), io);
  return 0;
}

function pickFormat(
  explicit: string | undefined,
  kind: 'set' | 'single' | 'status' | 'report',
  io: Io,
): Format {
  if (explicit !== undefined) {
    if (!isMember(explicit, FORMATS)) {
      throw usage(`unknown format: ${explicit} (expected ${FORMATS.join('|')})`);
    }
    return explicit;
  }
  // `status` is structured data — json on every destination.
  if (kind === 'status') {
    return 'json';
  }
  // `report` (service status / self-update) keeps its MMR-59 split: json when
  // piped, human prose in a terminal.
  if (kind === 'report') {
    return io.isTTY ? 'records' : 'json';
  }
  // `set`/`single` (MMR-87): `isTTY` governs *decoration* only, never
  // *information*. The piped default carries the same fields as the interactive
  // one — color is already stripped via `io.plain` (`NO_COLOR || !isTTY`).
  // `ids`/`json`/`jsonl` stay explicit `-f` opt-ins: the non-TTY consumer is an
  // agent reading to decide (for whom bare ids are useless), not a `| xargs`
  // pipeline.
  return kind === 'set' ? 'table' : 'records';
}

function requireId(id: string | undefined, command: string): string {
  if (id === undefined) {
    throw usage(`${command} requires an id (KEY | KEY-seq | KEY-aN)`);
  }
  return id;
}

/**
 * The flat `--col` vocabulary (MMR-38) — the dot prefix is gone (it fenced a
 * dynamic namespace Mimir doesn't have). One closed list; `content` is
 * artifact-only and handled by the `get KEY-aN` path.
 */
function parseFacets(cols: string[] | undefined): FacetName[] {
  const facets: FacetName[] = [];
  for (const col of cols ?? []) {
    if (col.startsWith('.')) {
      throw usage(`columns are flat now: --col ${col.slice(1)} (the dot prefix was dropped)`);
    }
    if (col === 'content') {
      continue;
    } // artifact-only; a node simply has no body
    if (!isMember(col, FACET_NAMES)) {
      throw usage(`unknown column: ${col}`, `columns: ${[...FACET_NAMES, 'content'].join(', ')}`);
    }
    facets.push(col);
  }
  return facets;
}

function parseStatus(value: string | undefined): StatusSelector | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isMember(value, STATUS_SELECTOR_VALUES)) {
    throw usage(`invalid status: ${value} (expected ${STATUS_SELECTOR_VALUES.join('|')})`);
  }
  return value;
}

function parseVerdicts(is: string[] | undefined, notIs: string[] | undefined): VerdictSelector[] {
  const out: VerdictSelector[] = [];
  const take = (tokens: string[] | undefined, negate: boolean): void => {
    for (const token of tokens ?? []) {
      if (!isMember(token, VERDICT_VALUES)) {
        throw usage(`invalid verdict: ${token} (expected ${VERDICT_VALUES.join('|')})`);
      }
      out.push({ negate, verdict: token });
    }
  };
  take(is, false);
  take(notIs, true);
  return out;
}

/** The query-op flags, in declaration order. */
const OP_FLAGS = [
  'eq',
  'not-eq',
  'in',
  'not-in',
  'has',
  'missing',
  'before',
  'on',
  'after',
  'not-before',
  'not-after',
] as const;

/**
 * Collect FIELD:VALUE filter tokens from the op flags. Structural faults
 * (unknown field, operator-type mismatch) surface as usage — the caller's
 * invocation is wrong (exit 2); the same fault over MCP stays `validation`.
 */
function parseFilters(values: Record<string, unknown>): FieldFilter[] {
  const filters: FieldFilter[] = [];
  for (const op of OP_FLAGS) {
    const tokens = values[op];
    if (!Array.isArray(tokens)) {
      continue;
    }
    for (const token of tokens) {
      if (typeof token !== 'string') {
        continue;
      }
      try {
        filters.push(parseFilterToken(op, token));
      } catch (error) {
        if (error instanceof MimirError) {
          throw usage(error.message, error.hint);
        }
        throw error;
      }
    }
  }
  return filters;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) {
    throw usage(`invalid limit: ${value}`);
  }
  return n;
}

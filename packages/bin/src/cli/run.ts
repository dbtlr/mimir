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
  formatOverviewJson,
  formatSetJson,
  formatSetJsonl,
  formatStatusJson,
  getArtifact,
  getNode,
  getSeed,
  listNodes,
  listProjects,
  nextTasks,
  nodeTree,
  overviewOf,
  parseFilterToken,
  parseIdentity,
  statusOfNode,
  treeToWire,
} from '../core';
import type { Store } from '../core';
import { cmdDoctor } from '../doctor/commands';
import type { DoctorDeps } from '../doctor/commands';
import { defaultVaultPath } from '../env';
import { cmdSelfUpdate, cmdService } from '../service';
import type { ServiceDeps } from '../service';
import { cmdVault } from '../vault/commands';
import type { VaultDeps } from '../vault/commands';
import { BINDING_FILE, writeBinding } from './binding';
import { exitCodeFor, isRenderable, renderError, renderWarnings, usage } from './errors';
import { COMMAND_HELP, FULL_HELP, TERSE_HELP, helpForCommand } from './help';
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
  cmdPromote,
  cmdReject,
  cmdResolve,
  cmdSeed,
  cmdSeeds,
  cmdTriage,
} from './mutations';
import type { Ctx } from './mutations';
import { parsePriority, parseSize } from './parse';
import {
  arrow,
  countLine,
  FORMATS,
  renderArtifactDetail,
  renderNodeView,
  renderOverview,
  renderRecords,
  renderSeedView,
  renderStatus,
  renderTable,
  renderTree,
  warn,
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
  // Container open-ended converse pair (MMR-204) — like top/bottom.
  'open-ended': { type: 'boolean' },
  'not-open-ended': { type: 'boolean' },
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
  // seed verbs (MMR-245)
  kind: { short: 'k', type: 'string' },
  requester: { type: 'string' },
  sort: { type: 'string' },
  grouped: { type: 'boolean' },
  // triage preview (MMR-246)
  'dry-run': { type: 'boolean' },
  // doctor deterministic repair (MMR-183)
  fix: { type: 'boolean' },
  // self-update selectors (--tag reuses the multiple `tag` flag above,
  // last-wins like the other shared write-surface flags)
  next: { type: 'boolean' },
} as const;
/* oxlint-enable sort-keys */

/**
 * Every dispatch verb — the authority for "is this a real command?" (MMR-211).
 * An unknown verb is a hard usage error (exit 2) even with `-h`/`--help`; it
 * must never fall through to the top-level help, which an agent can misread as
 * task data and then act on stale context.
 *
 * Derived from the `COMMAND_HELP` descriptor registry (single source) rather
 * than re-listed: every documented verb, dropping the space-keyed
 * `create <type>` subcommand descriptors. `serve`/`mcp`/`version` are
 * intercepted upstream in `main` and never reach here. The switch in
 * `runCli` keeps a defensive `default:` for any drift.
 */
const COMMANDS: ReadonlySet<string> = new Set(
  Object.keys(COMMAND_HELP).filter((key) => !key.includes(' ')),
);

/** Every valid flag spelling — long `--name` plus any short `-x` alias. */
const FLAG_SPELLINGS: readonly string[] = Object.entries(OPTIONS).flatMap(([name, spec]) =>
  'short' in spec ? [`--${name}`, `-${spec.short}`] : [`--${name}`],
);

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
  /** The `doctor` vault diagnostics read handle; absent where doctor is
   * unavailable (tests). */
  doctor?: DoctorDeps;
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
 * lazily supplies the Store over the converged Norn vault — it must be
 * idempotent (the caller owns the client's lifecycle) and is called only
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
    kind?: string;
    requester?: string;
    sort?: string;
    grouped?: boolean;
    next?: boolean;
    'dry-run'?: boolean;
    fix?: boolean;
  };
  let positionals: string[];
  try {
    const parsed = parseArgs({ allowPositionals: true, args: argv, options: OPTIONS });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // A strict parse fails on a bad/unknown flag. Recover the verb leniently
    // (an unknown flag can't be the command) and route: an unknown verb is the
    // primary fault — surface its typo hint — otherwise it's a genuine flag
    // error on a known verb, so point at THAT verb's help (MMR-211).
    const command = lenientCommand(argv);
    if (command !== undefined && !COMMANDS.has(command)) {
      return renderUnknownCommand(command, argv, io);
    }
    renderError(usage(msg, unknownFlagHint(command, msg)), errorFormat(argv), io);
    return 2;
  }

  const ctx: Io = { ...io, plain: io.plain || values.ascii === true };

  const command = positionals[0];
  const full = argv.includes('--help');
  if (command === undefined) {
    ctx.write(full ? FULL_HELP : TERSE_HELP);
    return 0;
  }
  // An unknown verb is a hard usage error (exit 2) — even with `-h`/`--help`,
  // which must never fall through to the top-level help. A silent help dump
  // (worse, at exit 0) reads as data to an agent that then proceeds on stale
  // context (MMR-211). Real verbs continue to the help/dispatch paths below.
  if (!COMMANDS.has(command)) {
    return renderUnknownCommand(command, argv, ctx);
  }
  // `<cmd> -h` / `<cmd> --help` prints THAT command's help (MMR-118), falling
  // back to the top-level help for a verb without a descriptor. Returns before
  // any dispatch, so help never opens the store.
  if (values.help === true) {
    ctx.write(helpForCommand(command, positionals[1], full) ?? (full ? FULL_HELP : TERSE_HELP));
    return 0;
  }

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
        boundScope: effectiveScope(values.scope, defaults.scope),
        format: singleFormat,
        io: ctx,
        positionals,
        store,
        values,
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
          // No issueCount here by design (MMR-184): this is a project-shelf
          // resource, not a node working set — threading the doctor tally
          // through would widen listProjects' cross-transport shape for a
          // nudge, which is disproportionate.
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
        if (parseIdentity(id)?.kind === 'seed') {
          // `get KEY-sN` routes to the single-seed reader + renderer, matching MCP
          // (`get_seed`) and HTTP (`GET /api/seeds/:id`) — the ADR 0020 amendment
          // promises `get KEY-sN` works on every surface (MMR-245/B3). Content is
          // opted in for the `## Seed Description` prose, as those transports do.
          renderSeedView(
            await getSeed(await getStore(), id, { content: true }),
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
      case 'overview': {
        // `overview` reads ONE project (ADR 0024): `-s all` is a category error —
        // a composite is not a cross-project set.
        if (values.scope === 'all') {
          throw usage(
            'overview reads one project, not a cross-project set',
            "run 'mimir list -s all' for a cross-project set",
          );
        }
        const scope = effectiveScope(values.scope, defaults.scope);
        if (scope === undefined) {
          throw usage('overview needs a project', 'bind a project or pass -s KEY');
        }
        const format = pickOverviewFormat(values.format, ctx);
        const report = await overviewOf(await getStore(), scope);
        ctx.write(format === 'json' ? formatOverviewJson(report) : renderOverview(report, ctx));
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
      case 'seed': {
        return await cmdSeed(await mkCtx());
      }
      case 'seeds': {
        return await cmdSeeds(await mkCtx());
      }
      case 'promote': {
        return await cmdPromote(await mkCtx());
      }
      case 'reject': {
        return await cmdReject(await mkCtx());
      }
      case 'resolve': {
        return await cmdResolve(await mkCtx());
      }
      case 'triage': {
        // `report` format (MMR-59 split): human prose in a terminal, json when piped.
        const c = await mkCtx();
        return await cmdTriage({ ...c, format: pickFormat(values.format, 'report', ctx) });
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
          ctx.write(
            `${glyph} installed the mimir skill ${arrow(ctx.plain)} ${dir} (${SKILL_FILES.length} files)`,
          );
        }
        return 0;
      }
      case 'bind': {
        const key = positionals[1];
        if (key === undefined) {
          throw usage('bind requires a project KEY');
        }
        await resolveProject(await getStore(), key); // validates the project exists (not_found otherwise)
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
      case 'doctor': {
        if (defaults.doctor === undefined) {
          throw usage('doctor is unavailable in this context');
        }
        if (values['dry-run'] === true && values.fix !== true) {
          throw usage('doctor --dry-run requires --fix');
        }
        const format = pickFormat(values.format, 'report', ctx);
        return await cmdDoctor(
          ctx,
          defaults.doctor,
          format,
          effectiveScope(values.scope, defaults.scope),
          { dryRun: values['dry-run'] === true, fix: values.fix === true },
        );
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

/** Levenshtein edit distance — small inputs (verb/flag names), one-row DP. */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j] ?? 0;
      row[j] = Math.min(above + 1, (row[j - 1] ?? 0) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = above;
    }
  }
  return row[b.length] ?? 0;
}

/**
 * The closest candidate to `input`, but only when it's a genuinely near miss:
 * within 2 edits, strictly shorter distance than the input's own length, and
 * UNAMBIGUOUS — a tie at the minimum (e.g. an unknown short flag `-x`, one edit
 * from every `-<char>`) yields no suggestion rather than an arbitrary one.
 */
function nearest(input: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestD = Number.POSITIVE_INFINITY;
  let tied = false;
  for (const candidate of candidates) {
    const d = editDistance(input, candidate);
    if (d < bestD) {
      bestD = d;
      best = candidate;
      tied = false;
    } else if (d === bestD) {
      tied = true;
    }
  }
  return best !== undefined && !tied && bestD <= 2 && bestD < input.length ? best : undefined;
}

/**
 * Recover the command (first positional) without throwing on unknown flags — a
 * lenient parse for the error paths, where the strict parse has already failed
 * and we still need to know which verb was invoked (MMR-211). Lenient parsing
 * still honors known value-taking flags, so a flag's value is never mistaken for
 * the verb (`mimir -s alpha get --bad` → `get`, not `alpha`).
 */
function lenientCommand(argv: string[]): string | undefined {
  try {
    return parseArgs({ allowPositionals: true, args: argv, options: OPTIONS, strict: false })
      .positionals[0];
  } catch {
    return argv.find((arg) => !arg.startsWith('-'));
  }
}

/** Render the unknown-command usage error (exit 2) with a did-you-mean hint. */
function renderUnknownCommand(command: string, argv: string[], io: Io): number {
  const near = nearest(command, COMMANDS);
  const hint =
    near !== undefined
      ? `did you mean '${near}'? (or run 'mimir --help' to see the commands)`
      : "run 'mimir --help' to see the commands";
  renderError(usage(`unknown command: ${command}`, hint), errorFormat(argv), io);
  return 2;
}

/**
 * Hint for a parse failure on a known verb — typically an unknown flag. A
 * did-you-mean on the offending flag when one is unambiguously close, plus a
 * pointer to that verb's own help (its flags), falling back to the top-level
 * help when the verb is absent.
 */
function unknownFlagHint(command: string | undefined, message: string): string {
  const flag = /Unknown option '(--?[^']+)'/.exec(message)?.[1];
  const near = flag === undefined ? undefined : nearest(flag, FLAG_SPELLINGS);
  const help =
    command !== undefined && COMMANDS.has(command)
      ? `run 'mimir ${command} -h' for its flags`
      : "run 'mimir --help' for usage";
  return near !== undefined ? `did you mean '${near}'? (or ${help})` : help;
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
  // The doctor issue-count nudge (MMR-184): a stderr-only boot-orientation note,
  // off the tolerant reader's own drop tally for this load — never a fresh
  // `mimir doctor` pass. Unconditional of format (stdout stays a clean machine
  // contract either way) and silent at zero, matching the rare-condition cost bar.
  // Machine formats (json/jsonl) follow renderWarnings' convention: a JSON
  // object line on stderr rather than the prose glyph line, so the stream
  // stays parseable.
  if (result.issueCount !== undefined && result.issueCount > 0) {
    const message = `${countLine(result.issueCount, 'issue')} — run mimir doctor`;
    if (format === 'json' || format === 'jsonl') {
      io.error(JSON.stringify({ issueCount: result.issueCount, warning: message }));
    } else {
      warn(io, message);
    }
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

/**
 * The `overview` format resolver (MMR-278): the `report` split — `records` on a
 * TTY, `json` when piped — but ONLY those two. The set formats are category
 * errors (a composite is not one table / a row stream / an id set), each rejected
 * as usage with a pointer at `mimir list`.
 */
function pickOverviewFormat(explicit: string | undefined, io: Io): 'records' | 'json' {
  if (explicit === undefined) {
    return io.isTTY ? 'records' : 'json';
  }
  if (explicit === 'records' || explicit === 'json') {
    return explicit;
  }
  if (explicit === 'table') {
    throw usage('overview is a composite, not a single table', "run 'mimir list' for a table");
  }
  if (explicit === 'jsonl') {
    throw usage(
      'overview is a composite, not a row stream',
      "run 'mimir list -f jsonl' for a row stream",
    );
  }
  if (explicit === 'ids') {
    throw usage('overview is a composite, not an id set', "run 'mimir list -f ids' for an id set");
  }
  throw usage(`unknown format: ${explicit} (expected records|json)`);
}

function requireId(id: string | undefined, command: string): string {
  if (id === undefined) {
    throw usage(`${command} requires an id (KEY | KEY-seq | KEY-aN)`);
  }
  return id;
}

/**
 * The always-shown `NodeView` bare columns (dto.ts). `--col` only *adds* optional
 * facet columns, so a user naming one of these is treating it as a projection —
 * the 21-occurrence `--col id,type,status` miss (MMR-212). Best-effort: a name
 * missing here just falls through to the generic unknown-column error.
 */
const BASE_COLUMN_NAMES = [
  'id',
  'type',
  'title',
  'status',
  'parent',
  'summary',
  'priority',
  'size',
  'lifecycle',
  'hold',
  'target',
  'created',
  'updated',
  'completed',
] as const;

/**
 * The flat `--col` vocabulary (MMR-38) — the dot prefix is gone (it fenced a
 * dynamic namespace Mimir doesn't have). One closed list; `content` is
 * artifact-only and handled by the `get KEY-aN` path.
 */
function parseFacets(cols: string[] | undefined): FacetName[] {
  const facets: FacetName[] = [];
  // Accept a comma-separated list (`--col history,annotations`) as well as the
  // repeated `--col` form (MMR-212); tolerate surrounding spaces and empties.
  for (const raw of (cols ?? []).flatMap((c) => c.split(','))) {
    const col = raw.trim();
    if (col === '') {
      continue;
    }
    if (col.startsWith('.')) {
      throw usage(`columns are flat now: --col ${col.slice(1)} (the dot prefix was dropped)`);
    }
    if (col === 'content') {
      continue;
    } // artifact-only; a node simply has no body
    if (!isMember(col, FACET_NAMES)) {
      if (isMember(col, BASE_COLUMN_NAMES)) {
        throw usage(
          `--col adds optional columns; '${col}' is always shown`,
          `optional columns: ${[...FACET_NAMES, 'content'].join(', ')}`,
        );
      }
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

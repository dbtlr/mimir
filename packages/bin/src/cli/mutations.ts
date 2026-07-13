/**
 * Mutation command handlers for the CLI write surface (Phase 3).
 * Each handler receives a `Ctx` built once in `run.ts` and shared across all
 * write verbs. Tasks 4–8 will add more handlers here and cases to `run.ts`.
 */

import { SEED_KIND_VALUES, SEED_STATUS_SELECTOR_VALUES } from '@mimir/contract';
import type { SeedKind } from '@mimir/contract';
import { isMember } from '@mimir/helpers';

import {
  abandonTask,
  annotate,
  archiveProject,
  attachArtifact,
  blockTask,
  completeTask,
  createInitiative,
  createPhase,
  asSeedKind,
  createProject,
  createTask,
  depend,
  deriveSet,
  fileSeed,
  findNodeInSet,
  getArtifact,
  isSeedRef,
  listSeeds,
  moveNode,
  parseIdentity,
  parseSeedRef,
  notFound,
  parkTask,
  promoteSeed,
  releasedByArchive,
  reorder,
  reopenTask,
  resolveEntityTokenInSet,
  resolveNodeTokenInSet,
  returnTask,
  startTask,
  submitTask,
  resolveBoard,
  tagEntities,
  transitionSeed,
  triage,
  unarchiveProject,
  unblockTask,
  undepend,
  unparkTask,
  untagEntities,
  updateArtifact,
  updateNode,
  updateProject,
  updateSeed,
  validation,
} from '../core';
import type {
  RankPosition,
  SeedStatusSelector,
  Store,
  UpdateFields,
  UpdateProjectFields,
  UpdateSeedFields,
} from '../core';
import { usage } from './errors';
import { parsePriority, parseSize } from './parse';
import {
  renderArtifactDetail,
  renderSeedView,
  renderSeeds,
  renderTriage,
  signpost,
} from './render';
import type { Format, Io } from './render';
import {
  echoNodeWith,
  echoProject,
  readContent,
  resolveNode,
  resolveParent,
  resolveProject,
} from './resolve';

/** Shared dispatch context built once in `run.ts` for every write verb. */
export type Ctx = {
  /** The verbs' seam — resolution, mutation, and echo all route through it. */
  store: Store;
  /** Full positionals including the verb at [0]. */
  positionals: string[];
  values: Record<string, unknown>;
  format: Format;
  io: Io;
  /** The effective bound board (`effectiveScope`) — the seed verbs' default
   * target + requester (`null`/self-filed when unbound). */
  boundScope?: string;
};

/** Assert that positional at index `i` is present and non-blank, else throw a usage error. */
export function requirePos(c: Ctx, i: number, verb: string, noun = 'an id (KEY-seq)'): string {
  const v = c.positionals[i];
  if (v === undefined || v.trim() === '') {
    throw usage(`${verb} requires ${noun}`);
  }
  return v;
}

/**
 * Assert a flag's token is non-blank, else throw a usage error — a blank
 * where a required id belongs is a malformed invocation, not a lookup miss
 * (MMR-41: `--to ''` is usage/exit 2, never not_found/exit 1).
 */
function requireToken(value: string, verb: string, flag: string): string {
  if (value.trim() === '') {
    throw usage(`${verb} --${flag} expects an id (KEY-seq)`);
  }
  return value;
}

/** Append ` · <reason>` to a signpost when a reason was given. */
const withReason = (text: string, reason?: string): string =>
  reason !== undefined ? `${text} · ${reason}` : text;

export async function cmdStart(c: Ctx): Promise<number> {
  const id = await resolveNode(c.store, requirePos(c, 1, 'start'), 'task');
  await startTask(c.store, id);
  await echoNodeWith(c.store, id, c.format, c.io, (rid) => `started ${rid} · todo → in_progress`);
  return 0;
}

export async function cmdDone(c: Ctx): Promise<number> {
  const id = await resolveNode(c.store, requirePos(c, 1, 'done'), 'task');
  await completeTask(c.store, id);
  await echoNodeWith(c.store, id, c.format, c.io, (rid) => `completed ${rid}`);
  return 0;
}

export async function cmdAbandon(c: Ctx): Promise<number> {
  const id = await resolveNode(c.store, requirePos(c, 1, 'abandon'), 'task');
  const reason = reasonTail(c);
  await abandonTask(c.store, id, reason);
  await echoNodeWith(c.store, id, c.format, c.io, (rid) => withReason(`abandoned ${rid}`, reason));
  return 0;
}

export async function cmdSubmit(c: Ctx): Promise<number> {
  const id = await resolveNode(c.store, requirePos(c, 1, 'submit'), 'task');
  await submitTask(c.store, id);
  await echoNodeWith(
    c.store,
    id,
    c.format,
    c.io,
    (rid) => `submitted ${rid} · in_progress → under_review`,
  );
  return 0;
}

export async function cmdReturn(c: Ctx): Promise<number> {
  const id = await resolveNode(c.store, requirePos(c, 1, 'return'), 'task');
  const reason = reasonTail(c);
  await returnTask(c.store, id, reason);
  await echoNodeWith(c.store, id, c.format, c.io, (rid) =>
    withReason(`returned ${rid} · under_review → in_progress`, reason),
  );
  return 0;
}

export async function cmdReopen(c: Ctx): Promise<number> {
  const id = await resolveNode(c.store, requirePos(c, 1, 'reopen'), 'task');
  const reason = reasonTail(c);
  await reopenTask(c.store, id, reason);
  await echoNodeWith(c.store, id, c.format, c.io, (rid) =>
    withReason(`reopened ${rid} → in_progress`, reason),
  );
  return 0;
}

const reasonTail = (c: Ctx): string | undefined => c.positionals.slice(2).join(' ') || undefined;

/** Echo a project archive/unarchive — a signpost (the project view doesn't surface archived state until Phase 1). */
function echoArchiveOp(
  c: Ctx,
  project: { key: string; archived_at: string | null },
  verb: 'archived' | 'unarchived',
  reason?: string,
): void {
  if (c.format === 'json' || c.format === 'jsonl') {
    c.io.write(JSON.stringify({ project: { archived_at: project.archived_at, key: project.key } }));
  } else if (c.format === 'ids') {
    c.io.write(project.key);
  } else {
    const glyph = c.io.plain ? '[ok]' : '\x1b[32m✓\x1b[0m';
    c.io.write(`${glyph} ${withReason(`${verb} ${project.key}`, reason)}`);
  }
}

export async function cmdArchive(c: Ctx): Promise<number> {
  const key = requirePos(c, 1, 'archive', 'a project KEY');
  const reason = reasonTail(c);
  const projectId = await resolveProject(c.store, key);
  const project = await archiveProject(c.store, projectId, reason);
  echoArchiveOp(c, project, 'archived', reason);
  // Name the out-of-project dependents this archive released (ADR 0015
  // Refinement) — their archived prerequisite no longer gates them.
  const released = await releasedByArchive(c.store, projectId);
  if (released.length > 0 && c.format !== 'json' && c.format !== 'jsonl' && c.format !== 'ids') {
    const glyph = c.io.plain ? '[warn]' : '\x1b[33m⚠\x1b[0m';
    c.io.write(`${glyph} released ${String(released.length)} dependent(s): ${released.join(', ')}`);
  }
  return 0;
}

export async function cmdUnarchive(c: Ctx): Promise<number> {
  const key = requirePos(c, 1, 'unarchive', 'a project KEY');
  const projectId = await resolveProject(c.store, key);
  const project = await unarchiveProject(c.store, projectId);
  echoArchiveOp(c, project, 'unarchived');
  return 0;
}

export async function cmdPark(c: Ctx): Promise<number> {
  const id = await resolveNode(c.store, requirePos(c, 1, 'park'), 'task');
  const reason = reasonTail(c);
  await parkTask(c.store, id, reason);
  await echoNodeWith(c.store, id, c.format, c.io, (rid) => withReason(`parked ${rid}`, reason));
  return 0;
}

export async function cmdUnpark(c: Ctx): Promise<number> {
  const id = await resolveNode(c.store, requirePos(c, 1, 'unpark'), 'task');
  await unparkTask(c.store, id);
  await echoNodeWith(c.store, id, c.format, c.io, (rid) => `unparked ${rid}`);
  return 0;
}

export async function cmdBlock(c: Ctx): Promise<number> {
  const id = await resolveNode(c.store, requirePos(c, 1, 'block'), 'task');
  const reason = reasonTail(c);
  await blockTask(c.store, id, reason);
  await echoNodeWith(c.store, id, c.format, c.io, (rid) => withReason(`blocked ${rid}`, reason));
  return 0;
}

export async function cmdUnblock(c: Ctx): Promise<number> {
  const id = await resolveNode(c.store, requirePos(c, 1, 'unblock'), 'task');
  await unblockTask(c.store, id);
  await echoNodeWith(c.store, id, c.format, c.io, (rid) => `unblocked ${rid}`);
  return 0;
}

async function resolveIds(
  store: Store,
  csv: string,
  verb: string,
  flag: string,
): Promise<number[]> {
  const tokens = csv.split(',').map((t) => requireToken(t, verb, flag).trim());
  const set = deriveSet(await store.loadWorkingSet());
  return tokens.map((t) =>
    resolveNodeTokenInSet(set, t, 'task, phase, or initiative', {
      notFound: 'see what exists: mimir list -f ids',
    }),
  );
}

/** Clean a comma-separated id list back to a display string (`MMR-3, MMR-4`). */
const idList = (csv: string): string =>
  csv
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .join(', ');

export async function cmdDepend(c: Ctx): Promise<number> {
  const id = await resolveNode(c.store, requirePos(c, 1, 'depend'));
  const on = lastFlag(c, 'on');
  if (on === undefined) {
    throw usage('depend requires --on <ids>');
  }
  await depend(c.store, id, await resolveIds(c.store, on, 'depend', 'on'));
  await echoNodeWith(c.store, id, c.format, c.io, (rid) => `${rid} now depends on ${idList(on)}`);
  return 0;
}

export async function cmdUndepend(c: Ctx): Promise<number> {
  const id = await resolveNode(c.store, requirePos(c, 1, 'undepend'));
  const on = lastFlag(c, 'on');
  if (on === undefined) {
    throw usage('undepend requires --on <ids>');
  }
  await undepend(c.store, id, await resolveIds(c.store, on, 'undepend', 'on'));
  await echoNodeWith(
    c.store,
    id,
    c.format,
    c.io,
    (rid) => `${rid} no longer depends on ${idList(on)}`,
  );
  return 0;
}

export async function cmdMove(c: Ctx): Promise<number> {
  const id = await resolveNode(c.store, requirePos(c, 1, 'move'));
  if (typeof c.values.to !== 'string') {
    throw usage('move requires --to <parent>');
  }
  const to = requireToken(c.values.to, 'move', 'to');
  const parentId = await resolveNode(c.store, to);
  await moveNode(c.store, id, parentId);
  await echoNodeWith(c.store, id, c.format, c.io, (rid) => `moved ${rid} → ${to}`);
  return 0;
}

export async function cmdReorder(c: Ctx): Promise<number> {
  const id = await resolveNode(c.store, requirePos(c, 1, 'reorder'), 'task');
  let position: RankPosition;
  let refId: number | null = null;
  let where: string;
  const before = lastFlag(c, 'before');
  const after = lastFlag(c, 'after');
  if (c.values.top === true) {
    position = 'top';
    where = 'top';
  } else if (c.values.bottom === true) {
    position = 'bottom';
    where = 'bottom';
  } else if (before !== undefined) {
    position = 'before';
    const ref = requireToken(before, 'reorder', 'before');
    refId = await resolveNode(c.store, ref);
    where = `before ${ref}`;
  } else if (after !== undefined) {
    position = 'after';
    const ref = requireToken(after, 'reorder', 'after');
    refId = await resolveNode(c.store, ref);
    where = `after ${ref}`;
  } else {
    throw usage('reorder requires one of --top | --bottom | --before <id> | --after <id>');
  }
  await reorder(c.store, id, position, refId);
  await echoNodeWith(c.store, id, c.format, c.io, (rid) => `reordered ${rid} → ${where}`);
  return 0;
}

export async function cmdUpdate(c: Ctx): Promise<number> {
  const token = requirePos(c, 1, 'update');
  if (parseIdentity(token)?.kind === 'artifact') {
    return await cmdUpdateArtifact(c, token);
  }
  if (parseIdentity(token)?.kind === 'project') {
    return await cmdUpdateProject(c, token);
  }
  if (parseIdentity(token)?.kind === 'seed') {
    return await cmdUpdateSeed(c, token);
  }
  const id = await resolveNode(c.store, token);
  const fields: UpdateFields = {};
  const changed: string[] = [];
  if (typeof c.values.title === 'string') {
    fields.title = c.values.title;
    changed.push('title');
  }
  if (typeof c.values.desc === 'string') {
    fields.description = c.values.desc;
    changed.push('description');
  }
  if (typeof c.values.summary === 'string') {
    fields.summary = c.values.summary;
    changed.push('summary');
  }
  if (typeof c.values.priority === 'string') {
    fields.priority = parsePriority(c.values.priority);
    changed.push('priority');
  }
  if (typeof c.values.size === 'string') {
    fields.size = parseSize(c.values.size);
    changed.push('size');
  }
  if (typeof c.values.target === 'string') {
    fields.target = c.values.target;
    changed.push('target');
  }
  if (typeof c.values.ref === 'string') {
    fields.externalRef = c.values.ref;
    changed.push('ref');
  }
  const openEnded = openEndedFlag(c);
  if (openEnded !== undefined) {
    fields.openEnded = openEnded;
    changed.push('open_ended');
  }
  const upstream = seedUpstream(c);
  if (upstream !== undefined) {
    fields.upstream = upstream;
    changed.push('upstream');
  }
  await updateNode(c.store, id, fields);
  const suffix = changed.length > 0 ? ` (${changed.join(', ')})` : '';
  await echoNodeWith(c.store, id, c.format, c.io, (rid) => `updated ${rid}${suffix}`);
  return 0;
}

/** `update KEY` — patch a project's `name` and/or `description` (MMR-88). */
async function cmdUpdateProject(c: Ctx, token: string): Promise<number> {
  // Flags that don't apply to a project (only to tasks/phases).
  for (const [key, flag] of [
    ['title', '--title'],
    ['priority', '--priority'],
    ['size', '--size'],
    ['target', '--target'],
    ['ref', '--ref'],
    ['summary', '--summary'],
    ['open-ended', '--open-ended'],
    ['not-open-ended', '--not-open-ended'],
  ] as const) {
    if (c.values[key] !== undefined) {
      throw validation(`${flag} doesn't apply to a project — use --name to rename it`);
    }
  }
  const projectId = await resolveProject(c.store, token);
  const fields: UpdateProjectFields = {};
  if (typeof c.values.name === 'string') {
    fields.name = c.values.name;
  }
  if (typeof c.values.desc === 'string') {
    fields.description = c.values.desc;
  }
  await updateProject(c.store, projectId, fields);
  await echoProject(c.store, token, c.format, c.io);
  return 0;
}

/** `update KEY-aN` — title is an artifact's one mutable field (MMR-40). */
async function cmdUpdateArtifact(c: Ctx, token: string): Promise<number> {
  for (const [key, flag] of [
    ['desc', '--desc'],
    ['priority', '--priority'],
    ['size', '--size'],
    ['target', '--target'],
    ['ref', '--ref'],
    ['summary', '--summary'],
    ['open-ended', '--open-ended'],
    ['not-open-ended', '--not-open-ended'],
  ] as const) {
    if (c.values[key] !== undefined) {
      throw validation(`${flag} doesn't apply to an artifact — title is its one mutable field`);
    }
  }
  const identity = parseIdentity(token);
  if (identity?.kind !== 'artifact') {
    throw notFound(`no artifact with id ${token}`);
  }
  if (typeof c.values.title === 'string') {
    await updateArtifact(
      c.store,
      { key: identity.key, seq: identity.seq },
      { title: c.values.title },
    );
  }
  renderArtifactDetail(await getArtifact(c.store, token), c.format, c.io);
  return 0;
}

export async function cmdAnnotate(c: Ctx): Promise<number> {
  const id = await resolveNode(c.store, requirePos(c, 1, 'annotate'));
  const content = await readContent(c.positionals.slice(2), c.io);
  if (content === '') {
    throw usage('annotate requires content (positional or stdin)');
  }
  await annotate(c.store, id, content);
  await echoNodeWith(c.store, id, c.format, c.io, (rid) => `annotated ${rid}`);
  return 0;
}

export async function cmdAttach(c: Ctx): Promise<number> {
  const file = optStr(c, 'file');
  // Content from --file, else stdin — but never block on an interactive TTY.
  let content: string;
  if (file !== undefined) {
    content = await Bun.file(file).text();
  } else if (c.io.isTTY) {
    content = '';
  } else {
    content = await Bun.stdin.text();
  }
  if (content.trim() === '') {
    throw usage('attach requires content (--file <path> or piped stdin)');
  }

  // Node references: the positional primary (if any) + --link csv.
  const linkTokens: string[] = [];
  const primary = c.positionals[1];
  if (primary !== undefined) {
    linkTokens.push(primary);
  }
  if (typeof c.values.link === 'string') {
    linkTokens.push(
      ...c.values.link
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    );
  }

  let projectId: number;
  const linkNodeIds: number[] = [];
  if (linkTokens.length > 0) {
    const set = deriveSet(await c.store.loadWorkingSet());
    const nodes = linkTokens.map((t) => {
      const n = findNodeInSet(set, t);
      if (n === undefined) {
        throw notFound(`${t} doesn't exist`);
      }
      return n;
    });
    const projects = new Set(nodes.map((n) => n.project_id));
    if (projects.size > 1) {
      throw validation('all the links must be in one project');
    }
    const [projectIdFromNodes] = projects; // number | undefined under noUncheckedIndexedAccess
    if (projectIdFromNodes === undefined) {
      throw validation('internal: links resolved but project is missing');
    }
    projectId = projectIdFromNodes;
    linkNodeIds.push(...nodes.map((n) => n.id));
    if (typeof c.values.project === 'string') {
      const explicit = await resolveProject(c.store, c.values.project);
      if (explicit !== projectId) {
        throw validation("--project disagrees with the links' project");
      }
    }
  } else {
    projectId = await resolveProject(
      c.store,
      strFlag(c, 'project', 'attach requires a link (KEY-seq) or --project <KEY>'),
    );
  }

  const explicitTitle = optStr(c, 'title');
  const basename = file?.split('/').pop();
  const title = explicitTitle ?? basename;
  if (title === undefined || title.trim() === '') {
    throw usage('attach from stdin requires --title <text>');
  }
  const { renderedId } = await attachArtifact(c.store, {
    content,
    linkNodeIds,
    projectId,
    tags: tagFlags(c),
    title,
  });
  if (c.format === 'json' || c.format === 'jsonl') {
    c.io.write(JSON.stringify({ artifact: { id: renderedId } }));
  } else if (c.format === 'ids') {
    c.io.write(renderedId);
  } else {
    c.io.write(`${c.io.plain ? '[ok]' : '\x1b[32m✓\x1b[0m'} attached artifact ${renderedId}`);
  }
  return 0;
}

function strFlag(c: Ctx, name: string, msg: string): string {
  const v = c.values[name];
  if (typeof v !== 'string') {
    throw usage(msg);
  }
  return v;
}

/**
 * Read a flag that parseArgs collects as `multiple` (shared with the query
 * date-ops, MMR-33) as a single string — the last occurrence wins.
 */
function lastFlag(c: Ctx, name: string): string | undefined {
  const v = c.values[name];
  if (typeof v === 'string') {
    return v;
  }
  if (Array.isArray(v) && v.length > 0) {
    const last: unknown = v[v.length - 1];
    return typeof last === 'string' ? last : undefined;
  }
  return undefined;
}

function optStr(c: Ctx, name: string): string | undefined {
  const v = c.values[name];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Resolve the `--open-ended` / `--not-open-ended` converse pair to a tri-state
 * (MMR-204): `true`, `false`, or `undefined` (neither flag). Passing both is a
 * usage error, mirroring `--top`/`--bottom`.
 */
function openEndedFlag(c: Ctx): boolean | undefined {
  const on = c.values['open-ended'] === true;
  const off = c.values['not-open-ended'] === true;
  if (on && off) {
    throw usage('at most one of --open-ended | --not-open-ended');
  }
  if (on) {
    return true;
  }
  return off ? false : undefined;
}

/**
 * The `--upstream KEY-sN` requester-side seed pointer (MMR-244/245) on task
 * create/update. Grammar-validated at the verb layer (the core plumbing accepts
 * it; the doctor/read tiers vet dangling/malformed refs later).
 */
function seedUpstream(c: Ctx): string | undefined {
  const upstream = optStr(c, 'upstream');
  if (upstream === undefined) {
    return undefined;
  }
  if (!isSeedRef(upstream)) {
    throw usage(`--upstream expects a seed id (KEY-sN), got ${upstream}`);
  }
  return upstream;
}

/** The repeatable `--tag` values on create (MMR-31). */
function tagFlags(c: Ctx): string[] | undefined {
  const v = c.values.tag;
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string')) {
    return undefined;
  }
  return v;
}

const splitCsv = (csv: string): string[] =>
  csv
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

/** Echo a tag/untag result — ids + tags, no node reload (the op is the news). */
function echoTagOp(c: Ctx, verb: 'tagged' | 'untagged', ids: string[], tags: string[]): void {
  if (c.format === 'json' || c.format === 'jsonl') {
    c.io.write(JSON.stringify({ [verb]: { ids, tags } }));
  } else if (c.format === 'ids') {
    c.io.write(ids.join('\n'));
  } else {
    const glyph = c.io.plain ? '[ok]' : '\x1b[32m✓\x1b[0m';
    c.io.write(`${glyph} ${verb} ${ids.join(', ')}: ${tags.join(', ')}`);
  }
}

export async function cmdTag(c: Ctx): Promise<number> {
  const ids = splitCsv(requirePos(c, 1, 'tag', 'ids (comma-separated)'));
  if (ids.length === 0) {
    throw usage('tag requires ids (comma-separated)');
  }
  const tags = c.positionals.slice(2);
  if (tags.length === 0) {
    throw usage('tag requires at least one tag');
  }
  const set = deriveSet(await c.store.loadWorkingSet());
  const targets = ids.map((t) => resolveEntityTokenInSet(set, t));
  await tagEntities(c.store, targets, tags);
  echoTagOp(c, 'tagged', ids, tags);
  return 0;
}

export async function cmdUntag(c: Ctx): Promise<number> {
  const ids = splitCsv(requirePos(c, 1, 'untag', 'ids (comma-separated)'));
  if (ids.length === 0) {
    throw usage('untag requires ids (comma-separated)');
  }
  const tags = c.positionals.slice(2);
  if (tags.length === 0) {
    throw usage('untag requires at least one tag');
  }
  const set = deriveSet(await c.store.loadWorkingSet());
  const targets = ids.map((t) => resolveEntityTokenInSet(set, t));
  await untagEntities(c.store, targets, tags);
  echoTagOp(c, 'untagged', ids, tags);
  return 0;
}

export async function cmdCreate(c: Ctx): Promise<number> {
  const type = c.positionals[1];
  // open_ended is container-only — reject it on task/project create (symmetry with
  // `update`, which throws for the same; MMR-204). Only initiative/phase consume it.
  if ((type === 'task' || type === 'project') && openEndedFlag(c) !== undefined) {
    throw validation('open_ended applies only to phases and initiatives');
  }
  switch (type) {
    case 'project': {
      // Positional name like every other create type (MMR-35); --name still works.
      const name = c.positionals[2] ?? optStr(c, 'name');
      if (name === undefined) {
        throw usage('create project requires a name', 'create project "Name" --key KEY');
      }
      const key = strFlag(c, 'key', 'create project requires --key');
      // The key is immutable, so creation is the one gated write (ADR 0011
      // grooming): interactive sessions confirm at a prompt; non-interactive
      // callers must pass -y/--yes — the recorded proof confirmation happened.
      if (c.values.yes !== true) {
        if (!c.io.isTTY) {
          throw usage(
            `create project ${key}: the key is immutable — confirmation required`,
            're-run with -y/--yes to confirm',
          );
        }
        if (
          !globalThis.confirm(`create project ${key} ("${name}") — the key is immutable. proceed?`)
        ) {
          c.io.error(`${c.io.plain ? '[err]' : '\x1b[31m✗\x1b[0m'} aborted`);
          return 1;
        }
      }
      const project = await createProject(c.store, {
        description: optStr(c, 'desc'),
        key,
        name,
        tags: tagFlags(c),
      });
      if (c.format === 'json' || c.format === 'jsonl') {
        c.io.write(JSON.stringify({ project: { key: project.key, name: project.name } }));
      } else if (c.format === 'ids') {
        c.io.write(project.key);
      } else {
        c.io.write(`${c.io.plain ? '[ok]' : '\x1b[32m✓\x1b[0m'} created project ${project.key}`);
      }
      return 0;
    }
    case 'initiative': {
      const title = requirePos(c, 2, 'create initiative', 'a title');
      const parent = await resolveParent(
        c.store,
        strFlag(c, 'parent', 'create initiative requires --parent <KEY>'),
      );
      if (parent.kind !== 'project') {
        throw usage("an initiative's parent must be a project (KEY)");
      }
      const node = await createInitiative(c.store, {
        description: optStr(c, 'desc'),
        openEnded: openEndedFlag(c),
        projectId: parent.id,
        summary: optStr(c, 'summary'),
        tags: tagFlags(c),
        title,
      });
      await echoNodeWith(c.store, node.id, c.format, c.io, (rid) => `created ${rid}`);
      return 0;
    }
    case 'phase': {
      const title = requirePos(c, 2, 'create phase', 'a title');
      const parent = await resolveParent(
        c.store,
        strFlag(c, 'parent', 'create phase requires --parent <id>'),
      );
      if (parent.kind !== 'node') {
        throw usage("a phase's parent must be an initiative (KEY-seq)");
      }
      const node = await createPhase(c.store, {
        description: optStr(c, 'desc'),
        openEnded: openEndedFlag(c),
        parentId: parent.id,
        summary: optStr(c, 'summary'),
        tags: tagFlags(c),
        target: optStr(c, 'target'),
        title,
      });
      await echoNodeWith(c.store, node.id, c.format, c.io, (rid) => `created ${rid}`);
      return 0;
    }
    case 'task': {
      const title = requirePos(c, 2, 'create task', 'a title');
      const parent = await resolveParent(
        c.store,
        strFlag(c, 'parent', 'create task requires --parent <id>'),
      );
      if (parent.kind !== 'node') {
        throw usage("a task's parent must be a phase or initiative (KEY-seq)");
      }
      const node = await createTask(c.store, {
        description: optStr(c, 'desc'),
        externalRef: optStr(c, 'ref'),
        parentId: parent.id,
        priority:
          typeof c.values.priority === 'string' ? parsePriority(c.values.priority) : undefined,
        size: typeof c.values.size === 'string' ? parseSize(c.values.size) : undefined,
        summary: optStr(c, 'summary'),
        tags: tagFlags(c),
        title,
        upstream: seedUpstream(c),
      });
      await echoNodeWith(c.store, node.id, c.format, c.io, (rid) => `created ${rid}`);
      return 0;
    }
    default: {
      throw usage(
        `create: unknown type ${type ?? '(none)'} (expected project|initiative|phase|task)`,
      );
    }
  }
}

// ─── Seeds (MMR-245) ────────────────────────────────────────────────────────

/**
 * The seed target/scope project for `seed`/`seeds` — `--project` or the `-p`
 * short (which parseArgs collects on the `priority` slot; seeds carry no
 * priority, so the slot names the board). Absent → the caller falls back to the
 * bound board.
 */
function seedProject(c: Ctx): string | undefined {
  const explicit = optStr(c, 'project');
  if (explicit !== undefined) {
    return explicit;
  }
  const short = c.values.priority;
  return typeof short === 'string' ? short : undefined;
}

/** The required `-k`/`--kind`, narrowed to the closed seed-kind enum. */
function requireKind(c: Ctx): SeedKind {
  const kind = optStr(c, 'kind');
  if (kind === undefined) {
    throw usage(`seed requires -k <${SEED_KIND_VALUES.join('|')}>`);
  }
  const narrowed = asSeedKind(kind);
  if (narrowed === null) {
    throw usage(`invalid kind: ${kind} (expected ${SEED_KIND_VALUES.join('|')})`);
  }
  return narrowed;
}

/** Parse the seed queue `--status` (a lifecycle word, or `live`/`all`). */
function parseSeedStatus(c: Ctx): SeedStatusSelector | undefined {
  const status = optStr(c, 'status');
  if (status === undefined) {
    return undefined; // listSeeds defaults to `live`
  }
  if (!isMember(status, SEED_STATUS_SELECTOR_VALUES)) {
    throw usage(`invalid status: ${status} (expected ${SEED_STATUS_SELECTOR_VALUES.join('|')})`);
  }
  return status;
}

/** Parse `--sort` (age order; `asc` = oldest-first). */
function parseSeedSort(c: Ctx): 'asc' | 'desc' | undefined {
  const sort = optStr(c, 'sort');
  if (sort === undefined) {
    return undefined;
  }
  if (sort !== 'asc' && sort !== 'desc') {
    throw usage(`invalid sort: ${sort} (expected asc|desc)`);
  }
  return sort;
}

/** Require a positional that parses as a seed id (`KEY-sN`) — the s-id grammar. */
function requireSeedId(c: Ctx, verb: string): string {
  const token = requirePos(c, 1, verb, 'a seed id (KEY-sN)');
  if (parseSeedRef(token) === null) {
    throw usage(`${verb} takes a seed id (KEY-sN), got ${token}`);
  }
  return token;
}

export async function cmdSeed(c: Ctx): Promise<number> {
  const title = requirePos(c, 1, 'seed', 'a title');
  const kind = requireKind(c);
  const target = seedProject(c) ?? c.boundScope;
  if (target === undefined) {
    throw usage(
      'seed requires a target project',
      'pass -p KEY or bind a board first (mimir bind KEY)',
    );
  }
  // requester = the bound board only when filing INTO a different board; a seed
  // filed at its own board (or unbound) is self-filed → requester null (no noise).
  const requester = c.boundScope !== undefined && c.boundScope !== target ? c.boundScope : null;
  const seed = await fileSeed(c.store, {
    description: optStr(c, 'desc'),
    kind,
    project: target,
    requester,
    title,
  });
  signpost(c.io, c.format, `filed ${seed.id} · ${seed.kind}`);
  renderSeedView(seed, c.format, c.io);
  return 0;
}

export async function cmdSeeds(c: Ctx): Promise<number> {
  // Scope: -p/--project, else the bound board, else (unbound / -s all) every project.
  const project = seedProject(c) ?? c.boundScope;
  const seeds = await listSeeds(c.store, {
    project,
    requester: optStr(c, 'requester'),
    sort: parseSeedSort(c),
    status: parseSeedStatus(c),
  });
  renderSeeds(seeds, c.format, c.io, {
    emptyMsg: 'No seeds — file one with mimir seed "…" -k <kind>',
    grouped: c.values.grouped === true,
  });
  return 0;
}

export async function cmdPromote(c: Ctx): Promise<number> {
  const id = requireSeedId(c, 'promote');
  const { seed, created, spawnedId } = await promoteSeed(c.store, id, {
    description: optStr(c, 'desc'),
    link: optStr(c, 'link'),
    parent: optStr(c, 'parent'),
    priority: typeof c.values.priority === 'string' ? parsePriority(c.values.priority) : undefined,
    size: typeof c.values.size === 'string' ? parseSize(c.values.size) : undefined,
    tags: tagFlags(c),
    title: optStr(c, 'title'),
  });
  signpost(
    c.io,
    c.format,
    created !== undefined
      ? `promoted ${seed.id} · spawned ${created}`
      : `promoted ${seed.id} · recorded existing work`,
  );
  renderSeedView(seed, c.format, c.io, created, spawnedId);
  return 0;
}

async function seedTerminal(
  c: Ctx,
  verb: 'reject' | 'resolve',
  to: 'rejected' | 'resolved',
): Promise<number> {
  const id = requireSeedId(c, verb);
  const reason = c.positionals.slice(2).join(' ');
  if (reason.trim() === '') {
    throw usage(`${verb} requires a reason`);
  }
  const seed = await transitionSeed(c.store, id, to, reason);
  signpost(c.io, c.format, `${to} ${seed.id} · ${reason}`);
  renderSeedView(seed, c.format, c.io);
  return 0;
}

export async function cmdReject(c: Ctx): Promise<number> {
  return seedTerminal(c, 'reject', 'rejected');
}

export async function cmdResolve(c: Ctx): Promise<number> {
  return seedTerminal(c, 'resolve', 'resolved');
}

/**
 * `triage [KEY]` — the explicit-run reconciliation pass (MMR-246). Bare `triage`
 * targets the bound board; `triage KEY` another. Writes the check-(c)
 * annotations by default (running it IS the intent); `--dry-run` previews with no
 * writes. A report, never a gate — it always exits 0. `c.format` is the `report`
 * format the dispatcher picked (human in a terminal, json when piped).
 */
export async function cmdTriage(c: Ctx): Promise<number> {
  const board = resolveBoard(c.positionals[1], c.boundScope, usage);
  const report = await triage(c.store, { board, dryRun: c.values['dry-run'] === true });
  renderTriage(report, c.format, c.io);
  return 0;
}

/** `update KEY-sN` — patch a live seed's title/kind/description (MMR-245). */
async function cmdUpdateSeed(c: Ctx, token: string): Promise<number> {
  for (const [key, flag] of [
    ['priority', '--priority'],
    ['size', '--size'],
    ['target', '--target'],
    ['ref', '--ref'],
    ['summary', '--summary'],
    ['open-ended', '--open-ended'],
    ['not-open-ended', '--not-open-ended'],
    ['upstream', '--upstream'],
  ] as const) {
    if (c.values[key] !== undefined) {
      // A node-only flag on a seed update is a bad INVOCATION, not a value fault —
      // usage/exit-2, mirroring the sibling --kind guard and the output contract (B5a).
      throw usage(`${flag} doesn't apply to a seed — patch --title, --kind, or --desc`);
    }
  }
  const fields: UpdateSeedFields = {};
  const changed: string[] = [];
  if (typeof c.values.title === 'string') {
    fields.title = c.values.title;
    changed.push('title');
  }
  if (typeof c.values.desc === 'string') {
    fields.description = c.values.desc;
    changed.push('description');
  }
  if (typeof c.values.kind === 'string') {
    const narrowed = asSeedKind(c.values.kind);
    if (narrowed === null) {
      throw usage(`invalid kind: ${c.values.kind} (expected ${SEED_KIND_VALUES.join('|')})`);
    }
    fields.kind = narrowed;
    changed.push('kind');
  }
  const seed = await updateSeed(c.store, token, fields);
  const suffix = changed.length > 0 ? ` (${changed.join(', ')})` : '';
  signpost(c.io, c.format, `updated ${seed.id}${suffix}`);
  renderSeedView(seed, c.format, c.io);
  return 0;
}

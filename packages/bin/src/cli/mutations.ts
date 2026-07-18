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
  createNode,
  asSeedKind,
  depend,
  deriveSet,
  fileSeed,
  getArtifact,
  inapplicableUpdateFields,
  listSeeds,
  moveNode,
  parseIdentity,
  parseSeedRef,
  parseUpstreamField,
  UPSTREAM_CLEAR,
  notFound,
  parkTask,
  promoteSeed,
  releasedByArchive,
  reorder,
  reopenTask,
  resolveAttachTargets,
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
  NarrowUpdateKind,
  RankPosition,
  SeedStatusSelector,
  Store,
  UpdateFieldKey,
  UpdateFields,
  UpdateProjectFields,
  UpdateSeedFields,
} from '../core';
import { usage } from './errors';
import { parsePriority, parseSize } from './parse';
import {
  arrow,
  ok,
  renderArtifactDetail,
  renderSeedView,
  renderSeeds,
  renderTriage,
  signpost,
} from './render';
import type { Format, Io } from './render';
import { echoNodeWith, echoProject, readContent, resolveNode, resolveProject } from './resolve';

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
  await echoNodeWith(
    c.store,
    id,
    c.format,
    c.io,
    (rid) => `started ${rid} · todo ${arrow(c.io.plain)} in_progress`,
  );
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
    (rid) => `submitted ${rid} · in_progress ${arrow(c.io.plain)} under_review`,
  );
  return 0;
}

export async function cmdReturn(c: Ctx): Promise<number> {
  const id = await resolveNode(c.store, requirePos(c, 1, 'return'), 'task');
  const reason = reasonTail(c);
  await returnTask(c.store, id, reason);
  await echoNodeWith(c.store, id, c.format, c.io, (rid) =>
    withReason(`returned ${rid} · under_review ${arrow(c.io.plain)} in_progress`, reason),
  );
  return 0;
}

export async function cmdReopen(c: Ctx): Promise<number> {
  const id = await resolveNode(c.store, requirePos(c, 1, 'reopen'), 'task');
  const reason = reasonTail(c);
  await reopenTask(c.store, id, reason);
  await echoNodeWith(c.store, id, c.format, c.io, (rid) =>
    withReason(`reopened ${rid} ${arrow(c.io.plain)} in_progress`, reason),
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
    ok(c.io, withReason(`${verb} ${project.key}`, reason));
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
): Promise<string[]> {
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
  await echoNodeWith(
    c.store,
    id,
    c.format,
    c.io,
    (rid) => `moved ${rid} ${arrow(c.io.plain)} ${to}`,
  );
  return 0;
}

export async function cmdReorder(c: Ctx): Promise<number> {
  const id = await resolveNode(c.store, requirePos(c, 1, 'reorder'), 'task');
  let position: RankPosition;
  let refId: string | null = null;
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
  await echoNodeWith(
    c.store,
    id,
    c.format,
    c.io,
    (rid) => `reordered ${rid} ${arrow(c.io.plain)} ${where}`,
  );
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

/** camelCase → kebab, for the default `--flag` spelling of a field. */
const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * The CLI's flag spellings that diverge from the default (ADR 0025 finding iii)
 * — the only hand-held part of the flag template. Everything else derives: a
 * field's default flag is a single `--<kebab-key>` reading the same key. The SET
 * of fields is NOT listed here; {@link updateFieldFlags} renders whatever
 * {@link inapplicableUpdateFields} sweeps, so a new spec field surfaces with a
 * derived flag and no edit. The overrides are `--ref` (not `--external-ref`),
 * `--desc` (not `--description`), and `open_ended`'s on/off pair.
 */
const UPDATE_FLAG_OVERRIDES: Partial<
  Record<UpdateFieldKey, readonly (readonly [key: string, flag: string])[]>
> = {
  description: [['desc', '--desc']],
  externalRef: [['ref', '--ref']],
  openEnded: [
    ['open-ended', '--open-ended'],
    ['not-open-ended', '--not-open-ended'],
  ],
};

/** The CLI flag(s) for an update field — its spelling override, else the derived
 * default `--<kebab-key>`. A view template over the field model, not a fact. */
export function updateFieldFlags(
  field: UpdateFieldKey,
): readonly (readonly [key: string, flag: string])[] {
  const override = UPDATE_FLAG_OVERRIDES[field];
  if (override !== undefined) {
    return override;
  }
  const flag = kebab(field);
  return [[flag, `--${flag}`]];
}

/**
 * Reject any flag inapplicable to `kind` (MMR-306) — the CLI-side sweep over
 * the shared table, in canonical field order. `fail` lets the seed update
 * keep its usage/exit-2 class (a node-only flag there is a bad invocation,
 * not a value fault, B5a) while project/artifact stay `validation`/exit-1.
 */
function rejectInapplicableFields(
  c: Ctx,
  kind: NarrowUpdateKind,
  describe: (flag: string) => string,
  fail: (message: string) => Error = validation,
): void {
  for (const field of inapplicableUpdateFields(kind)) {
    for (const [key, flag] of updateFieldFlags(field)) {
      if (c.values[key] !== undefined) {
        throw fail(describe(flag));
      }
    }
  }
}

/** `update KEY` — patch a project's `name` and/or `description` (MMR-88). */
async function cmdUpdateProject(c: Ctx, token: string): Promise<number> {
  rejectInapplicableFields(
    c,
    'project',
    (flag) => `${flag} doesn't apply to a project — use --name to rename it`,
  );
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
  rejectInapplicableFields(
    c,
    'artifact',
    (flag) => `${flag} doesn't apply to an artifact — title is its one mutable field`,
  );
  const identity = parseIdentity(token);
  if (identity?.kind !== 'artifact') {
    throw notFound(`${token} doesn't exist`);
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

  // Dedup, the one-project invariant, and --project agreement all live in core
  // (MMR-305); the native required-arg gap stays here as a `usage` error.
  const projectFlag = optStr(c, 'project');
  if (linkTokens.length === 0 && projectFlag === undefined) {
    throw usage('attach requires a link (KEY-seq) or --project <KEY>');
  }
  const { projectId, linkNodeIds } = await resolveAttachTargets(c.store, linkTokens, projectFlag, {
    notFound: 'see what exists: mimir list -f ids',
  });

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
 * create/update, plus its explicit clear (`--upstream none`, MMR-301):
 * `undefined` means "leave it alone", `null` means "clear it" — blank/absent
 * never clears (MMR-284 rejected that ambiguity). Grammar-validated at the
 * verb layer (the core plumbing accepts it; the doctor/read tiers vet
 * dangling/malformed refs later).
 */
function seedUpstream(c: Ctx): string | null | undefined {
  const upstream = optStr(c, 'upstream');
  if (upstream === undefined) {
    return undefined;
  }
  const parsed = parseUpstreamField(upstream);
  if (parsed === undefined) {
    throw usage(
      `--upstream expects a seed id (KEY-sN) or '${UPSTREAM_CLEAR}' to clear, got ${upstream}`,
    );
  }
  return parsed;
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

/** The CLI's hint for a well-formed parent ref that resolves to nothing. */
const PARENT_NOT_FOUND_HINT = { notFound: 'see what exists: mimir list -f ids' };

/**
 * The CLI's parent-token shape gate: a token whose identity grammar cannot be
 * the required parent kind is a bad invocation (`usage`, exit 2) — the class
 * the pre-createNode envelope used, matching `update`'s flag errors. Core
 * re-validates kind and existence semantically for every transport behind it.
 */
function requireParentShape(
  c: Ctx,
  flagUsage: string,
  kind: 'project' | 'node',
  message: string,
): string {
  const token = strFlag(c, 'parent', flagUsage);
  if (parseIdentity(token)?.kind !== kind) {
    throw usage(message);
  }
  return token;
}

export async function cmdCreate(c: Ctx): Promise<number> {
  const type = c.positionals[1];
  switch (type) {
    case 'project': {
      // Positional name like every other create type (MMR-35); --name still works.
      const name = c.positionals[2] ?? optStr(c, 'name');
      if (name === undefined) {
        throw usage('create project requires a name', 'create project "Name" --key KEY');
      }
      const key = strFlag(c, 'key', 'create project requires --key');
      // Flag validation precedes the interactive gate: a doomed invocation must
      // never consume a confirmation. The rule itself lives in core createNode.
      if (openEndedFlag(c) !== undefined) {
        throw validation('open_ended applies only to phases and initiatives');
      }
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
      const project = await createNode(c.store, {
        description: optStr(c, 'desc'),
        key,
        name,
        openEnded: openEndedFlag(c),
        tags: tagFlags(c),
        type: 'project',
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
      const node = await createNode(c.store, {
        description: optStr(c, 'desc'),
        openEnded: openEndedFlag(c),
        parent: requireParentShape(
          c,
          'create initiative requires --parent <KEY>',
          'project',
          "an initiative's parent must be a project (KEY)",
        ),
        summary: optStr(c, 'summary'),
        tags: tagFlags(c),
        title,
        type: 'initiative',
      });
      await echoNodeWith(c.store, node.id, c.format, c.io, (rid) => `created ${rid}`);
      return 0;
    }
    case 'phase': {
      const title = requirePos(c, 2, 'create phase', 'a title');
      const node = await createNode(c.store, {
        description: optStr(c, 'desc'),
        openEnded: openEndedFlag(c),
        parent: requireParentShape(
          c,
          'create phase requires --parent <id>',
          'node',
          "a phase's parent must be an initiative (KEY-seq)",
        ),
        parentHints: PARENT_NOT_FOUND_HINT,
        summary: optStr(c, 'summary'),
        tags: tagFlags(c),
        target: optStr(c, 'target'),
        title,
        type: 'phase',
      });
      await echoNodeWith(c.store, node.id, c.format, c.io, (rid) => `created ${rid}`);
      return 0;
    }
    case 'task': {
      const title = requirePos(c, 2, 'create task', 'a title');
      const node = await createNode(c.store, {
        description: optStr(c, 'desc'),
        externalRef: optStr(c, 'ref'),
        openEnded: openEndedFlag(c),
        parent: requireParentShape(
          c,
          'create task requires --parent <id>',
          'node',
          "a task's parent must be a phase or initiative (KEY-seq)",
        ),
        parentHints: PARENT_NOT_FOUND_HINT,
        // CLI ergonomics stay in the envelope: prefix expansion (`--size m` →
        // medium) and the usage error class for a bad value, matching `update`.
        priority: parsePriority(optStr(c, 'priority')),
        size: parseSize(optStr(c, 'size')),
        summary: optStr(c, 'summary'),
        tags: tagFlags(c),
        title,
        type: 'task',
        // Same envelope rule for --upstream: a bad token is a usage error via
        // seedUpstream, matching `update`. On create, `none` and absent agree
        // (no upstream), so the cleared null maps to undefined for core.
        upstream: seedUpstream(c) ?? undefined,
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
  // A node-only flag on a seed update is a bad INVOCATION, not a value fault —
  // usage/exit-2, mirroring the sibling --kind guard and the output contract (B5a).
  rejectInapplicableFields(
    c,
    'seed',
    (flag) => `${flag} doesn't apply to a seed — patch --title, --kind, or --desc`,
    usage,
  );
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

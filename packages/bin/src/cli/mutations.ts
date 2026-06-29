/**
 * Mutation command handlers for the CLI write surface (Phase 3).
 * Each handler receives a `Ctx` built once in `run.ts` and shared across all
 * write verbs. Tasks 4–8 will add more handlers here and cases to `run.ts`.
 */

import {
  abandonTask,
  annotate,
  attachArtifact,
  blockTask,
  completeTask,
  createInitiative,
  createPhase,
  createProject,
  createTask,
  depend,
  findArtifactByRef,
  findNodeByRef,
  getArtifact,
  moveNode,
  parseIdentity,
  notFound,
  parkTask,
  reorder,
  reopenTask,
  resolveEntityToken,
  returnTask,
  startTask,
  submitTask,
  tagEntities,
  unblockTask,
  undepend,
  unparkTask,
  untagEntities,
  updateArtifact,
  updateNode,
  updateProject,
  validation,
} from '../core';
import type { Db, RankPosition, UpdateFields, UpdateProjectFields } from '../core';
import { usage } from './errors';
import { parsePriority, parseSize } from './parse';
import { renderArtifactDetail } from './render';
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
  db: Db;
  /** Full positionals including the verb at [0]. */
  positionals: string[];
  values: Record<string, unknown>;
  format: Format;
  io: Io;
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
  const id = await resolveNode(c.db, requirePos(c, 1, 'start'), 'task');
  await startTask(c.db, id);
  await echoNodeWith(c.db, id, c.format, c.io, (rid) => `started ${rid} · todo → in_progress`);
  return 0;
}

export async function cmdDone(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, 'done'), 'task');
  await completeTask(c.db, id);
  await echoNodeWith(c.db, id, c.format, c.io, (rid) => `completed ${rid}`);
  return 0;
}

export async function cmdAbandon(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, 'abandon'), 'task');
  const reason = reasonTail(c);
  await abandonTask(c.db, id, reason);
  await echoNodeWith(c.db, id, c.format, c.io, (rid) => withReason(`abandoned ${rid}`, reason));
  return 0;
}

export async function cmdSubmit(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, 'submit'), 'task');
  await submitTask(c.db, id);
  await echoNodeWith(
    c.db,
    id,
    c.format,
    c.io,
    (rid) => `submitted ${rid} · in_progress → under_review`,
  );
  return 0;
}

export async function cmdReturn(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, 'return'), 'task');
  const reason = reasonTail(c);
  await returnTask(c.db, id, reason);
  await echoNodeWith(c.db, id, c.format, c.io, (rid) =>
    withReason(`returned ${rid} · under_review → in_progress`, reason),
  );
  return 0;
}

export async function cmdReopen(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, 'reopen'), 'task');
  const reason = reasonTail(c);
  await reopenTask(c.db, id, reason);
  await echoNodeWith(c.db, id, c.format, c.io, (rid) =>
    withReason(`reopened ${rid} → in_progress`, reason),
  );
  return 0;
}

const reasonTail = (c: Ctx): string | undefined => c.positionals.slice(2).join(' ') || undefined;

export async function cmdPark(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, 'park'), 'task');
  const reason = reasonTail(c);
  await parkTask(c.db, id, reason);
  await echoNodeWith(c.db, id, c.format, c.io, (rid) => withReason(`parked ${rid}`, reason));
  return 0;
}

export async function cmdUnpark(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, 'unpark'), 'task');
  await unparkTask(c.db, id);
  await echoNodeWith(c.db, id, c.format, c.io, (rid) => `unparked ${rid}`);
  return 0;
}

export async function cmdBlock(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, 'block'), 'task');
  const reason = reasonTail(c);
  await blockTask(c.db, id, reason);
  await echoNodeWith(c.db, id, c.format, c.io, (rid) => withReason(`blocked ${rid}`, reason));
  return 0;
}

export async function cmdUnblock(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, 'unblock'), 'task');
  await unblockTask(c.db, id);
  await echoNodeWith(c.db, id, c.format, c.io, (rid) => `unblocked ${rid}`);
  return 0;
}

async function resolveIds(db: Db, csv: string, verb: string, flag: string): Promise<number[]> {
  const tokens = csv.split(',').map((t) => requireToken(t, verb, flag).trim());
  return Promise.all(tokens.map((t) => resolveNode(db, t)));
}

/** Clean a comma-separated id list back to a display string (`MMR-3, MMR-4`). */
const idList = (csv: string): string =>
  csv
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .join(', ');

export async function cmdDepend(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, 'depend'));
  const on = lastFlag(c, 'on');
  if (on === undefined) {
    throw usage('depend requires --on <ids>');
  }
  await depend(c.db, id, await resolveIds(c.db, on, 'depend', 'on'));
  await echoNodeWith(c.db, id, c.format, c.io, (rid) => `${rid} now depends on ${idList(on)}`);
  return 0;
}

export async function cmdUndepend(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, 'undepend'));
  const on = lastFlag(c, 'on');
  if (on === undefined) {
    throw usage('undepend requires --on <ids>');
  }
  await undepend(c.db, id, await resolveIds(c.db, on, 'undepend', 'on'));
  await echoNodeWith(
    c.db,
    id,
    c.format,
    c.io,
    (rid) => `${rid} no longer depends on ${idList(on)}`,
  );
  return 0;
}

export async function cmdMove(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, 'move'));
  if (typeof c.values.to !== 'string') {
    throw usage('move requires --to <parent>');
  }
  const to = requireToken(c.values.to, 'move', 'to');
  const parentId = await resolveNode(c.db, to);
  await moveNode(c.db, id, parentId);
  await echoNodeWith(c.db, id, c.format, c.io, (rid) => `moved ${rid} → ${to}`);
  return 0;
}

export async function cmdReorder(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, 'reorder'), 'task');
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
    refId = await resolveNode(c.db, ref);
    where = `before ${ref}`;
  } else if (after !== undefined) {
    position = 'after';
    const ref = requireToken(after, 'reorder', 'after');
    refId = await resolveNode(c.db, ref);
    where = `after ${ref}`;
  } else {
    throw usage('reorder requires one of --top | --bottom | --before <id> | --after <id>');
  }
  await reorder(c.db, id, position, refId);
  await echoNodeWith(c.db, id, c.format, c.io, (rid) => `reordered ${rid} → ${where}`);
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
  const id = await resolveNode(c.db, token);
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
  await updateNode(c.db, id, fields);
  const suffix = changed.length > 0 ? ` (${changed.join(', ')})` : '';
  await echoNodeWith(c.db, id, c.format, c.io, (rid) => `updated ${rid}${suffix}`);
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
  ] as const) {
    if (c.values[key] !== undefined) {
      throw validation(`${flag} doesn't apply to a project — use --name to rename it`);
    }
  }
  const projectId = await resolveProject(c.db, token);
  const fields: UpdateProjectFields = {};
  if (typeof c.values.name === 'string') {
    fields.name = c.values.name;
  }
  if (typeof c.values.desc === 'string') {
    fields.description = c.values.desc;
  }
  await updateProject(c.db, projectId, fields);
  await echoProject(c.db, token, c.format, c.io);
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
  ] as const) {
    if (c.values[key] !== undefined) {
      throw validation(`${flag} doesn't apply to an artifact — title is its one mutable field`);
    }
  }
  const identity = parseIdentity(token);
  if (identity?.kind !== 'artifact') {
    throw notFound(`no artifact with id ${token}`);
  }
  const artifact = await findArtifactByRef(c.db, identity);
  if (artifact === undefined) {
    throw notFound(`no artifact ${token}`);
  }
  if (typeof c.values.title === 'string') {
    await updateArtifact(c.db, artifact.id, { title: c.values.title });
  }
  renderArtifactDetail(await getArtifact(c.db, token), c.format, c.io);
  return 0;
}

export async function cmdAnnotate(c: Ctx): Promise<number> {
  const id = await resolveNode(c.db, requirePos(c, 1, 'annotate'));
  const content = await readContent(c.positionals.slice(2), c.io);
  if (content === '') {
    throw usage('annotate requires content (positional or stdin)');
  }
  await annotate(c.db, id, content);
  await echoNodeWith(c.db, id, c.format, c.io, (rid) => `annotated ${rid}`);
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
    const nodes = await Promise.all(
      linkTokens.map(async (t) => {
        const n = await findNodeByRef(c.db, t);
        if (n === undefined) {
          throw notFound(`${t} doesn't exist`);
        }
        return n;
      }),
    );
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
      const explicit = await resolveProject(c.db, c.values.project);
      if (explicit !== projectId) {
        throw validation("--project disagrees with the links' project");
      }
    }
  } else {
    projectId = await resolveProject(
      c.db,
      strFlag(c, 'project', 'attach requires a link (KEY-seq) or --project <KEY>'),
    );
  }

  const explicitTitle = optStr(c, 'title');
  const basename = file?.split('/').pop();
  const title = explicitTitle ?? basename;
  if (title === undefined || title.trim() === '') {
    throw usage('attach from stdin requires --title <text>');
  }
  const { renderedId } = await attachArtifact(c.db, {
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
  const targets = await Promise.all(ids.map((t) => resolveEntityToken(c.db, t)));
  await tagEntities(c.db, targets, tags, optStr(c, 'note'));
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
  const targets = await Promise.all(ids.map((t) => resolveEntityToken(c.db, t)));
  await untagEntities(c.db, targets, tags);
  echoTagOp(c, 'untagged', ids, tags);
  return 0;
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
      const project = await createProject(c.db, {
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
        c.db,
        strFlag(c, 'parent', 'create initiative requires --parent <KEY>'),
      );
      if (parent.kind !== 'project') {
        throw usage("an initiative's parent must be a project (KEY)");
      }
      const node = await createInitiative(c.db, {
        description: optStr(c, 'desc'),
        projectId: parent.id,
        tags: tagFlags(c),
        title,
      });
      await echoNodeWith(c.db, node.id, c.format, c.io, (rid) => `created ${rid}`);
      return 0;
    }
    case 'phase': {
      const title = requirePos(c, 2, 'create phase', 'a title');
      const parent = await resolveParent(
        c.db,
        strFlag(c, 'parent', 'create phase requires --parent <id>'),
      );
      if (parent.kind !== 'node') {
        throw usage("a phase's parent must be an initiative (KEY-seq)");
      }
      const node = await createPhase(c.db, {
        description: optStr(c, 'desc'),
        parentId: parent.id,
        tags: tagFlags(c),
        target: optStr(c, 'target'),
        title,
      });
      await echoNodeWith(c.db, node.id, c.format, c.io, (rid) => `created ${rid}`);
      return 0;
    }
    case 'task': {
      const title = requirePos(c, 2, 'create task', 'a title');
      const parent = await resolveParent(
        c.db,
        strFlag(c, 'parent', 'create task requires --parent <id>'),
      );
      if (parent.kind !== 'node') {
        throw usage("a task's parent must be a phase or initiative (KEY-seq)");
      }
      const node = await createTask(c.db, {
        description: optStr(c, 'desc'),
        externalRef: optStr(c, 'ref'),
        parentId: parent.id,
        priority:
          typeof c.values.priority === 'string' ? parsePriority(c.values.priority) : undefined,
        size: typeof c.values.size === 'string' ? parseSize(c.values.size) : undefined,
        tags: tagFlags(c),
        title,
      });
      await echoNodeWith(c.db, node.id, c.format, c.io, (rid) => `created ${rid}`);
      return 0;
    }
    default: {
      throw usage(
        `create: unknown type ${type ?? '(none)'} (expected project|initiative|phase|task)`,
      );
    }
  }
}

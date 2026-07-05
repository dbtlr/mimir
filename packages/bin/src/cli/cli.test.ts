import { afterEach, beforeEach, expect, test } from 'bun:test';

import { parseJson } from '@mimir/helpers';

import {
  createInitiative,
  createPhase,
  createProject,
  createSqliteStore,
  createTask,
  depend,
  notFound,
} from '../core';
import type { Db, Store } from '../core';
import { createTestDb } from '../db/testing';
import { UsageError, exitCodeFor, renderError } from './errors';
import { runCli } from './run';
import { fakeIo } from './testing';

let db: Db;
let store: Store;
let phaseId: number;
beforeEach(async () => {
  db = await createTestDb();
  store = createSqliteStore(db);
  const p = await createProject(store, { key: 'MMR', name: 'm' });
  const init = await createInitiative(store, { projectId: p.id, title: 'i' });
  const phase = await createPhase(store, { parentId: init.id, title: 'ph' });
  phaseId = phase.id;
});
afterEach(async () => {
  await db.destroy();
});

test('no command prints help and exits 0', async () => {
  const io = fakeIo(true);
  expect(await runCli([], () => store, io)).toBe(0);
  expect(io.out.join('')).toContain('usage: mimir');
});

test('unknown command exits 2 with an error', async () => {
  const io = fakeIo(true);
  expect(await runCli(['frobnicate'], () => store, io)).toBe(2);
  expect(io.err.join('')).toContain('unknown command');
  expect(io.out).toHaveLength(0);
});

// The provider throws if asked: data-free paths must complete without it.
const neverStore = (): Store => {
  throw new Error('store acquired on a data-free path');
};

// The schema migrator must never run on a help path (MMR-159).
const neverMigrateSchema = (): Promise<number> => {
  throw new Error('schema migrator ran on a data-free path');
};

test('help, usage errors, and unknown commands never acquire the store (MMR-39)', async () => {
  expect(await runCli([], neverStore, fakeIo(true))).toBe(0);
  expect(await runCli(['--help'], neverStore, fakeIo(true))).toBe(0);
  expect(await runCli(['frobnicate'], neverStore, fakeIo(true))).toBe(2);
});

test('per-command -h prints that command, not the generic help (MMR-118)', async () => {
  const io = fakeIo(true);
  expect(await runCli(['update', '-h'], neverStore, io)).toBe(0);
  const out = io.out.join('');
  expect(out).toContain('mimir update <id>');
  expect(out).toContain('--desc'); // the flag the dogfood hunt couldn't find
  expect(out).not.toContain('read commands:'); // not the top-level dump
});

test('per-command --help adds examples; -h omits them (MMR-118)', async () => {
  const terse = fakeIo(true);
  await runCli(['depend', '-h'], neverStore, terse);
  expect(terse.out.join('')).toContain('--on');
  expect(terse.out.join('')).not.toContain('examples:');

  const full = fakeIo(true);
  await runCli(['depend', '--help'], neverStore, full);
  expect(full.out.join('')).toContain('examples:');
  expect(full.out.join('')).toContain('mimir depend MMR-4 --on MMR-3');
});

test('create <type> --help dispatches on the subcommand (MMR-118)', async () => {
  const io = fakeIo(true);
  expect(await runCli(['create', 'task', '--help'], neverStore, io)).toBe(0);
  const out = io.out.join('');
  expect(out).toContain('mimir create task');
  expect(out).toContain('--parent');
});

test('per-command help never acquires the store (MMR-118, MMR-39)', async () => {
  for (const verb of ['update', 'create', 'attach', 'move', 'reorder', 'tag', 'annotate']) {
    expect(await runCli([verb, '-h'], neverStore, fakeIo(true))).toBe(0);
  }
});

test('help for a verb without a descriptor falls back to the top-level help', async () => {
  const io = fakeIo(true);
  expect(await runCli(['frobnicate', '-h'], neverStore, io)).toBe(0);
  expect(io.out.join('')).toContain('usage: mimir');
});

// ── migrate namespace (MMR-159) ──────────────────────────────────────────

test('migrate schema dispatches to the injected schema migrator', async () => {
  const calls: (string | undefined)[] = [];
  const migrateSchema = (sub: string | undefined): Promise<number> => {
    calls.push(sub);
    return Promise.resolve(0);
  };
  expect(await runCli(['migrate', 'schema'], neverStore, fakeIo(true), { migrateSchema })).toBe(0);
  expect(
    await runCli(['migrate', 'schema', 'status'], neverStore, fakeIo(true), { migrateSchema }),
  ).toBe(0);
  expect(calls).toEqual([undefined, 'status']);
});

test('migrate schema --help prints help without running the migrator or the store (MMR-159)', async () => {
  const io = fakeIo(true);
  expect(
    await runCli(['migrate', 'schema', '--help'], neverStore, io, {
      migrateSchema: neverMigrateSchema,
    }),
  ).toBe(0);
  expect(io.out.join('')).toContain('mimir migrate');
});

test('migrate schema survives a global flag before the verb (MMR-159)', async () => {
  const calls: (string | undefined)[] = [];
  const migrateSchema = (sub: string | undefined): Promise<number> => {
    calls.push(sub);
    return Promise.resolve(0);
  };
  expect(
    await runCli(['--ascii', 'migrate', 'schema'], neverStore, fakeIo(true), { migrateSchema }),
  ).toBe(0);
  expect(calls).toEqual([undefined]);
});

test('bare migrate lists subcommands and never acquires the store (MMR-159)', async () => {
  const io = fakeIo(true);
  expect(await runCli(['migrate'], neverStore, io)).toBe(0);
  expect(io.out.join('')).toContain('artifacts');
});

test('unknown migrate subcommand exits 2 without acquiring the store (MMR-159)', async () => {
  const io = fakeIo(true);
  expect(await runCli(['migrate', 'bogus'], neverStore, io)).toBe(2);
  expect(io.err.join('')).toContain("unknown migrate subcommand 'bogus'");
});

test('migrate artifacts --dry-run counts the source inventory (MMR-159)', async () => {
  const io = fakeIo(true);
  expect(
    await runCli(['migrate', 'artifacts', '--dry-run'], () => store, io, { db: () => db }),
  ).toBe(0);
  expect(io.out.join('')).toContain('dry-run');
});

test('archive freezes the project; unarchive restores it (MMR-121)', async () => {
  const task = await createTask(store, { parentId: phaseId, title: 'x' });
  const id = `MMR-${String(task.seq)}`;

  // archive echoes a signpost and exits 0
  const arc = fakeIo(true);
  expect(await runCli(['archive', 'MMR', 'superseded'], () => store, arc)).toBe(0);
  expect(arc.out.join('')).toContain('archived MMR');
  expect(arc.out.join('')).toContain('superseded');

  // a mutation under the archived project is rejected (conflict → exit 1)
  const froze = fakeIo(true);
  expect(await runCli(['start', id], () => store, froze)).toBe(1);
  expect(froze.err.join('')).toContain('archived');

  // unarchive restores; the same mutation now works
  const un = fakeIo(true);
  expect(await runCli(['unarchive', 'MMR'], () => store, un)).toBe(0);
  expect(un.out.join('')).toContain('unarchived MMR');
  expect(await runCli(['start', id], () => store, fakeIo(true))).toBe(0);
});

test('archive hides the project from reads; the --status archived door reveals it (MMR-122)', async () => {
  const task = await createTask(store, { parentId: phaseId, title: 'x' });
  const id = `MMR-${String(task.seq)}`;
  await runCli(['archive', 'MMR'], () => store, fakeIo(true));

  // hidden from list and from direct get (project + node)
  const list = fakeIo(true);
  await runCli(['list', '-s', 'all', '--status', 'all', '-f', 'ids'], () => store, list);
  expect(list.out.join('')).not.toContain(id);
  expect(await runCli(['get', 'MMR'], () => store, fakeIo(true))).toBe(1);
  expect(await runCli(['get', id], () => store, fakeIo(true))).toBe(1);

  // the door lists the archived project
  const door = fakeIo(true);
  expect(await runCli(['list', '--status', 'archived'], () => store, door)).toBe(0);
  expect(door.out.join('')).toContain('MMR');

  // unarchive restores it
  await runCli(['unarchive', 'MMR'], () => store, fakeIo(true));
  expect(await runCli(['get', 'MMR'], () => store, fakeIo())).toBe(0);
});

test('archive warns about released cross-project dependents (MMR-124)', async () => {
  const mmrTask = await createTask(store, { parentId: phaseId, title: 'prereq' });
  // A task in another project depends on the MMR task (a cross-project edge).
  const aaa = await createProject(store, { key: 'AAA', name: 'a' });
  const aInit = await createInitiative(store, { projectId: aaa.id, title: 'i' });
  const aPhase = await createPhase(store, { parentId: aInit.id, title: 'ph' });
  const a1 = await createTask(store, { parentId: aPhase.id, title: 'a1' });
  await depend(store, a1.id, [mmrTask.id]);

  const io = fakeIo(true);
  expect(await runCli(['archive', 'MMR'], () => store, io)).toBe(0);
  const out = io.out.join('');
  expect(out).toContain('archived MMR');
  expect(out).toContain('released');
  expect(out).toContain(`AAA-${String(a1.seq)}`);
});

test('archive --format json echoes the project with its archived_at (MMR-121)', async () => {
  const io = fakeIo();
  expect(await runCli(['archive', 'MMR', '--format', 'json'], () => store, io)).toBe(0);
  const parsed = parseJson<{ project: { key: string; archived_at: string | null } }>(
    io.out.join(''),
  );
  expect(parsed.project.key).toBe('MMR');
  expect(parsed.project.archived_at).not.toBeNull();
});

test('archive -h prints the archive command help, not the generic dump (MMR-121)', async () => {
  const io = fakeIo(true);
  expect(await runCli(['archive', '-h'], neverStore, io)).toBe(0);
  const out = io.out.join('');
  expect(out).toContain('mimir archive <KEY>');
  expect(out).not.toContain('read commands:');
});

test('next --format json lists ready tasks (count-led envelope)', async () => {
  await createTask(store, { parentId: phaseId, priority: 'p1', title: 'first' });
  const io = fakeIo();
  expect(await runCli(['next', '--scope', 'MMR', '--format', 'json'], () => store, io)).toBe(0);
  const parsed = parseJson<{ total: number; tasks: { title: string }[] }>(io.out.join(''));
  expect(parsed.total).toBe(1);
  expect(parsed.tasks[0]?.title).toBe('first');
});

test('next default is the informative table view whether piped or TTY (MMR-87)', async () => {
  const t = await createTask(store, { parentId: phaseId, title: 'x' });
  const id = `MMR-${String(t.seq)}`;

  // Piped (non-TTY): the same informative table content, not a bare id.
  const piped = fakeIo(false);
  await runCli(['next', '--scope', 'MMR'], () => store, piped);
  const pipedText = piped.out.join('');
  expect(pipedText).toContain('1 task');
  expect(pipedText).toContain(id);
  expect(pipedText).toContain('ready');
  expect(pipedText).not.toBe(id);

  // TTY: identical information (decoration differs, content does not).
  const tty = fakeIo(true);
  await runCli(['next', '--scope', 'MMR'], () => store, tty);
  const ttyText = tty.out.join('');
  expect(ttyText).toContain('1 task');
  expect(ttyText).toContain(id);
  expect(ttyText).toContain('ready');

  // Bare ids only on explicit -f ids (the composable pipeline opt-in).
  const ids = fakeIo(false);
  await runCli(['next', '--scope', 'MMR', '-f', 'ids'], () => store, ids);
  expect(ids.out.join('')).toBe(id);
});

test('list piped default is the table view, not bare ids (MMR-87)', async () => {
  await createTask(store, { parentId: phaseId, title: 'alpha' });
  const piped = fakeIo(false);
  await runCli(['list', '--scope', 'MMR', '--status', 'ready'], () => store, piped);
  const text = piped.out.join('');
  expect(text).toContain('task');
  expect(text).toContain('alpha');
  expect(text).toContain('MMR-');
});

test('get returns a record; a missing id exits non-zero', async () => {
  const t = await createTask(store, { parentId: phaseId, title: 'deep' });
  const ok = fakeIo();
  expect(await runCli(['get', `MMR-${String(t.seq)}`, '--format', 'json'], () => store, ok)).toBe(
    0,
  );
  expect(parseJson<{ title: string }>(ok.out.join('')).title).toBe('deep');

  const missing = fakeIo();
  expect(await runCli(['get', 'MMR-999'], () => store, missing)).toBe(1);
  expect(missing.err.join('')).toContain('[err]');
  expect(missing.out).toHaveLength(0);
});

test('get piped default is the records view, not a bare id (MMR-87)', async () => {
  const t = await createTask(store, { parentId: phaseId, title: 'deep' });
  const id = `MMR-${String(t.seq)}`;

  const piped = fakeIo(false);
  await runCli(['get', id], () => store, piped);
  const text = piped.out.join('');
  expect(text).toContain(id);
  expect(text).toContain('title');
  expect(text).toContain('deep');
  expect(text).toContain('status');
  expect(text).not.toBe(id);

  // ids still available explicitly.
  const ids = fakeIo(false);
  await runCli(['get', id, '-f', 'ids'], () => store, ids);
  expect(ids.out.join('')).toBe(id);
});

test('status reports the rollup of a non-leaf', async () => {
  await createTask(store, { parentId: phaseId, title: 't1' });
  const phase = await db
    .selectFrom('node')
    .select('seq')
    .where('id', '=', phaseId)
    .executeTakeFirstOrThrow();
  const io = fakeIo();
  expect(
    await runCli(['status', `MMR-${String(phase.seq)}`, '--format', 'json'], () => store, io),
  ).toBe(0);
  const parsed = parseJson<{ status: string }>(io.out.join(''));
  expect(parsed.status).toBe('ready');
});

test('an invalid flag value is a usage error → exit 2', async () => {
  const io = fakeIo();
  expect(await runCli(['next', '--priority', 'p9'], () => store, io)).toBe(2);
  expect(io.err.join('')).toContain('invalid priority');
});

test('list --status selects the matching universe', async () => {
  await createTask(store, { parentId: phaseId, title: 'a' });
  const io = fakeIo();
  await runCli(['list', '--scope', 'MMR', '--status', 'ready', '--format', 'ids'], () => store, io);
  expect(io.out.join('')).toContain('MMR-');
});

test('--predicate is gone — unknown flag is a usage error', async () => {
  const io = fakeIo();
  expect(await runCli(['list', '--predicate', 'ready'], () => store, io)).toBe(2);
});

test('a bad --format value is a usage error → exit 2', async () => {
  const io = fakeIo(false);
  expect(await runCli(['next', '-f', 'bogus'], () => store, io)).toBe(2);
  expect(io.out).toHaveLength(0);
});

test('renderError + exitCodeFor: json format produces structured envelope', () => {
  const err = notFound('no node MMR-9', 'hint text');
  const io = fakeIo(true);
  renderError(err, 'json', io);
  const parsed = parseJson<{
    error: { code: string; message: string; hint: string };
  }>(io.err.join(''));
  expect(parsed.error.code).toBe('not_found');
  expect(parsed.error.message).toBe('no node MMR-9');
  expect(parsed.error.hint).toBe('hint text');
});

test('renderError: jsonl format produces same structured envelope as json', () => {
  const err = notFound('no node MMR-9', 'hint text');
  const io = fakeIo(true);
  renderError(err, 'jsonl', io);
  const parsed = parseJson<{
    error: { code: string; message: string; hint: string };
  }>(io.err.join(''));
  expect(parsed.error.code).toBe('not_found');
  expect(parsed.error.message).toBe('no node MMR-9');
  expect(parsed.error.hint).toBe('hint text');
});

test('renderError + exitCodeFor: records format produces [err] line and note: line (plain)', () => {
  const err = notFound('no node MMR-9', 'hint text');
  const io = fakeIo(false);
  renderError(err, 'records', io);
  const output = io.err.join('\n');
  expect(output).toContain('[err]');
  expect(output).toContain('note:');
});

test('exitCodeFor returns 1 for MimirError and 2 for UsageError', () => {
  const mimirErr = notFound('no node MMR-9');
  const usageErr = new UsageError('bad invocation');
  expect(exitCodeFor(mimirErr)).toBe(1);
  expect(exitCodeFor(usageErr)).toBe(2);
});

// addressability (MMR-32): the full id grammar at the CLI surface

test('get on a bare KEY renders the whole-project view', async () => {
  const io = fakeIo(false);
  expect(await runCli(['get', 'MMR', '-f', 'json'], () => store, io)).toBe(0);
  const parsed = parseJson<{ id: string; type: string }>(io.out.join(''));
  expect(parsed.id).toBe('MMR');
  expect(parsed.type).toBe('project');
});

test('a task verb on a project KEY is a behavioral error (validation → exit 1)', async () => {
  const io = fakeIo(false);
  expect(await runCli(['done', 'MMR'], () => store, io)).toBe(1);
  expect(io.err.join('')).toContain('MMR is a project, not a task');
  expect(io.out).toHaveLength(0);
});

test('attach echoes KEY-aN and get reads the artifact back', async () => {
  const t = await createTask(store, { parentId: phaseId, title: 't' });
  const tmp = `${process.env.TMPDIR ?? '/tmp'}/mimir-aid.md`;
  await Bun.write(tmp, '# body\n');
  // -f ids is the composable id-capture form the skill teaches (ID=$(… -f ids)).
  const io = fakeIo(false);
  expect(
    await runCli(['attach', `MMR-${String(t.seq)}`, '--file', tmp, '-f', 'ids'], () => store, io),
  ).toBe(0);
  expect(io.out.join('')).toBe('MMR-a1');

  // The default piped echo is the human confirmation line, carrying the id (MMR-87).
  const conf = fakeIo(false);
  await runCli(['attach', `MMR-${String(t.seq)}`, '--file', tmp], () => store, conf);
  expect(conf.out.join('')).toContain('MMR-a');

  const read = fakeIo(false);
  expect(await runCli(['get', 'MMR-a1', '-f', 'json'], () => store, read)).toBe(0);
  const parsed = parseJson<{ id: string; links: string[] }>(read.out.join(''));
  expect(parsed.id).toBe('MMR-a1');
  expect(parsed.links).toEqual([`MMR-${String(t.seq)}`]);
});

test('a task verb on an artifact id is a behavioral error', async () => {
  const io = fakeIo(false);
  expect(await runCli(['start', 'MMR-a1'], () => store, io)).toBe(1);
  expect(io.err.join('')).toContain('MMR-a1 is an artifact, not a task');
});

// tag write surface (MMR-31)

test('tag and untag round-trip through the CLI', async () => {
  const t = await createTask(store, { parentId: phaseId, title: 't' });
  const ref = `MMR-${String(t.seq)}`;
  const io = fakeIo(false);
  expect(await runCli(['tag', `${ref},MMR`, 'spec', 'v2', '-f', 'json'], () => store, io)).toBe(0);
  expect(JSON.parse(io.out.join(''))).toEqual({
    tagged: { ids: [ref, 'MMR'], tags: ['spec', 'v2'] },
  });

  const read = fakeIo(false);
  await runCli(['get', ref, '-f', 'json'], () => store, read);
  const view = parseJson<{ tags: { tag: string }[] }>(read.out.join(''));
  expect(view.tags.map((x) => x.tag)).toEqual(['spec', 'v2']);

  const rm = fakeIo(false);
  expect(await runCli(['untag', ref, 'v2', '-f', 'json'], () => store, rm)).toBe(0);
  const reread = fakeIo(false);
  await runCli(['get', ref, '-f', 'json'], () => store, reread);
  const after = parseJson<{ tags: { tag: string }[] }>(reread.out.join(''));
  expect(after.tags.map((x) => x.tag)).toEqual(['spec']);
});

test('tag without tags is a usage error', async () => {
  const io = fakeIo(false);
  expect(await runCli(['tag', 'MMR-1'], () => store, io)).toBe(2);
  expect(io.err.join('')).toContain('at least one tag');
});

test('create task --tag applies creation-time tags', async () => {
  const io = fakeIo(false);
  const phase = await db
    .selectFrom('node')
    .select('seq')
    .where('id', '=', phaseId)
    .executeTakeFirstOrThrow();
  const code = await runCli(
    [
      'create',
      'task',
      'tt',
      '--parent',
      `MMR-${String(phase.seq)}`,
      '--tag',
      'spec',
      '--tag',
      'v2',
      '-f',
      'json',
    ],
    () => store,
    io,
  );
  expect(code).toBe(0);
  const echoed = parseJson<{ id: string }>(io.out.join(''));
  const read = fakeIo(false);
  await runCli(['get', echoed.id, '-f', 'json'], () => store, read);
  const view = parseJson<{ tags: { tag: string }[] }>(read.out.join(''));
  expect(view.tags.map((x) => x.tag)).toEqual(['spec', 'v2']);
});

// query surface v2 (MMR-33)

test('a value miss warns on stderr and exits 0 with an empty set', async () => {
  await createTask(store, { parentId: phaseId, priority: 'p1', title: 'a' });
  const io = fakeIo(true);
  const code = await runCli(
    ['list', '--scope', 'MMR', '--eq', 'priority:p9', '--ascii'],
    () => store,
    io,
  );
  expect(code).toBe(0);
  expect(io.out.join('')).toContain('0 tasks');
  expect(io.err.join('\n')).toContain('[warn] p9 is not a priority');
  expect(io.err.join('\n')).toContain('expected p0, p1, p2, p3');
});

test('a value miss in json format emits the warning envelope on stderr', async () => {
  const io = fakeIo(false);
  const code = await runCli(['list', '--eq', 'priority:p9', '-f', 'json'], () => store, io);
  expect(code).toBe(0);
  const warning = parseJson<{
    warning: { code: string; field: string; value: string; expected: string[] };
  }>(io.err.join(''));
  expect(warning.warning.code).toBe('no_match_value');
  expect(warning.warning.field).toBe('priority');
  expect(warning.warning.expected).toEqual(['p0', 'p1', 'p2', 'p3']);
  // stdout still carries the (empty) result
  expect(parseJson<{ total: number }>(io.out.join('')).total).toBe(0);
});

test('an unknown field is a usage error (exit 2)', async () => {
  const io = fakeIo(false);
  expect(await runCli(['list', '--eq', 'bogus:x'], () => store, io)).toBe(2);
  expect(io.err.join('')).toContain('unknown field bogus');
});

test('a date op on a non-date field is a usage error (exit 2)', async () => {
  const io = fakeIo(false);
  expect(await runCli(['list', '--before', 'priority:p1'], () => store, io)).toBe(2);
});

test('--is/--not-is select verdicts; --status picks the universe', async () => {
  const a = await createTask(store, { parentId: phaseId, title: 'a' });
  const b = await createTask(store, { parentId: phaseId, title: 'b' });
  const aRef = `MMR-${String(a.seq)}`;
  const bRef = `MMR-${String(b.seq)}`;
  await runCli(['depend', bRef, '--on', aRef], () => store, fakeIo(false));

  const blocking = fakeIo(false);
  await runCli(['list', '-s', 'MMR', '--is', 'blocking', '-f', 'ids'], () => store, blocking);
  expect(blocking.out.join('')).toBe(aRef);

  const awaiting = fakeIo(false);
  await runCli(['list', '-s', 'MMR', '--status', 'awaiting', '-f', 'ids'], () => store, awaiting);
  expect(awaiting.out.join('')).toBe(bRef);

  await runCli(['done', aRef], () => store, fakeIo(false));
  const terminal = fakeIo(false);
  await runCli(['list', '-s', 'MMR', '--status', 'terminal', '-f', 'ids'], () => store, terminal);
  expect(terminal.out.join('')).toBe(aRef);
});

test('depend --on still works as a write flag alongside the date op', async () => {
  const a = await createTask(store, { parentId: phaseId, title: 'a' });
  const b = await createTask(store, { parentId: phaseId, title: 'b' });
  const io = fakeIo(false);
  const code = await runCli(
    ['depend', `MMR-${String(b.seq)}`, '--on', `MMR-${String(a.seq)}`, '-f', 'json'],
    () => store,
    io,
  );
  expect(code).toBe(0);
  expect(parseJson<{ status: string }>(io.out.join('')).status).toBe('awaiting');
});

// artifact title + readback (MMR-34)

test('attach defaults title from the file basename; --title overrides; --tag classifies', async () => {
  const t = await createTask(store, { parentId: phaseId, title: 't' });
  const ref = `MMR-${String(t.seq)}`;
  const tmp = `${process.env.TMPDIR ?? '/tmp'}/dogfood-plan.md`;
  await Bun.write(tmp, '# body\n');

  const io = fakeIo(false);
  await runCli(['attach', ref, '--file', tmp, '--tag', 'spec'], () => store, io);
  const read = fakeIo(false);
  await runCli(['get', 'MMR-a1', '-f', 'json'], () => store, read);
  const detail = parseJson<{ title: string; tags: string[] }>(read.out.join(''));
  expect(detail.title).toBe('dogfood-plan.md');
  expect(detail.tags).toEqual(['spec']);

  const io2 = fakeIo(false);
  await runCli(['attach', ref, '--file', tmp, '--title', 'the plan'], () => store, io2);
  const read2 = fakeIo(false);
  await runCli(['get', 'MMR-a2', '-f', 'json'], () => store, read2);
  expect(parseJson<{ title: string }>(read2.out.join('')).title).toBe('the plan');
});

test('attach from stdin without --title is a usage error', async () => {
  const t = await createTask(store, { parentId: phaseId, title: 't' });
  const io = fakeIo(true); // TTY → no stdin content either, but flag check comes after content
  const code = await runCli(['attach', `MMR-${String(t.seq)}`], () => store, io);
  expect(code).toBe(2);
});

test('get KEY-aN --col content returns the frozen body', async () => {
  const t = await createTask(store, { parentId: phaseId, title: 't' });
  const tmp = `${process.env.TMPDIR ?? '/tmp'}/body.md`;
  await Bun.write(tmp, '# the frozen body\n');
  await runCli(['attach', `MMR-${String(t.seq)}`, '--file', tmp], () => store, fakeIo(false));

  const bare = fakeIo(false);
  await runCli(['get', 'MMR-a1', '-f', 'json'], () => store, bare);
  expect(parseJson<object>(bare.out.join(''))).not.toHaveProperty('content');

  const withContent = fakeIo(false);
  await runCli(['get', 'MMR-a1', '--col', 'content', '-f', 'json'], () => store, withContent);
  const parsed = parseJson<{ content: string }>(withContent.out.join(''));
  expect(parsed.content).toBe('# the frozen body\n');
});

// create project positional name (MMR-35)

test('create project accepts a positional name', async () => {
  const io = fakeIo(false);
  const code = await runCli(
    ['create', 'project', 'Other Tool', '--key', 'OTH', '-y', '-f', 'json'],
    () => store,
    io,
  );
  expect(code).toBe(0);
  expect(JSON.parse(io.out.join(''))).toEqual({ project: { key: 'OTH', name: 'Other Tool' } });
});

test('create project still accepts --name and errors without either', async () => {
  const io = fakeIo(false);
  expect(
    await runCli(['create', 'project', '--key', 'FLG', '--name', 'Flagged', '-y'], () => store, io),
  ).toBe(0);
  const bad = fakeIo(false);
  expect(await runCli(['create', 'project', '--key', 'BAD', '-y'], () => store, bad)).toBe(2);
  expect(bad.err.join('')).toContain('requires a name');
});

// flat --col vocabulary (MMR-38)

// self-update flag wiring (MMR-57)

test('self-update --tag requires a value (usage error, exit 2)', async () => {
  const io = fakeIo();
  const code = await runCli(
    ['self-update', '--tag'],
    () => {
      throw new Error('db must not open');
    },
    io,
  );
  expect(code).toBe(2);
});

test('--col takes flat column names; the dot form is a usage error', async () => {
  const t = await createTask(store, { parentId: phaseId, title: 't' });
  const ref = `MMR-${String(t.seq)}`;
  const io = fakeIo(false);
  await runCli(['get', ref, '--col', 'history', '-f', 'json'], () => store, io);
  const view = parseJson<{ history: unknown[] }>(io.out.join(''));
  expect(Array.isArray(view.history)).toBe(true);

  const dotted = fakeIo(false);
  expect(await runCli(['get', ref, '--col', '.history'], () => store, dotted)).toBe(2);
  expect(dotted.err.join('')).toContain('columns are flat now');

  const unknown = fakeIo(false);
  expect(await runCli(['get', ref, '--col', 'bogus'], () => store, unknown)).toBe(2);
  expect(unknown.err.join('')).toContain('unknown column: bogus');
});

// --type removal (MMR-94)

test('list --eq type:phase filters to phases only', async () => {
  // The db has one phase (phaseId) and a task; ensure --eq type:phase returns phase but not tasks.
  const t = await createTask(store, { parentId: phaseId, title: 'a task' });
  const io = fakeIo(false);
  const code = await runCli(
    ['list', '--scope', 'MMR', '--status', 'all', '--eq', 'type:phase', '-f', 'ids'],
    () => store,
    io,
  );
  expect(code).toBe(0);
  const out = io.out.join('');
  // Should contain a phase id (MMR-N) but not the task id
  expect(out).toContain('MMR-');
  expect(out).not.toContain(`MMR-${String(t.seq)}`);
});

test('--type is now an unknown option → rejected with exit 2 (MMR-94)', async () => {
  const io = fakeIo(false);
  const code = await runCli(['list', '--type', 'phase'], () => store, io);
  expect(code).toBe(2);
});

// MMR-95: empty set views print a clear no-results line on a TTY

test('next empty on a TTY prints a no-results line (MMR-95)', async () => {
  const io = fakeIo(true);
  const code = await runCli(['next', '--scope', 'MMR'], () => store, io);
  expect(code).toBe(0);
  const text = io.out.join('');
  expect(text).toMatch(/No ready tasks/i);
});

test('next empty on a non-TTY (piped) omits the no-results line (MMR-95)', async () => {
  const io = fakeIo(false);
  const code = await runCli(['next', '--scope', 'MMR'], () => store, io);
  expect(code).toBe(0);
  const text = io.out.join('');
  // No human message — piped output is structural only
  expect(text).not.toMatch(/No ready tasks/i);
  expect(text).not.toMatch(/No tasks/i);
});

test('list empty --status blocked on a TTY prints a no-results line (MMR-95)', async () => {
  const io = fakeIo(true);
  const code = await runCli(['list', '--scope', 'MMR', '--status', 'blocked'], () => store, io);
  expect(code).toBe(0);
  const text = io.out.join('');
  expect(text).toMatch(/No tasks/i);
});

test('next empty -f json produces unchanged structured output — no message leak (MMR-95)', async () => {
  const io = fakeIo(true);
  const code = await runCli(['next', '--scope', 'MMR', '-f', 'json'], () => store, io);
  expect(code).toBe(0);
  const parsed = parseJson<{ total: number; returned: number }>(io.out.join(''));
  expect(parsed.total).toBe(0);
  expect(parsed.returned).toBe(0);
  // No message text in the JSON output
  expect(io.out.join('')).not.toContain('No');
});

test('next empty -f ids produces empty output — no message leak (MMR-95)', async () => {
  const io = fakeIo(true);
  const code = await runCli(['next', '--scope', 'MMR', '-f', 'ids'], () => store, io);
  expect(code).toBe(0);
  // ids format on empty should be empty string (no message leak)
  expect(io.out.join('')).toBe('');
});

test('next empty -f records on a TTY prints a no-results line (MMR-95)', async () => {
  const io = fakeIo(true);
  const code = await runCli(['next', '--scope', 'MMR', '-f', 'records'], () => store, io);
  expect(code).toBe(0);
  const text = io.out.join('');
  expect(text).toMatch(/No ready tasks/i);
});

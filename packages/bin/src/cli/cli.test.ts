import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { parseJson } from '@mimir/helpers';

import {
  attachArtifact,
  blockTask,
  completeTask,
  createInitiative,
  createPhase,
  createProject,
  createTask,
  depend,
  getArtifact,
  notFound,
  startTask,
  updateNode,
  updateProject,
} from '../core';
import type { Store } from '../core';
import { createTestStore, nodeIdOf, projectIdOf } from '../testing/store';
import type { TestStore } from '../testing/store';
import { UsageError, exitCodeFor, renderError } from './errors';
import { runCli } from './run';
import { fakeIo } from './testing';

const NORN = Bun.which('norn') !== null;

let store: Store;
let closeStore: () => Promise<void>;
let phaseId: string;
let phaseSeq: number;
beforeEach(async () => {
  if (!NORN) {
    return;
  }
  ({ close: closeStore, store } = await createTestStore());
  await createProject(store, { key: 'MMR', name: 'm' });
  const init = await createInitiative(store, {
    projectId: await projectIdOf(store, 'MMR'),
    title: 'i',
  });
  const initId = await nodeIdOf(store, `MMR-${String(init.seq)}`);
  const phase = await createPhase(store, { parentId: initId, title: 'ph' });
  phaseId = await nodeIdOf(store, `MMR-${String(phase.seq)}`);
  phaseSeq = phase.seq;
});
afterEach(async () => {
  if (!NORN) {
    return;
  }
  await closeStore();
});

test.skipIf(!NORN)('no command prints help and exits 0', async () => {
  const io = fakeIo(true);
  expect(await runCli([], () => store, io)).toBe(0);
  expect(io.out.join('')).toContain('usage: mimir');
});

test.skipIf(!NORN)('unknown command exits 2 with an error', async () => {
  const io = fakeIo(true);
  expect(await runCli(['frobnicate'], () => store, io)).toBe(2);
  expect(io.err.join('')).toContain('unknown command');
  expect(io.out).toHaveLength(0);
});

// The provider throws if asked: data-free paths must complete without it.
const neverStore = (): Store => {
  throw new Error('store acquired on a data-free path');
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
  expect(out).not.toContain('work commands'); // not the top-level dump
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

test('skill/service/self-update print their own command help, not the top-level fallback (MMR-286)', async () => {
  // Machinery-plane verbs — previously undocumented in COMMAND_HELP, so `-h`
  // fell through to the top-level dump. Each now carries a descriptor.
  for (const [verb, usage] of [
    ['skill', 'mimir skill install'],
    ['service', 'mimir service <sub>'],
    ['self-update', 'mimir self-update'],
  ] as const) {
    const io = fakeIo(true);
    expect(await runCli([verb, '-h'], neverStore, io)).toBe(0);
    const out = io.out.join('');
    expect(out).toContain(usage);
    expect(out).not.toContain('usage: mimir <command>'); // not the top-level dump
  }
});

test("service <sub> -h renders that subcommand's own page, not the group page (MMR-299)", async () => {
  for (const [sub, usage] of [
    ['install', 'mimir service install ['],
    ['uninstall', 'mimir service uninstall ['],
    ['start', 'mimir service start ['],
    ['stop', 'mimir service stop ['],
    ['restart', 'mimir service restart ['],
    ['status', 'mimir service status'],
  ] as const) {
    const io = fakeIo(true);
    expect(await runCli(['service', sub, '-h'], neverStore, io)).toBe(0);
    const out = io.out.join('');
    expect(out).toContain(usage);
    expect(out).not.toContain('mimir service <sub>'); // not the group descriptor
  }
});

test('bare service -h still renders the group page listing every subcommand (MMR-299)', async () => {
  const io = fakeIo(true);
  expect(await runCli(['service', '-h'], neverStore, io)).toBe(0);
  const out = io.out.join('');
  expect(out).toContain('mimir service <sub>');
  expect(out).toContain('install | uninstall | start | stop | restart | status');
});

test('service install --help adds worked examples; -h omits them (MMR-299)', async () => {
  const terse = fakeIo(true);
  expect(await runCli(['service', 'install', '-h'], neverStore, terse)).toBe(0);
  const terseOut = terse.out.join('');
  expect(terseOut).toContain('--port');
  expect(terseOut).not.toContain('examples:');

  const full = fakeIo(true);
  expect(await runCli(['service', 'install', '--help'], neverStore, full)).toBe(0);
  const fullOut = full.out.join('');
  expect(fullOut).toContain('examples:');
  expect(fullOut).toContain('mimir service install snapshot');
});

test('service subcommand help never acquires the store (MMR-299, MMR-39)', async () => {
  for (const sub of ['install', 'uninstall', 'start', 'stop', 'restart', 'status']) {
    expect(await runCli(['service', sub, '-h'], neverStore, fakeIo(true))).toBe(0);
  }
});

test('serve/mcp/version print their own command help, not the top-level fallback (MMR-294)', async () => {
  // These three are machinery loners intercepted ahead of runCli in `main`
  // (ADR 0024) — the interception itself is proven by the from-source smoke,
  // not here. This covers the registry + dispatch half: once `main` lets
  // `-h`/`--help` fall through, runCli must render the verb's own help.
  for (const [verb, usage] of [
    ['serve', 'mimir serve ['],
    ['mcp', 'mimir mcp'],
    ['version', 'mimir version'],
  ] as const) {
    const io = fakeIo(true);
    expect(await runCli([verb, '-h'], neverStore, io)).toBe(0);
    const out = io.out.join('');
    expect(out).toContain(usage);
    expect(out).not.toContain('usage: mimir <command>'); // not the top-level dump
  }
});

test('serve/mcp/version --help adds examples; -h omits them (MMR-294)', async () => {
  for (const verb of ['serve', 'mcp', 'version']) {
    const terse = fakeIo(true);
    expect(await runCli([verb, '-h'], neverStore, terse)).toBe(0);
    expect(terse.out.join('')).not.toContain('examples:');

    const full = fakeIo(true);
    expect(await runCli([verb, '--help'], neverStore, full)).toBe(0);
    expect(full.out.join('')).toContain('examples:');
  }
});

test('serve/mcp/version help never acquires the store (MMR-294, MMR-39)', async () => {
  for (const verb of ['serve', 'mcp', 'version']) {
    expect(await runCli([verb, '-h'], neverStore, fakeIo(true))).toBe(0);
    expect(await runCli([verb, '--help'], neverStore, fakeIo(true))).toBe(0);
  }
});

test('serve --help renders even alongside its other flags, never a parse error (MMR-294)', async () => {
  // --no-hunt/--port are only ever read via argv.includes/indexOf in `main`,
  // but they still have to survive runCli's strict parseArgs on the -h/--help
  // fall-through (serve's own descriptor advertises --no-hunt as an example).
  for (const argv of [
    ['serve', '--no-hunt', '--help'],
    ['serve', '-h', '--no-hunt'],
    ['serve', '--port', '4100', '--help'],
  ]) {
    const io = fakeIo(true);
    expect(await runCli(argv, neverStore, io)).toBe(0);
    expect(io.out.join('')).toContain('mimir serve [');
    expect(io.err.join('')).toBe('');
  }
});

test('an unknown verb hard-errors (exit 2) even with -h/--help — never the help fallthrough (MMR-211)', async () => {
  for (const argv of [['frobnicate'], ['frobnicate', '-h'], ['frobnicate', '--help']]) {
    const io = fakeIo(true);
    expect(await runCli(argv, neverStore, io)).toBe(2);
    expect(io.err.join('')).toContain('unknown command: frobnicate');
    // No top-level help body leaks to stdout — that dump is the mined defect.
    expect(io.out.join('')).toBe('');
  }
});

test('the mined verbs add/edit error even with --help (MMR-211)', async () => {
  for (const verb of ['add', 'edit']) {
    const io = fakeIo(true);
    expect(await runCli([verb, '--help'], neverStore, io)).toBe(2);
    expect(io.out.join('')).toBe('');
    expect(io.err.join('')).toContain(`unknown command: ${verb}`);
  }
});

test('an unknown verb suggests the nearest command (MMR-211)', async () => {
  const io = fakeIo(true);
  expect(await runCli(['statuss'], neverStore, io)).toBe(2);
  expect(io.err.join('')).toContain("did you mean 'status'");
});

test('an unknown flag errors (exit 2) with a pointer, not the full help body (MMR-211, MMR-289)', async () => {
  const io = fakeIo(true);
  expect(await runCli(['get', 'MMR-1', '--bogus'], neverStore, io)).toBe(2);
  const err = io.err.join('');
  expect(err).toContain("unknown flag '--bogus'");
  expect(err).toContain('mimir get -h'); // concise pointer to the verb's flags
  expect(io.out.join('')).toBe('');
  // The 144-line top-level help body is gone — no command listing dumped.
  expect(err).not.toContain('work commands');
  // Library text never ships (MMR-289) — Node's own message, including its
  // verbose positional-argument advice, appears nowhere in the output.
  expect(err).not.toContain('Unknown option');
  expect(err).not.toContain('positional argument');
});

test('an unknown flag after a value-taking global flag points at the right verb (MMR-211)', async () => {
  // `-s alpha` must not be mistaken for the verb: the flag hint targets `get`.
  const io = fakeIo(true);
  expect(await runCli(['-s', 'alpha', 'get', '--bogus'], neverStore, io)).toBe(2);
  const err = io.err.join('');
  expect(err).toContain('mimir get -h');
  expect(err).not.toContain('for usage'); // not the generic top-level fallback
});

test('an unknown verb + an unknown flag surfaces the verb typo, not the flag error (MMR-211)', async () => {
  const io = fakeIo(true);
  expect(await runCli(['statuss', '--bogus'], neverStore, io)).toBe(2);
  const err = io.err.join('');
  expect(err).toContain('unknown command: statuss');
  expect(err).toContain("did you mean 'status'");
});

test('an ambiguous unknown short flag suggests nothing, not an arbitrary one (MMR-211)', async () => {
  // `-x` is one edit from -s/-t/-n/-f/-h/-y/-p — a tie, so no did-you-mean.
  const io = fakeIo(true);
  expect(await runCli(['list', '-x'], neverStore, io)).toBe(2);
  expect(io.err.join('')).not.toContain('did you mean');
});

test('unknown flag with a near match: house voice + did-you-mean, no library text (MMR-289)', async () => {
  const io = fakeIo(true);
  expect(await runCli(['list', '--statuz', 'ready'], neverStore, io)).toBe(2);
  const err = io.err.join('');
  expect(err).toContain("unknown flag '--statuz'");
  expect(err).toContain("note: did you mean '--status'?");
  // Exactly one hint — the help pointer isn't also stapled on.
  expect(err).not.toContain('mimir list -h');
  expect(err).not.toContain('Unknown option');
  expect(err).not.toContain('positional argument');
});

test('unknown flag with no near match: falls back to the verb help pointer (MMR-289)', async () => {
  const io = fakeIo(true);
  expect(await runCli(['list', '--frobnicate-completely-unknown'], neverStore, io)).toBe(2);
  const err = io.err.join('');
  expect(err).toContain("unknown flag '--frobnicate-completely-unknown'");
  expect(err).toContain("note: run 'mimir list -h' for its flags");
  expect(err).not.toContain('did you mean');
  expect(err).not.toContain('Unknown option');
  expect(err).not.toContain('positional argument');
});

test('create with a leading-dash title but no -- hits the strict unknown-flag error, hinting at the escape hatch (MMR-359)', async () => {
  const io = fakeIo(true);
  expect(
    await runCli(['create', 'task', '--parent', 'MMR-2', '--weird-title'], neverStore, io),
  ).toBe(2);
  const err = io.err.join('');
  expect(err).toContain("unknown flag '--weird-title'");
  expect(err).toContain("note: a leading-dash title needs the '--' terminator");
  expect(err).toContain('mimir create <type> [flags] -- <title>');
  // The parallel-grammar guard: `--weird-title` is still a strict parse
  // failure, never silently accepted as the title.
  expect(err).not.toContain('did you mean');
});

test('a genuine near-match typo on create still wins over the -- terminator hint (MMR-359)', async () => {
  const io = fakeIo(true);
  expect(await runCli(['create', 'task', '--priorty', 'p1'], neverStore, io)).toBe(2);
  const err = io.err.join('');
  expect(err).toContain("unknown flag '--priorty'");
  expect(err).toContain("note: did you mean '--priority'?");
  expect(err).not.toContain('terminator');
});

test('an unrelated create flag typo with a title already present does not get misdiagnosed as a dash-title failure (MMR-359)', async () => {
  const io = fakeIo(true);
  expect(
    await runCli(['create', 'task', 'a real title', '--parnet', 'MMR-2'], neverStore, io),
  ).toBe(2);
  const err = io.err.join('');
  expect(err).toContain("unknown flag '--parnet'");
  expect(err).toContain("note: run 'mimir create -h' for its flags");
  expect(err).not.toContain('terminator');
  expect(err).not.toContain('did you mean');
});

test('create task --help documents the -- escape hatch for a leading-dash title (MMR-359)', async () => {
  const io = fakeIo(true);
  expect(await runCli(['create', 'task', '--help'], neverStore, io)).toBe(0);
  const out = io.out.join('');
  expect(out).toContain('mimir create task --parent MMR-2 -- --weird-title');
});

test('a flag missing its value is synthesized in house voice (MMR-289)', async () => {
  const io = fakeIo(true);
  expect(await runCli(['list', '--to'], neverStore, io)).toBe(2);
  const err = io.err.join('');
  expect(err).toContain("'--to' expects a value");
  expect(err).toContain("note: run 'mimir list -h' for its flags");
  expect(err).not.toContain('argument missing');
});

test('a value-taking flag followed by another flag is still a missing-value error, not the ambiguous library text (MMR-289)', async () => {
  const io = fakeIo(true);
  expect(await runCli(['list', '--to', '--ascii'], neverStore, io)).toBe(2);
  const err = io.err.join('');
  expect(err).toContain("'--to' expects a value");
  expect(err).not.toContain('ambiguous');
  expect(err).not.toContain('Did you forget');
});

test('an unexpected value for a boolean flag is synthesized in house voice (MMR-289)', async () => {
  const io = fakeIo(true);
  expect(await runCli(['list', '--ascii=x'], neverStore, io)).toBe(2);
  const err = io.err.join('');
  expect(err).toContain("'--ascii' doesn't take a value");
  expect(err).toContain("note: run 'mimir list -h' for its flags");
  expect(err).not.toContain('does not take an argument');
});

test('a near-match to a short alias suggests the canonical long flag (MMR-289)', async () => {
  // `--f` is uniquely nearest to the `-f` alias — the suggestion names
  // `--format`, never the short spelling.
  const io = fakeIo(true);
  expect(await runCli(['list', '--f'], neverStore, io)).toBe(2);
  const err = io.err.join('');
  expect(err).toContain("unknown flag '--f'");
  expect(err).toContain("did you mean '--format'?");
  expect(err).not.toContain("did you mean '-f'?");
});

test('a boolean flag with a short alias still names the flag, not the fallback (MMR-289)', async () => {
  // Node prefixes the short form into the message (`Option '-y, --yes' does
  // not take an argument`) — the synthesis must still extract the long flag.
  const io = fakeIo(true);
  expect(await runCli(['create', 'project', 'x', '--yes=true'], neverStore, io)).toBe(2);
  const err = io.err.join('');
  expect(err).toContain("'--yes' doesn't take a value");
  expect(err).not.toContain('invalid arguments');
  expect(err).not.toContain('does not take an argument');
});

test('the JSON envelope carries the synthesized message, never the raw library text (MMR-289)', async () => {
  const io = fakeIo(true);
  expect(await runCli(['list', '--bogus', '-f', 'json'], neverStore, io)).toBe(2);
  expect(io.out.join('')).toBe('');
  const parsed = parseJson<{ error: { code: string; message: string; hint?: string } }>(
    io.err.join(''),
  );
  expect(parsed.error.code).toBe('usage');
  expect(parsed.error.message).toBe("unknown flag '--bogus'");
  expect(parsed.error.hint).toBe("run 'mimir list -h' for its flags");
  const raw = JSON.stringify(parsed);
  expect(raw).not.toContain('Unknown option');
  expect(raw).not.toContain('positional argument');
});

test('deps-gated verbs are recognized, not "unknown command" — guards COMMANDS/switch drift (MMR-211)', async () => {
  for (const verb of ['setup', 'service', 'vault', 'doctor', 'self-update', 'skill', 'bind']) {
    const io = fakeIo(true);
    await runCli([verb], neverStore, io);
    expect(`${io.err.join('')}${io.out.join('')}`).not.toContain('unknown command');
  }
});

test.skipIf(!NORN)('archive freezes the project; unarchive restores it (MMR-121)', async () => {
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

test.skipIf(!NORN)(
  'archive hides the project from reads; the --status archived door reveals it (MMR-122)',
  async () => {
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
  },
);

test.skipIf(!NORN)('archive warns about released cross-project dependents (MMR-124)', async () => {
  const mmrTask = await createTask(store, { parentId: phaseId, title: 'prereq' });
  // A task in another project depends on the MMR task (a cross-project edge).
  await createProject(store, { key: 'AAA', name: 'a' });
  const aInit = await createInitiative(store, {
    projectId: await projectIdOf(store, 'AAA'),
    title: 'i',
  });
  const aInitId = await nodeIdOf(store, `AAA-${String(aInit.seq)}`);
  const aPhase = await createPhase(store, { parentId: aInitId, title: 'ph' });
  const aPhaseId = await nodeIdOf(store, `AAA-${String(aPhase.seq)}`);
  const a1 = await createTask(store, { parentId: aPhaseId, title: 'a1' });
  // Keep both operands in the same explicit mutation setup so this fixture
  // remains readable after the cross-project creates above.
  const a1Id = await nodeIdOf(store, `AAA-${String(a1.seq)}`);
  const mmrTaskId = await nodeIdOf(store, `MMR-${String(mmrTask.seq)}`);
  await depend(store, a1Id, [mmrTaskId]);

  const io = fakeIo(true);
  expect(await runCli(['archive', 'MMR'], () => store, io)).toBe(0);
  const out = io.out.join('');
  expect(out).toContain('archived MMR');
  expect(out).toContain('released');
  expect(out).toContain(`AAA-${String(a1.seq)}`);
});

test.skipIf(!NORN)(
  'archive --format json echoes the project with its archived_at (MMR-121)',
  async () => {
    const io = fakeIo();
    expect(await runCli(['archive', 'MMR', '--format', 'json'], () => store, io)).toBe(0);
    const parsed = parseJson<{ project: { key: string; archived_at: string | null } }>(
      io.out.join(''),
    );
    expect(parsed.project.key).toBe('MMR');
    expect(parsed.project.archived_at).not.toBeNull();
  },
);

test('archive -h prints the archive command help, not the generic dump (MMR-121)', async () => {
  const io = fakeIo(true);
  expect(await runCli(['archive', '-h'], neverStore, io)).toBe(0);
  const out = io.out.join('');
  expect(out).toContain('mimir archive <KEY>');
  expect(out).not.toContain('work commands');
});

// MMR-350 follow-up (ADR 0029): `--tz` is the caller's zone for both halves of
// a query — the calendar day a bare date means AND the wall clock the styled
// formats render. Filtering Tokyo days and printing EDT reads as a bug.
test.skipIf(!NORN)('an explicit --tz renders the styled formats in that zone', async () => {
  const t = await createTask(store, { parentId: phaseId, title: 'x' });
  await completeTask(store, await nodeIdOf(store, `MMR-${String(t.seq)}`));
  const args = ['list', '-s', 'MMR', '--status', 'all', '-f', 'records'];

  const tokyo = fakeIo(false);
  expect(await runCli([...args, '--tz', 'Asia/Tokyo'], () => store, tokyo)).toBe(0);
  expect(tokyo.out.join('\n')).toMatch(/completed {2}\d{4}-\d{2}-\d{2} \d{2}:\d{2} (JST|GMT\+9)/);

  // Absent the flag, rendering stays the reader's own zone (the fixed test one).
  const local = fakeIo(false);
  expect(await runCli(args, () => store, local)).toBe(0);
  expect(local.out.join('\n')).toMatch(/completed {2}\d{4}-\d{2}-\d{2} \d{2}:\d{2} E[SD]T/);
});

test.skipIf(!NORN)('next --format json lists ready tasks (count-led envelope)', async () => {
  await createTask(store, { parentId: phaseId, priority: 'p1', title: 'first' });
  const io = fakeIo();
  expect(await runCli(['next', '--scope', 'MMR', '--format', 'json'], () => store, io)).toBe(0);
  const parsed = parseJson<{ total: number; tasks: { title: string }[] }>(io.out.join(''));
  expect(parsed.total).toBe(1);
  expect(parsed.tasks[0]?.title).toBe('first');
});

test.skipIf(!NORN)(
  'next default is the informative table view whether piped or TTY (MMR-87)',
  async () => {
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
  },
);

test.skipIf(!NORN)('list piped default is the table view, not bare ids (MMR-87)', async () => {
  await createTask(store, { parentId: phaseId, title: 'alpha' });
  const piped = fakeIo(false);
  await runCli(['list', '--scope', 'MMR', '--status', 'ready'], () => store, piped);
  const text = piped.out.join('');
  expect(text).toContain('task');
  expect(text).toContain('alpha');
  expect(text).toContain('MMR-');
});

test.skipIf(!NORN)('get returns a record; a missing id exits non-zero', async () => {
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

test.skipIf(!NORN)('get piped default is the records view, not a bare id (MMR-87)', async () => {
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

test.skipIf(!NORN)('status reports the rollup of a non-leaf', async () => {
  await createTask(store, { parentId: phaseId, title: 't1' });
  const io = fakeIo();
  expect(
    await runCli(['status', `MMR-${String(phaseSeq)}`, '--format', 'json'], () => store, io),
  ).toBe(0);
  const parsed = parseJson<{ status: string }>(io.out.join(''));
  expect(parsed.status).toBe('ready');
});

test.skipIf(!NORN)('an invalid flag value is a usage error → exit 2', async () => {
  const io = fakeIo();
  expect(await runCli(['next', '--priority', 'p9'], () => store, io)).toBe(2);
  expect(io.err.join('')).toContain('invalid priority');
});

test.skipIf(!NORN)('list --status selects the matching universe', async () => {
  await createTask(store, { parentId: phaseId, title: 'a' });
  const io = fakeIo();
  await runCli(['list', '--scope', 'MMR', '--status', 'ready', '--format', 'ids'], () => store, io);
  expect(io.out.join('')).toContain('MMR-');
});

test.skipIf(!NORN)('--predicate is gone — unknown flag is a usage error', async () => {
  const io = fakeIo();
  expect(await runCli(['list', '--predicate', 'ready'], () => store, io)).toBe(2);
});

test.skipIf(!NORN)('a bad --format value is a usage error → exit 2', async () => {
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

test.skipIf(!NORN)('get on a bare KEY renders the whole-project view', async () => {
  const io = fakeIo(false);
  expect(await runCli(['get', 'MMR', '-f', 'json'], () => store, io)).toBe(0);
  const parsed = parseJson<{ id: string; type: string }>(io.out.join(''));
  expect(parsed.id).toBe('MMR');
  expect(parsed.type).toBe('project');
});

test.skipIf(!NORN)(
  'a task verb on a project KEY is a behavioral error (validation → exit 1)',
  async () => {
    const io = fakeIo(false);
    expect(await runCli(['done', 'MMR'], () => store, io)).toBe(1);
    expect(io.err.join('')).toContain('MMR is a project, not a task');
    expect(io.out).toHaveLength(0);
  },
);

test.skipIf(!NORN)('attach echoes KEY-aN and get reads the artifact back', async () => {
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

test.skipIf(!NORN)('a task verb on an artifact id is a behavioral error', async () => {
  const io = fakeIo(false);
  expect(await runCli(['start', 'MMR-a1'], () => store, io)).toBe(1);
  expect(io.err.join('')).toContain('MMR-a1 is an artifact, not a task');
});

// tag write surface (MMR-31)

test.skipIf(!NORN)('tag and untag round-trip through the CLI', async () => {
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

test.skipIf(!NORN)('tag without tags is a usage error', async () => {
  const io = fakeIo(false);
  expect(await runCli(['tag', 'MMR-1'], () => store, io)).toBe(2);
  expect(io.err.join('')).toContain('at least one tag');
});

test.skipIf(!NORN)('create task --tag applies creation-time tags', async () => {
  const io = fakeIo(false);
  const code = await runCli(
    [
      'create',
      'task',
      'tt',
      '--parent',
      `MMR-${String(phaseSeq)}`,
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

test.skipIf(!NORN)('list and next filter by case-insensitive title substring', async () => {
  await createTask(store, { parentId: phaseId, title: 'Ship Vault Search' });
  await createTask(store, { parentId: phaseId, title: 'Unrelated Work' });

  for (const verb of ['list', 'next']) {
    const io = fakeIo(false);
    expect(await runCli([verb, '-s', 'MMR', '-q', 'VAULT', '-f', 'json'], () => store, io)).toBe(0);
    const result = parseJson<{ tasks: { title: string }[] }>(io.out.join(''));
    expect(result.tasks.map((task) => task.title)).toEqual(['Ship Vault Search']);
  }
});

test.skipIf(!NORN)('a value miss warns on stderr and exits 0 with an empty set', async () => {
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

test.skipIf(!NORN)('a value miss in json format emits the warning envelope on stderr', async () => {
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

test.skipIf(!NORN)('an unknown field is a usage error (exit 2)', async () => {
  const io = fakeIo(false);
  expect(await runCli(['list', '--eq', 'bogus:x'], () => store, io)).toBe(2);
  expect(io.err.join('')).toContain('unknown field bogus');
});

test.skipIf(!NORN)('a date op on a non-date field is a usage error (exit 2)', async () => {
  const io = fakeIo(false);
  expect(await runCli(['list', '--before', 'priority:p1'], () => store, io)).toBe(2);
});

test.skipIf(!NORN)('--is/--not-is select verdicts; --status picks the universe', async () => {
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

test.skipIf(!NORN)('depend --on still works as a write flag alongside the date op', async () => {
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

test.skipIf(!NORN)(
  'attach defaults title from the file basename; --title overrides; --tag classifies',
  async () => {
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
  },
);

test.skipIf(!NORN)('attach from stdin without --title is a usage error', async () => {
  const t = await createTask(store, { parentId: phaseId, title: 't' });
  const io = fakeIo(true); // TTY → no stdin content either, but flag check comes after content
  const code = await runCli(['attach', `MMR-${String(t.seq)}`], () => store, io);
  expect(code).toBe(2);
});

test.skipIf(!NORN)('get KEY-aN --col content returns the frozen body', async () => {
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
  // The Norn artifact store strips exactly one trailing newline on read
  // (core/store-norn/artifacts.ts) — a documented, intentional round-trip delta.
  expect(parsed.content).toBe('# the frozen body');
});

// create project positional name (MMR-35)

test.skipIf(!NORN)('create project accepts a positional name', async () => {
  const io = fakeIo(false);
  const code = await runCli(
    ['create', 'project', 'Other Tool', '--key', 'OTH', '-y', '-f', 'json'],
    () => store,
    io,
  );
  expect(code).toBe(0);
  expect(JSON.parse(io.out.join(''))).toEqual({ project: { key: 'OTH', name: 'Other Tool' } });
});

test.skipIf(!NORN)('create project still accepts --name and errors without either', async () => {
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

test.skipIf(!NORN)('--col takes flat column names; the dot form is a usage error', async () => {
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

test.skipIf(!NORN)('--col accepts a comma-separated list, not just repeats (MMR-212)', async () => {
  const t = await createTask(store, { parentId: phaseId, title: 't' });
  const ref = `MMR-${String(t.seq)}`;
  const io = fakeIo(false);
  await runCli(['get', ref, '--col', 'history,annotations', '-f', 'json'], () => store, io);
  const view = parseJson<{ history: unknown[]; annotations: unknown[] }>(io.out.join(''));
  expect(Array.isArray(view.history)).toBe(true);
  expect(Array.isArray(view.annotations)).toBe(true);
});

test.skipIf(!NORN)(
  '--col naming a base column hints that it is always shown, not an addable column (MMR-212)',
  async () => {
    const t = await createTask(store, { parentId: phaseId, title: 't' });
    const ref = `MMR-${String(t.seq)}`;
    const io = fakeIo(false);
    // the 21-occurrence miss: `--col id,type,status` treats --col as a projection
    expect(await runCli(['get', ref, '--col', 'id,type,status'], () => store, io)).toBe(2);
    const err = io.err.join('');
    expect(err).toContain('always shown');
    expect(err).not.toContain('unknown column'); // the tailored hint, not the generic one
  },
);

// --type removal (MMR-94)

test.skipIf(!NORN)('list --eq type:phase filters to phases only', async () => {
  // The vault has one phase (phaseId) and a task; ensure --eq type:phase returns phase but not tasks.
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

// --where/upstream parity (MMR-265)

test.skipIf(!NORN)('list --eq upstream:KEY-sN filters at parity with external_ref', async () => {
  const a = await createTask(store, { parentId: phaseId, title: 'a', upstream: 'MMR-s6' });
  await createTask(store, { parentId: phaseId, title: 'b' });
  const io = fakeIo(false);
  const code = await runCli(
    ['list', '--scope', 'MMR', '--eq', 'upstream:MMR-s6', '-f', 'ids'],
    () => store,
    io,
  );
  expect(code).toBe(0);
  expect(io.out.join('').trim()).toBe(`MMR-${String(a.seq)}`);
});

test.skipIf(!NORN)('list --eq upstream:KEY-sN with no match returns an empty set', async () => {
  await createTask(store, { parentId: phaseId, title: 'a', upstream: 'MMR-s6' });
  const io = fakeIo(false);
  const code = await runCli(
    ['list', '--scope', 'MMR', '--eq', 'upstream:MMR-s7', '-f', 'ids'],
    () => store,
    io,
  );
  expect(code).toBe(0);
  expect(io.out.join('').trim()).toBe('');
});

test.skipIf(!NORN)('--type is now an unknown option → rejected with exit 2 (MMR-94)', async () => {
  const io = fakeIo(false);
  const code = await runCli(['list', '--type', 'phase'], () => store, io);
  expect(code).toBe(2);
});

// MMR-95: empty set views print a clear no-results line on a TTY

test.skipIf(!NORN)('next empty on a TTY prints a no-results line (MMR-95)', async () => {
  const io = fakeIo(true);
  const code = await runCli(['next', '--scope', 'MMR'], () => store, io);
  expect(code).toBe(0);
  const text = io.out.join('');
  expect(text).toMatch(/No ready tasks/i);
});

test.skipIf(!NORN)(
  'next empty on a non-TTY (piped) omits the no-results line (MMR-95)',
  async () => {
    const io = fakeIo(false);
    const code = await runCli(['next', '--scope', 'MMR'], () => store, io);
    expect(code).toBe(0);
    const text = io.out.join('');
    // No human message — piped output is structural only
    expect(text).not.toMatch(/No ready tasks/i);
    expect(text).not.toMatch(/No tasks/i);
  },
);

test.skipIf(!NORN)(
  'list empty --status blocked on a TTY prints a no-results line (MMR-95)',
  async () => {
    const io = fakeIo(true);
    const code = await runCli(['list', '--scope', 'MMR', '--status', 'blocked'], () => store, io);
    expect(code).toBe(0);
    const text = io.out.join('');
    expect(text).toMatch(/No tasks/i);
  },
);

test.skipIf(!NORN)(
  'next empty -f json produces unchanged structured output — no message leak (MMR-95)',
  async () => {
    const io = fakeIo(true);
    const code = await runCli(['next', '--scope', 'MMR', '-f', 'json'], () => store, io);
    expect(code).toBe(0);
    const parsed = parseJson<{ total: number; returned: number }>(io.out.join(''));
    expect(parsed.total).toBe(0);
    expect(parsed.returned).toBe(0);
    // No message text in the JSON output
    expect(io.out.join('')).not.toContain('No');
  },
);

test.skipIf(!NORN)(
  'next empty -f ids produces empty output — no message leak (MMR-95)',
  async () => {
    const io = fakeIo(true);
    const code = await runCli(['next', '--scope', 'MMR', '-f', 'ids'], () => store, io);
    expect(code).toBe(0);
    // ids format on empty should be empty string (no message leak)
    expect(io.out.join('')).toBe('');
  },
);

test.skipIf(!NORN)('next empty -f records on a TTY prints a no-results line (MMR-95)', async () => {
  const io = fakeIo(true);
  const code = await runCli(['next', '--scope', 'MMR', '-f', 'records'], () => store, io);
  expect(code).toBe(0);
  const text = io.out.join('');
  expect(text).toMatch(/No ready tasks/i);
});

// MMR-184: the doctor issue-count trailer — a stderr-only nudge off the
// tolerant reader's own drop tally for the load `next`/`list` already perform,
// never a fresh `mimir doctor` pass.

describe.skipIf(!NORN)('doctor issue-count trailer on next/list (MMR-184)', () => {
  let fixture: TestStore;

  beforeEach(async () => {
    fixture = await createTestStore();
  });

  afterEach(async () => {
    await fixture.close();
  });

  /** One project, one ready task, and one dangling `parent` ref (a phase
   * pointing at a nonexistent node) — the tolerant reader floats the phase to
   * root and records exactly one drop, without losing the task underneath it. */
  async function seedOneDrop(): Promise<void> {
    await createProject(fixture.store, { key: 'MMR', name: 'm' });
    const init = await createInitiative(fixture.store, { projectId: 'MMR', title: 'i' });
    const phase = await createPhase(fixture.store, { parentId: init.id, title: 'ph' });
    await createTask(fixture.store, { parentId: phase.id, title: 't' });
    fixture.corruptDocument(`MMR/${phase.id}.md`, (raw) =>
      raw.replace(/^parent:.*$/m, 'parent: "[[MMR-999]]"'),
    );
  }

  async function seedClean(): Promise<void> {
    await createProject(fixture.store, { key: 'MMR', name: 'm' });
    const init = await createInitiative(fixture.store, { projectId: 'MMR', title: 'i' });
    const phase = await createPhase(fixture.store, { parentId: init.id, title: 'ph' });
    await createTask(fixture.store, { parentId: phase.id, title: 't' });
  }

  test('next prints the trailer on stderr (not stdout) when the load drops a record', async () => {
    await seedOneDrop();
    const io = fakeIo(true);
    const code = await runCli(['next', '--scope', 'MMR'], () => fixture.store, io);
    expect(code).toBe(0);
    expect(io.err.join('')).toContain('[warn] 1 issue — run mimir doctor');
    expect(io.out.join('')).not.toContain('issue');
  });

  test('list prints the trailer on stderr (not stdout) when the load drops a record', async () => {
    await seedOneDrop();
    const io = fakeIo(true);
    const code = await runCli(['list', '--scope', 'MMR'], () => fixture.store, io);
    expect(code).toBe(0);
    expect(io.err.join('')).toContain('[warn] 1 issue — run mimir doctor');
    expect(io.out.join('')).not.toContain('issue');
  });

  test('a clean vault shows no trailer on next or list', async () => {
    await seedClean();

    const nextIo = fakeIo(true);
    expect(await runCli(['next', '--scope', 'MMR'], () => fixture.store, nextIo)).toBe(0);
    expect(nextIo.err.join('')).toBe('');

    const listIo = fakeIo(true);
    expect(await runCli(['list', '--scope', 'MMR'], () => fixture.store, listIo)).toBe(0);
    expect(listIo.err.join('')).toBe('');
  });

  test('the ids format keeps the prose trailer on stderr while stdout stays clean', async () => {
    await seedOneDrop();
    const io = fakeIo(true);
    const code = await runCli(['list', '--scope', 'MMR', '-f', 'ids'], () => fixture.store, io);
    expect(code).toBe(0);
    expect(io.out.join('')).not.toContain('issue');
    expect(io.err.join('')).toContain('[warn] 1 issue — run mimir doctor');
  });

  test('json/jsonl formats emit a JSON-shaped trailer line on stderr, mirroring the warning envelope', async () => {
    await seedOneDrop();
    for (const format of ['json', 'jsonl'] as const) {
      const io = fakeIo(true);
      const code = await runCli(['list', '--scope', 'MMR', '-f', format], () => fixture.store, io);
      expect(code).toBe(0);
      expect(io.out.join('')).not.toContain('issue');
      const trailer = parseJson<{ warning: string; issueCount: number }>(io.err.join(''));
      expect(trailer.warning).toBe('1 issue — run mimir doctor');
      expect(trailer.issueCount).toBe(1);
    }
  });

  test('the trailer pluralizes past one issue', async () => {
    await createProject(fixture.store, { key: 'MMR', name: 'm' });
    const init = await createInitiative(fixture.store, { projectId: 'MMR', title: 'i' });
    const phaseA = await createPhase(fixture.store, { parentId: init.id, title: 'a' });
    const phaseB = await createPhase(fixture.store, { parentId: init.id, title: 'b' });
    fixture.corruptDocument(`MMR/${phaseA.id}.md`, (raw) =>
      raw.replace(/^parent:.*$/m, 'parent: "[[MMR-999]]"'),
    );
    fixture.corruptDocument(`MMR/${phaseB.id}.md`, (raw) =>
      raw.replace(/^parent:.*$/m, 'parent: "[[MMR-998]]"'),
    );

    const io = fakeIo(true);
    const code = await runCli(['list', '--scope', 'MMR'], () => fixture.store, io);
    expect(code).toBe(0);
    expect(io.err.join('')).toContain('[warn] 2 issues — run mimir doctor');
  });

  /** The tally is the whole-vault working-set count (MMR-184), not scoped to
   * the selection: corruption lives entirely in project OTH, but a `next`/
   * `list` scoped to the pristine project MMR still carries the trailer. If
   * the count ever becomes scope-local this must fail. */
  test('the trailer reflects the whole-vault tally even when the scoped project is clean', async () => {
    await createProject(fixture.store, { key: 'MMR', name: 'm' });
    const init = await createInitiative(fixture.store, { projectId: 'MMR', title: 'i' });
    const phase = await createPhase(fixture.store, { parentId: init.id, title: 'ph' });
    await createTask(fixture.store, { parentId: phase.id, title: 't' });

    await createProject(fixture.store, { key: 'OTH', name: 'o' });
    const otherInit = await createInitiative(fixture.store, { projectId: 'OTH', title: 'i' });
    const otherPhase = await createPhase(fixture.store, { parentId: otherInit.id, title: 'ph' });
    await createTask(fixture.store, { parentId: otherPhase.id, title: 't' });
    fixture.corruptDocument(`OTH/${otherPhase.id}.md`, (raw) =>
      raw.replace(/^parent:.*$/m, 'parent: "[[OTH-999]]"'),
    );

    const nextIo = fakeIo(true);
    expect(await runCli(['next', '--scope', 'MMR'], () => fixture.store, nextIo)).toBe(0);
    expect(nextIo.err.join('')).toContain('[warn] 1 issue — run mimir doctor');

    const listIo = fakeIo(true);
    expect(await runCli(['list', '--scope', 'MMR'], () => fixture.store, listIo)).toBe(0);
    expect(listIo.err.join('')).toContain('[warn] 1 issue — run mimir doctor');
  });
});

// MMR-278: `overview` — the composite session-boot orientation surface. A
// report-kind read: styled sections on a TTY, one JSON envelope when piped;
// the set formats and `-s all` are usage errors pointing at `mimir list`.
describe.skipIf(!NORN)('overview (MMR-278)', () => {
  test('records render carries the five sections and the ready row', async () => {
    await createTask(store, { parentId: phaseId, title: 'do the thing' });
    const io = fakeIo(true);
    expect(await runCli(['overview', '-s', 'MMR'], () => store, io)).toBe(0);
    const out = io.out.join('');
    expect(out).toContain('MMR');
    expect(out).toContain('in flight (0)');
    expect(out).toContain('next (1)');
    expect(out).toContain('awaiting (0)');
    expect(out).toContain('hygiene');
    expect(out).toContain('do the thing');
  });

  test('hygiene follow-up pointers are scoped to the reported project', async () => {
    const task = await createTask(store, { parentId: phaseId, title: 'stuck' });
    await blockTask(store, `MMR-${String(task.seq)}`, 'external');
    const io = fakeIo(true);
    expect(await runCli(['overview', '-s', 'MMR'], () => store, io)).toBe(0);
    expect(io.out.join('')).toContain("1 blocked — run 'mimir list -s MMR --status blocked'");
  });

  test('the awaiting row carries the upstream ids it awaits', async () => {
    const prereq = await createTask(store, { parentId: phaseId, title: 'prereq' });
    const dependent = await createTask(store, { parentId: phaseId, title: 'dependent' });
    await depend(store, `MMR-${String(dependent.seq)}`, [`MMR-${String(prereq.seq)}`]);
    const io = fakeIo(true);
    expect(await runCli(['overview', '-s', 'MMR'], () => store, io)).toBe(0);
    const out = io.out.join('');
    expect(out).toContain('awaiting (1)');
    expect(out).toContain(`· awaiting MMR-${String(prereq.seq)}`);
  });

  test('-f json emits the composite envelope, not a set wrapper', async () => {
    await createTask(store, { parentId: phaseId, title: 'ready one' });
    const io = fakeIo(false);
    expect(await runCli(['overview', '-s', 'MMR', '-f', 'json'], () => store, io)).toBe(0);
    const env = parseJson<{
      project: { id: string; status: string; distribution: Record<string, number> };
      in_flight: { count: number; tasks: unknown[] };
      next: { count: number; tasks: { id: string; status: string }[] };
      awaiting: { count: number; tasks: unknown[] };
      hygiene: {
        untriaged: number;
        blocked: number;
        stale: number;
        dropped: number;
        listings: { blocked: unknown[]; stale: unknown[]; untriaged: unknown[] };
      };
    }>(io.out.join(''));
    expect(env.project.id).toBe('MMR');
    expect(env.next.count).toBe(1);
    expect(env.next.tasks[0]?.status).toBe('ready');
    expect(env.hygiene).toEqual({
      blocked: 0,
      dropped: 0,
      listings: { blocked: [], stale: [], untriaged: [] },
      stale: 0,
      untriaged: 0,
    });
  });

  test('piped default is the json envelope (report split)', async () => {
    const io = fakeIo(false);
    expect(await runCli(['overview', '-s', 'MMR'], () => store, io)).toBe(0);
    expect(() => parseJson(io.out.join(''))).not.toThrow();
  });

  test.each(['table', 'jsonl', 'ids'])('-f %s is a usage error pointing at list', async (fmt) => {
    const io = fakeIo(true);
    expect(await runCli(['overview', '-s', 'MMR', '-f', fmt], neverStore, io)).toBe(2);
    expect(io.err.join('')).toContain('composite');
    expect(io.err.join('')).toContain('mimir list');
    expect(io.out).toHaveLength(0);
  });

  test('-s all is a usage error', async () => {
    const io = fakeIo(true);
    expect(await runCli(['overview', '-s', 'all'], neverStore, io)).toBe(2);
    expect(io.err.join('')).toContain('one project');
    expect(io.err.join('')).toContain('mimir list -s all');
  });

  test('no project (no binding, no -s) is a usage error', async () => {
    const io = fakeIo(true);
    expect(await runCli(['overview'], neverStore, io)).toBe(2);
    expect(io.err.join('')).toContain('overview needs a project');
  });

  test('bare uses the bound scope from defaults', async () => {
    await createTask(store, { parentId: phaseId, title: 'bound task' });
    const io = fakeIo(false);
    expect(await runCli(['overview'], () => store, io, { scope: 'MMR' })).toBe(0);
    expect(parseJson<{ project: { id: string } }>(io.out.join('')).project.id).toBe('MMR');
  });
});

// MMR-322: the composed sections — direction prose, recent sessions, the
// in-flight resume handles, and the needs-attention listings behind the counts.
describe.skipIf(!NORN)('overview composition (MMR-322)', () => {
  test('an in-flight row shows its handles compactly', async () => {
    const task = await createTask(store, { parentId: phaseId, title: 'running' });
    await startTask(store, `MMR-${String(task.seq)}`, {
      branch: 'feat/mmr-322',
      harness: 'codex',
      host: 'workbench',
      session: 's-01',
    });
    const io = fakeIo(true);
    expect(await runCli(['overview', '-s', 'MMR'], () => store, io)).toBe(0);
    const out = io.out.join('');
    expect(out).toContain('in flight (1)');
    expect(out).toContain('codex@workbench · feat/mmr-322 · s-01');
  });

  test('an in-flight row with no handles carries no clause', async () => {
    const task = await createTask(store, { parentId: phaseId, title: 'running' });
    await startTask(store, `MMR-${String(task.seq)}`);
    const io = fakeIo(true);
    expect(await runCli(['overview', '-s', 'MMR'], () => store, io)).toBe(0);
    const line = io.out
      .join('')
      .split('\n')
      .find((l) => l.includes('running'));
    expect(line).toBeDefined();
    expect(line?.trimEnd().endsWith('running')).toBe(true);
  });

  test('direction renders the owned prose verbatim, under its container', async () => {
    await updateProject(store, await projectIdOf(store, 'MMR'), { next: 'ship phase 3' });
    await updateNode(store, phaseId, { next: 'land the composition' });
    await createTask(store, { parentId: phaseId, title: 'ready one' });
    const io = fakeIo(true);
    expect(await runCli(['overview', '-s', 'MMR'], () => store, io)).toBe(0);
    const out = io.out.join('');
    expect(out).toContain('direction');
    expect(out).toContain('ship phase 3');
    expect(out).toContain(`MMR-${String(phaseSeq)} · ph`);
    expect(out).toContain('land the composition');
  });

  test('a board owning no prose renders no direction header', async () => {
    await createTask(store, { parentId: phaseId, title: 'ready one' });
    const io = fakeIo(true);
    expect(await runCli(['overview', '-s', 'MMR'], () => store, io)).toBe(0);
    expect(io.out.join('')).not.toContain('direction');
  });

  test('recent sessions render the group and its joined summary lede', async () => {
    const task = await createTask(store, { parentId: phaseId, title: 'claimed' });
    const stem = `MMR-${String(task.seq)}`;
    await startTask(store, stem, { session: 's-77' });
    await attachArtifact(store, {
      content: '# retro',
      linkNodeIds: [await nodeIdOf(store, stem)],
      projectId: await projectIdOf(store, 'MMR'),
      summary: 'closed out the codec work',
      tags: ['session_summary'],
      title: 'session retro',
    });
    const io = fakeIo(true);
    expect(await runCli(['overview', '-s', 'MMR'], () => store, io)).toBe(0);
    const out = io.out.join('');
    expect(out).toContain('recent sessions (1 shown)');
    expect(out).toContain('s-77');
    expect(out).toContain('closed out the codec work');
  });

  test('the blocked listing renders the lane word and the hold reason', async () => {
    const task = await createTask(store, { parentId: phaseId, title: 'stuck' });
    await blockTask(store, `MMR-${String(task.seq)}`, 'upstream API down');
    const io = fakeIo(true);
    expect(await runCli(['overview', '-s', 'MMR'], () => store, io)).toBe(0);
    const out = io.out.join('');
    expect(out).toContain("1 blocked — run 'mimir list -s MMR --status blocked'");
    expect(out).toContain('needs_unsticking');
    expect(out).toContain('upstream API down');
  });

  test('-f json carries the composed sections on the same envelope', async () => {
    await updateProject(store, await projectIdOf(store, 'MMR'), { next: 'ship phase 3' });
    const task = await createTask(store, { parentId: phaseId, title: 'stuck' });
    await blockTask(store, `MMR-${String(task.seq)}`, 'external');
    const io = fakeIo(false);
    expect(await runCli(['overview', '-s', 'MMR', '-f', 'json'], () => store, io)).toBe(0);
    const env = parseJson<{
      direction: {
        project: string | null;
        count: number;
        containers: { id: string; next: string }[];
      };
      sessions: { shown: number; entries: unknown[] };
      hygiene: { listings: { blocked: { id: string; lane: string; stale: boolean }[] } };
    }>(io.out.join(''));
    expect(env.direction.project).toBe('ship phase 3');
    expect(env.sessions).toEqual({ entries: [], shown: 0 });
    expect(env.hygiene.listings.blocked[0]?.lane).toBe('needs_unsticking');
    expect(env.hygiene.listings.blocked[0]?.stale).toBe(false);
  });
});

// MMR-322: `artifacts` — the flat, cross-project artifact feed. A `set`-kind
// read: the querying doctrine applies (empty set at exit 0 with a stderr note,
// structural faults at exit 2).
describe.skipIf(!NORN)('artifacts (MMR-322)', () => {
  const attach = async (title: string, tags: string[] = [], summary?: string): Promise<string> =>
    (
      await attachArtifact(store, {
        content: `# ${title}`,
        projectId: await projectIdOf(store, 'MMR'),
        summary,
        tags,
        title,
      })
    ).renderedId;

  test('the table render is count-led and carries the lede', async () => {
    const id = await attach('vault notes', ['session_summary'], 'what the converge does');
    const io = fakeIo(true);
    expect(await runCli(['artifacts', '-s', 'MMR'], () => store, io)).toBe(0);
    const out = io.out.join('');
    expect(out).toContain('1 artifact');
    expect(out).toContain(id);
    expect(out).toContain('vault notes');
    expect(out).toContain('session_summary');
    expect(out).toContain('what the converge does');
    expect(io.err).toHaveLength(0);
  });

  test('a tag filter narrows the feed', async () => {
    await attach('a design note', ['design']);
    const summaryId = await attach('a retro', ['session_summary']);
    const io = fakeIo(true);
    expect(await runCli(['artifacts', '-s', 'MMR', '-t', 'session_summary'], () => store, io)).toBe(
      0,
    );
    const out = io.out.join('');
    expect(out).toContain('1 artifact');
    expect(out).toContain(summaryId);
    expect(out).not.toContain('a design note');
  });

  test('-f ids emits bare KEY-aN ids', async () => {
    const id = await attach('vault notes');
    const io = fakeIo(false);
    expect(await runCli(['artifacts', '-s', 'MMR', '-f', 'ids'], () => store, io)).toBe(0);
    expect(io.out.join('')).toBe(id);
  });

  test('-f json emits the artifacts-unit set wrapper', async () => {
    await attach('vault notes', [], 'a lede');
    const io = fakeIo(false);
    expect(await runCli(['artifacts', '-s', 'MMR', '-f', 'json'], () => store, io)).toBe(0);
    const env = parseJson<{
      total: number;
      returned: number;
      starts_at: number;
      artifacts: { id: string; project: string; summary?: string }[];
    }>(io.out.join(''));
    expect(env.total).toBe(1);
    expect(env.returned).toBe(1);
    expect(env.starts_at).toBe(0);
    expect(env.artifacts[0]?.project).toBe('MMR');
    expect(env.artifacts[0]?.summary).toBe('a lede');
  });

  test('a well-formed empty query exits 0 with a stderr note', async () => {
    const io = fakeIo(true);
    expect(await runCli(['artifacts', '-s', 'MMR', '-t', 'nothing'], () => store, io)).toBe(0);
    expect(io.out.join('')).toContain('0 artifacts');
    expect(io.err.join('')).toContain('no artifacts in MMR');
  });

  test('the empty note is a JSON line on the machine formats', async () => {
    const io = fakeIo(false);
    expect(
      await runCli(['artifacts', '-s', 'MMR', '-t', 'nothing', '-f', 'json'], () => store, io),
    ).toBe(0);
    expect(parseJson<{ warning: string }>(io.err.join('')).warning).toContain('no artifacts');
  });

  test('-s all spans projects and keeps the project column', async () => {
    await attach('vault notes');
    const io = fakeIo(true);
    expect(await runCli(['artifacts', '-s', 'all'], () => store, io)).toBe(0);
    expect(io.out.join('')).toContain('MMR');
  });

  test('an unknown scope is a not-found, not an empty set', async () => {
    const io = fakeIo(true);
    expect(await runCli(['artifacts', '-s', 'ZZZ'], () => store, io)).toBe(1);
    expect(io.err.join('')).toContain('ZZZ');
  });

  test.each([
    ['--at-or-after', 'yesterday'],
    ['--before', 'not-a-date'],
    ['--at-or-after', '2026-13-45'], // out-of-range month
    ['--before', '2026-07-31T99:00:00Z'],
    // Day overflow, which `Date.parse` ROLLS rather than rejects — Feb 30 would
    // silently become Mar 2, a bound the caller never asked for.
    ['--at-or-after', '2026-02-30'],
    ['--before', '2026-02-30T10:00:00Z'],
    ['--at-or-after', '2027-02-29'], // not a leap year
    ['--before', '2026-06-31'], // 30-day month
    // Zone-less timestamps are refused rather than read as UTC (ADR 0029): the
    // same command would otherwise mean two things on two machines.
    ['--before', '2026-07-31T10:15:00'],
    ['--at-or-after', '2026-07-31 10:15:00Z'],
    ['--before', '2026-07-31T10:15'],
  ])('%s created_at:%s is a usage error', async (flag, value) => {
    const io = fakeIo(true);
    expect(await runCli(['artifacts', flag, `created_at:${value}`], neverStore, io)).toBe(2);
    expect(io.err.join('')).toContain('invalid date');
    expect(io.out).toHaveLength(0);
  });

  test('a date filter naming another field is a usage error', async () => {
    const io = fakeIo(true);
    expect(await runCli(['artifacts', '--on', 'updated_at:2026-07-31'], neverStore, io)).toBe(2);
    expect(io.err.join('')).toContain('applies to created_at');
  });

  test('an unqualified date value is a usage error naming the field', async () => {
    const io = fakeIo(true);
    expect(await runCli(['artifacts', '--on', '2026-07-31'], neverStore, io)).toBe(2);
    expect(io.err.join('')).toContain('created_at:2026-07-31');
  });

  test('an unknown --tz is a usage error and never opens the store', async () => {
    const io = fakeIo(true);
    expect(
      await runCli(
        ['artifacts', '--on', 'created_at:2026-07-31', '--tz', 'Mars/Olympus'],
        neverStore,
        io,
      ),
    ).toBe(2);
    expect(io.err.join('')).toContain('unknown timezone');
  });

  test.each([
    '2026-07-31',
    '2026-07-31T10:15:00Z',
    '2026-07-31T10:15:00.123Z',
    '2026-07-31T10:15Z',
    // A numeric UTC offset is a zone, so these are accepted and normalized.
    '2026-07-31T10:15:00-04:00',
    '2026-07-31T10:15:00+05:30',
    '2028-02-29', // a real leap day — the overflow check must not reject it
    '2028-02-29T10:15:00Z',
  ])('%s is an accepted date bound', async (value) => {
    const io = fakeIo(true);
    expect(
      await runCli(
        ['artifacts', '-s', 'MMR', '--at-or-after', `created_at:${value}`],
        () => store,
        io,
      ),
    ).toBe(0);
  });

  // The `=` form so parseArgs hands the value through rather than reading a
  // leading `-` as the next flag.
  test.each([
    '--offset=-2',
    '--offset=2x',
    '--offset=2.5',
    '--offset=1e3',
    '--offset=0x10',
    '--offset= ',
    '--offset=9007199254740993',
  ])('%s is a usage error naming the flag', async (token) => {
    const io = fakeIo(true);
    expect(await runCli(['artifacts', token], neverStore, io)).toBe(2);
    expect(io.err.join('')).toContain('invalid offset');
    expect(io.err.join('')).toContain('whole count of rows to skip');
    expect(io.out).toHaveLength(0);
  });

  test.each(['--limit=2x', '--limit=2.5', '--limit=-1'])(
    '%s is a usage error (MMR-322 tightening — parseInt used to truncate silently)',
    async (token) => {
      const io = fakeIo(true);
      expect(await runCli(['artifacts', token], neverStore, io)).toBe(2);
      expect(io.err.join('')).toContain('invalid limit');
    },
  );

  // `list`/`next` share the limit parser, so the tightening reaches them too —
  // and, since MMR-322 hoisted their selection parse above the store open, they
  // refuse a bad limit WITHOUT touching the vault, like every other usage error
  // (MMR-39).
  test.each(['list', 'next'])('%s refuses a bad limit before opening the store', async (verb) => {
    const io = fakeIo(true);
    expect(await runCli([verb, '--limit=2x'], neverStore, io)).toBe(2);
    expect(io.err.join('')).toContain('invalid limit');
    expect(io.out).toHaveLength(0);
  });

  // The store compares `created_at` LEXICALLY against the bound, and stored
  // values are always ISO-ms UTC — so an accepted form that isn't canonicalized
  // silently windows wrong rather than erroring.
  test('a numeric-offset bound is converted to UTC before the compare', async () => {
    const id = await attach('vault notes');
    const createdAt = (await getArtifact(store, id)).createdAt;
    const created = new Date(createdAt);
    // A bound 30 minutes BEFORE the artifact, expressed as +02:00 local time.
    // Passed through verbatim it reads two hours later than it is and the
    // artifact drops out of its own window.
    const bound = new Date(created.getTime() - 30 * 60 * 1000);
    const local = new Date(bound.getTime() + 2 * 60 * 60 * 1000)
      .toISOString()
      .replace('Z', '+02:00');

    const io = fakeIo(false);
    expect(
      await runCli(
        ['artifacts', '-s', 'MMR', '--at-or-after', `created_at:${local}`, '-f', 'json'],
        () => store,
        io,
      ),
    ).toBe(0);
    expect(parseJson<{ total: number }>(io.out.join('')).total).toBe(1);
  });

  test('a zoned bound an hour after the artifact excludes it', async () => {
    const id = await attach('vault notes');
    const created = new Date((await getArtifact(store, id)).createdAt);
    const after = new Date(created.getTime() + 60 * 60 * 1000).toISOString();

    const io = fakeIo(false);
    expect(
      await runCli(
        ['artifacts', '-s', 'MMR', '--at-or-after', `created_at:${after}`, '-f', 'json'],
        () => store,
        io,
      ),
    ).toBe(0);
    expect(parseJson<{ total: number }>(io.out.join('')).total).toBe(0);
  });

  test('a bare date windows the caller-local day, not the UTC one', async () => {
    await attach('vault notes');
    // Kiritimati is UTC+14, so "today" there began before this artifact existed
    // in every other zone — the day the caller means is the day that filters.
    const today = new Date().toISOString().slice(0, 10);
    const io = fakeIo(false);
    expect(
      await runCli(
        [
          'artifacts',
          '-s',
          'MMR',
          '--at-or-before',
          `created_at:${today}`,
          '--tz',
          'UTC',
          '-f',
          'json',
        ],
        () => store,
        io,
      ),
    ).toBe(0);
    expect(parseJson<{ total: number }>(io.out.join('')).total).toBe(1);
  });

  test('an offset past the end is exit 0 with a note naming the match count', async () => {
    await attach('vault notes');
    const io = fakeIo(true);
    expect(await runCli(['artifacts', '-s', 'MMR', '--offset', '5'], () => store, io)).toBe(0);
    expect(io.err.join('')).toContain('past offset 5');
    expect(io.err.join('')).toContain('1 artifact matched');
  });

  test('an unknown format is a usage error and never opens the store', async () => {
    const io = fakeIo(true);
    expect(await runCli(['artifacts', '-f', 'yaml'], neverStore, io)).toBe(2);
    expect(io.err.join('')).toContain('unknown format');
  });

  test('bare uses the bound scope from defaults', async () => {
    await attach('vault notes');
    const io = fakeIo(false);
    expect(await runCli(['artifacts', '-f', 'json'], () => store, io, { scope: 'MMR' })).toBe(0);
    expect(parseJson<{ total: number }>(io.out.join('')).total).toBe(1);
  });

  test('-h prints the verb descriptor without touching the store', async () => {
    const io = fakeIo(true);
    expect(await runCli(['artifacts', '-h'], neverStore, io)).toBe(0);
    expect(io.out.join('')).toContain('mimir artifacts');
    expect(io.out.join('')).toContain('--at-or-after');
  });
});

// The artifact feed's flags live in the ONE global options table, so without a
// verb-owned guard `mimir list --since 2026-07-01` would exit 0 with the
// UNFILTERED board — a silently-wrong answer where the invocation was previously
// a hard unknown-flag error. Same failure mode `--direction`/`--next` were
// guarded against in MMR-321.
describe('artifacts flags are verb-owned (MMR-322)', () => {
  test.each([
    ['list', '--offset', '3'],
    ['next', '--offset', '3'],
    ['get', '--query', 'vault'],
    ['create', '--offset', '1'],
    // The date grammar belongs to the query verbs (ADR 0029): a zone or bound
    // on a read that has no date filter would be silently discarded.
    ['get', '--tz', 'Asia/Tokyo'],
    ['update', '--tz', 'Asia/Tokyo'],
    ['get', '--at-or-after', 'created_at:2026-07-01'],
    ['create', '--at-or-before', 'created_at:2026-07-01'],
  ])('%s rejects %s', async (verb, flag, value) => {
    const io = fakeIo(true);
    expect(await runCli([verb, flag, value], neverStore, io)).toBe(2);
    expect(io.err.join('')).toContain(`doesn't apply to ${verb}`);
    expect(io.out).toHaveLength(0);
  });

  // The retired date spellings (ADR 0029) are refused on EVERY verb, artifacts
  // included, and each refusal names the spelling that replaced it — a silently
  // ignored bound answers a question the caller never asked.
  test.each([
    ['artifacts', '--since', '2026-07-01', '--at-or-after created_at:YYYY-MM-DD'],
    ['list', '--since', '2026-07-01', '--at-or-after created_at:YYYY-MM-DD'],
    ['list', '--not-before', 'created_at:2026-07-01', '--at-or-after FIELD:VALUE'],
    ['next', '--not-after', 'created_at:2026-07-01', '--at-or-before FIELD:VALUE'],
  ])('%s refuses %s with a redirect', async (verb, flag, value, redirect) => {
    const io = fakeIo(true);
    expect(await runCli([verb, flag, value], neverStore, io)).toBe(2);
    expect(io.err.join('')).toContain(`'${flag}' is retired`);
    expect(io.err.join('')).toContain(redirect);
    expect(io.out).toHaveLength(0);
  });

  // The four query verbs own the grammar, so none of them refuses it.
  test.skipIf(!NORN).each(['list', 'next', 'artifacts', 'seeds'])(
    '%s accepts --tz and the at-or- bounds',
    async (verb) => {
      const io = fakeIo(false);
      const scope = verb === 'seeds' ? ['-p', 'MMR'] : ['-s', 'MMR'];
      expect(
        await runCli(
          [
            verb,
            ...scope,
            '--at-or-after',
            'created_at:2026-01-01',
            '--at-or-before',
            'created_at:2030-01-01',
            '--tz',
            'Asia/Tokyo',
            '-f',
            'json',
          ],
          () => store,
          io,
        ),
      ).toBe(0);
    },
  );

  test.skipIf(!NORN)('artifacts accepts the shared date grammar plus its paging', async () => {
    const io = fakeIo(false);
    expect(
      await runCli(
        [
          'artifacts',
          '-s',
          'MMR',
          '--at-or-after',
          'created_at:2026-01-01',
          '--offset',
          '0',
          '-q',
          'x',
          '-f',
          'json',
        ],
        () => store,
        io,
      ),
    ).toBe(0);
  });
});

// A create/update-owned flag parsed through the ONE shared options table used to
// reach `list`/`next` unrefused: `mimir list --parent KEY` exited 0 with the
// FULL unfiltered board, silently discarding the caller's apparent filter (the
// exact failure `--offset` and `--since` were already guarded against, one
// flag over) rather than the hard usage error a misspelled selector gets.
// `neverStore` proves the guard fires before any dispatch — never mind a query
// — ever opens the store (MMR-39).
describe('create/update-owned flags cannot silently narrow list/next (MMR-360)', () => {
  // The exact reproduction from the report, across both formats a human or an
  // agent would actually run it in.
  test.each([
    ['list', 'list', ['list', '--parent', 'MMR-2']],
    ['list -f json', 'list', ['list', '--parent', 'MMR-2', '-f', 'json']],
    ['next', 'next', ['next', '--parent', 'MMR-2']],
    ['next -f json', 'next', ['next', '--parent', 'MMR-2', '-f', 'json']],
  ])('%s --parent KEY exits 2 with no stdout and the --eq redirect', async (_label, verb, argv) => {
    const io = fakeIo(true);
    expect(await runCli(argv, neverStore, io)).toBe(2);
    expect(io.out).toHaveLength(0);
    expect(io.err.join('')).toContain(`'--parent' doesn't apply to ${verb}`);
    expect(io.err.join('')).toContain('--eq parent:KEY');
  });

  // The rest of the MMR-360 sweep: every other write-owned flag whose spelling
  // doubles as a `QUERY_FIELDS` name gets the identical refusal, not a silent
  // no-op that looks like an empty-or-full-set answer to a real filter.
  test.each([
    ['--title', 'a'],
    ['--summary', 'a'],
    ['--target', 'a'],
    ['--ref', 'a'],
    ['--upstream', 'MMR-s1'],
    ['--host', 'a'],
    ['--harness', 'a'],
    ['--session', 'a'],
    ['--branch', 'a'],
  ])('list rejects %s before touching the store', async (flag, value) => {
    const io = fakeIo(true);
    expect(await runCli(['list', flag, value], neverStore, io)).toBe(2);
    expect(io.out).toHaveLength(0);
    expect(io.err.join('')).toContain(`'${flag}' doesn't apply to list`);
    expect(io.err.join('')).toMatch(/--eq \S+:KEY/);
  });

  test.each([
    ['--title', 'a'],
    ['--summary', 'a'],
    ['--target', 'a'],
    ['--ref', 'a'],
    ['--upstream', 'MMR-s1'],
    ['--host', 'a'],
    ['--harness', 'a'],
    ['--session', 'a'],
    ['--branch', 'a'],
  ])('next rejects %s before touching the store', async (flag, value) => {
    const io = fakeIo(true);
    expect(await runCli(['next', flag, value], neverStore, io)).toBe(2);
    expect(io.out).toHaveLength(0);
    expect(io.err.join('')).toContain(`'${flag}' doesn't apply to next`);
  });

  // The flags stay usable on the verbs that actually own them — the guard
  // refuses a MISMATCHED owner, not the flag itself.
  test.skipIf(!NORN)('--parent stays create/promote-owned', async () => {
    const io = fakeIo(false);
    expect(
      await runCli(
        ['create', 'task', 'via parent', '--parent', 'MMR-1', '-f', 'ids'],
        () => store,
        io,
      ),
    ).toBe(0);
  });
});

// `--project` has no `QUERY_FIELDS` counterpart, but `attach`/`seed`/`seeds` all
// read it as a real filter/selector — the same "looks like a working filter on
// a sibling verb" hazard as `--parent`, just in the opposite direction: without
// the guard, `mimir list --project KEY` exited 0 with the FULL cross-project
// board (confirmed against a two-project store), read by the caller as a
// per-project one. `--requester` is `seeds`' own filter and shares the same
// hazard. Both redirect to real selectors rather than a nonexistent `--eq`.
describe('--project and --requester cannot silently broaden list/next (MMR-360)', () => {
  test.each([
    ['list', 'list', ['list', '--project', 'MMR']],
    ['list -f json', 'list', ['list', '--project', 'MMR', '-f', 'json']],
    ['next', 'next', ['next', '--project', 'MMR']],
    ['next -f json', 'next', ['next', '--project', 'MMR', '-f', 'json']],
  ])(
    '%s --project KEY exits 2 with no stdout and the --scope redirect',
    async (_label, verb, argv) => {
      const io = fakeIo(true);
      expect(await runCli(argv, neverStore, io)).toBe(2);
      expect(io.out).toHaveLength(0);
      expect(io.err.join('')).toContain(`'--project' doesn't apply to ${verb}`);
      expect(io.err.join('')).toContain('-s, --scope KEY');
    },
  );

  test.each([
    ['list', 'list', ['list', '--requester', 'MMR']],
    ['list -f json', 'list', ['list', '--requester', 'MMR', '-f', 'json']],
    ['next', 'next', ['next', '--requester', 'MMR']],
    ['next -f json', 'next', ['next', '--requester', 'MMR', '-f', 'json']],
  ])('%s --requester KEY exits 2 with no stdout', async (_label, verb, argv) => {
    const io = fakeIo(true);
    expect(await runCli(argv, neverStore, io)).toBe(2);
    expect(io.out).toHaveLength(0);
    expect(io.err.join('')).toContain(`'--requester' doesn't apply to ${verb}`);
    expect(io.err.join('')).toContain('use it with seeds');
  });

  // The flags stay usable on the verbs that actually own them.
  test.skipIf(!NORN)('--project stays attach/seed/seeds-owned', async () => {
    const io = fakeIo(false);
    expect(
      await runCli(['seed', 'an ask', '-k', 'idea', '--project', 'MMR'], () => store, io),
    ).toBe(0);
  });

  test.skipIf(!NORN)('--requester stays seeds-owned', async () => {
    const io = fakeIo(false);
    expect(await runCli(['seeds', '--requester', 'MMR', '-f', 'json'], () => store, io)).toBe(0);
  });
});

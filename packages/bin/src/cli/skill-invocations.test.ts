import { expect, test } from 'bun:test';

import { SKILL_FILES } from './skill-assets';
import { extractInvocations, invocationProblems } from './skill-invocations';

const fence = (body: string): string => ['```sh', body, '```'].join('\n');

const words = (markdown: string): string[][] =>
  extractInvocations('doc.md', markdown).map((inv) => inv.words);

test('a fenced block yields each mimir invocation, continuations joined and comments dropped', () => {
  const md = fence(
    [
      'mimir create task "A discrete outcome" --parent KEY-4 \\',
      '    --priority p1   # trailing comment',
      'echo unrelated',
    ].join('\n'),
  );
  expect(words(md)).toEqual([
    ['create', 'task', 'A discrete outcome', '--parent', 'KEY-4', '--priority', 'p1'],
  ]);
});

test('a command substitution yields its inner invocation, which a pipe ends', () => {
  const md = fence(
    [
      'ID=$(mimir create task "…" --parent KEY-2 -f ids)',
      'mimir next -f ids | head -1',
      'cat report.md | mimir attach KEY-9 --title "Perf report"',
    ].join('\n'),
  );
  expect(words(md)).toEqual([
    ['create', 'task', '…', '--parent', 'KEY-2', '-f', 'ids'],
    ['next', '-f', 'ids'],
    ['attach', 'KEY-9', '--title', 'Perf report'],
  ]);
});

test('optional brackets and flag alternatives read as one invocation', () => {
  const md = fence(
    [
      'mimir create initiative "Goal" --parent KEY [--desc "…"] [--tag t]...',
      'mimir reorder KEY-9 --top | --bottom | --before KEY-7',
    ].join('\n'),
  );
  expect(words(md)).toEqual([
    ['create', 'initiative', 'Goal', '--parent', 'KEY', '--desc', '…', '--tag', 't'],
    ['reorder', 'KEY-9', '--top', '--bottom', '--before', 'KEY-7'],
  ]);
});

test('an inline code span that starts with mimir is an invocation; prose spans are not', () => {
  const md = 'Run `mimir overview -s KEY` first, then `done <id>` when verified.';
  expect(words(md)).toEqual([['overview', '-s', 'KEY']]);
});

test('a valid invocation has no problems', async () => {
  const [inv] = extractInvocations('doc.md', '`mimir create task "x" --parent KEY-4 -f ids`');
  expect(inv).toBeDefined();
  expect(await invocationProblems(inv!)).toEqual([]);
});

test('an unknown verb, unknown subcommand, or undeclared flag is a problem', async () => {
  const md = [
    '`mimir describe KEY-9`',
    '`mimir create bogus "x" --parent KEY-4`',
    '`mimir scratch rename <uuid>`',
    '`mimir done KEY-9 --priority p1`',
    '`mimir list --direction "x"`',
  ].join('\n');
  const problems = await Promise.all(extractInvocations('doc.md', md).map(invocationProblems));
  for (const found of problems) {
    expect(found.length).toBeGreaterThan(0);
  }
});

test('placeholders stand in for the verb or subcommand without being checked', async () => {
  const md = '`mimir <cmd> -h` and `mimir scratch <operation>`';
  const problems = await Promise.all(extractInvocations('doc.md', md).map(invocationProblems));
  expect(problems).toEqual([[], []]);
});

// The guard: the skill teaches agents exact verbs and flags, and agents drive
// the CLI from it. A rename that misses the skill would teach a dead command.
test('every mimir invocation the shipped skill shows is one the CLI accepts', async () => {
  const invocations = SKILL_FILES.flatMap((f) => extractInvocations(f.path, f.content));
  expect(invocations.length).toBeGreaterThan(80);
  const problems: string[] = [];
  for (const inv of invocations) {
    for (const problem of await invocationProblems(inv)) {
      problems.push(`${inv.file}: \`mimir ${inv.text}\` — ${problem}`);
    }
  }
  expect(problems).toEqual([]);
});

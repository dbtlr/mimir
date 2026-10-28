import { afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { argvCase, argvLine } from '../testing/argv-case';
import type { ParityCase } from '../testing/parity';
import { SCRATCH_REDIRECTS } from '../testing/redirects';
import { writeCases } from '../testing/writes';

/**
 * The scratch writes act on a Scratchpad each board carries, named by tokens:
 * `{pad}` has a journal entry and four agenda items (the third done), `{blank}`
 * has neither, `{gone}` was discarded, and `{token}` is the guard they hold.
 */
const dir = mkdtempSync(join(tmpdir(), 'mimir-scratch-parity-'));
const file = join(dir, 'checkpoint.md');
/** A case named without the temp directory, so its name is the same on every run. */
const inDir = (c: ParityCase): ParityCase => ({ ...c, name: c.name.replaceAll(dir, '<dir>') });
writeFileSync(file, 'Distinctive file checkpoint 7c1e.\n\nTwo paragraphs.\n');
afterAll(() => {
  rmSync(dir, { force: true, recursive: true });
});

const GUARD = { 'expected-updated-at': '{token}' } as const;
const STALE = '2020-01-01T00:00:00.000Z';
const MISSING = '00000000-0000-4000-8000-000000000000';

const scratch = (
  sub: string,
  name: string,
  args: Record<string, string> = {},
  options: ParityCase['options'] = {},
  bound?: string,
): ParityCase => ({
  args,
  name: `scratch ${sub} ${name}`,
  options,
  path: ['scratch', sub],
  ...(bound === undefined ? {} : { bound }),
});

const CASES: ParityCase[] = [
  // create
  scratch('create', 'bound', { words: 'Index rewrite' }, {}, 'MMR'),
  scratch('create', '-f ids', { words: 'Index rewrite' }, { format: 'ids' }, 'MMR'),
  scratch('create', '-f json', { words: 'Index rewrite' }, { format: 'json' }, 'MMR'),
  scratch('create', '-f jsonl', { words: 'Index rewrite' }, { format: 'jsonl' }, 'MMR'),
  scratch('create', '-f table', { words: 'Index rewrite' }, { format: 'table' }, 'MMR'),
  scratch('create', '--ascii', { words: 'Index rewrite' }, { ascii: true }, 'MMR'),
  scratch('create', 'words', { words: 'Index' }, {}, 'MMR'),
  scratch('create', '--title', {}, { title: 'From a flag' }, 'MMR'),
  scratch('create', '--title wins', { words: 'Ignored' }, { title: 'From a flag' }, 'MMR'),
  scratch('create', '--link', { words: 'Linked' }, { link: ['MMR-3', 'MMR-4'] }, 'MMR'),
  scratch('create', '--scope XX', { words: 'Elsewhere' }, { scope: 'XX' }),
  scratch('create', '--scope XX (bound elsewhere)', { words: 'Elsewhere' }, { scope: 'XX' }, 'MMR'),
  scratch('create', '(unbound)', { words: 'Nowhere' }),
  scratch('create', '--scope all', { words: 'Nowhere' }, { scope: 'all' }, 'MMR'),
  scratch('create', '(no title)', {}, {}, 'MMR'),
  scratch('create', '(blank title)', {}, { title: ' ' }, 'MMR'),
  scratch('create', '--scope ZZ', { words: 'Nowhere' }, { scope: 'ZZ' }),
  scratch('create', '--scope nope', { words: 'Nowhere' }, { scope: 'nope' }),
  scratch('create', '--link MMR-99', { words: 'Bad link' }, { link: ['MMR-99'] }, 'MMR'),
  scratch('create', '--bogus', { words: 'Bad flag' }, { bogus: 'x' }, 'MMR'),

  // update
  scratch('update', '--title', { id: '{pad}' }, { ...GUARD, title: 'Renamed' }),
  scratch(
    'update',
    '--title -f ids',
    { id: '{pad}' },
    { ...GUARD, format: 'ids', title: 'Renamed' },
  ),
  scratch(
    'update',
    '--title -f json',
    { id: '{pad}' },
    { ...GUARD, format: 'json', title: 'Renamed' },
  ),
  scratch(
    'update',
    '--title -f jsonl',
    { id: '{pad}' },
    { ...GUARD, format: 'jsonl', title: 'Renamed' },
  ),
  scratch(
    'update',
    '--title -f table',
    { id: '{pad}' },
    { ...GUARD, format: 'table', title: 'Renamed' },
  ),
  scratch('update', '--link', { id: '{pad}' }, { ...GUARD, link: ['MMR-4'] }),
  scratch('update', '--clear-links', { id: '{pad}' }, { ...GUARD, 'clear-links': true }),
  scratch('update', '(no change)', { id: '{pad}' }, GUARD),
  scratch(
    'update',
    '--clear-links --link',
    { id: '{pad}' },
    { ...GUARD, 'clear-links': true, link: ['MMR-4'] },
  ),
  scratch('update', '(no guard)', { id: '{pad}' }, { title: 'Renamed' }),
  scratch(
    'update',
    '(stale guard)',
    { id: '{pad}' },
    { 'expected-updated-at': STALE, title: 'Renamed' },
  ),
  scratch(
    'update',
    '(unreadable guard)',
    { id: '{pad}' },
    { 'expected-updated-at': 'nope', title: 'Renamed' },
  ),
  scratch('update', '(unknown pad)', { id: MISSING }, { ...GUARD, title: 'Renamed' }),
  scratch('update', '(discarded pad)', { id: '{gone}' }, { ...GUARD, title: 'Renamed' }),
  scratch('update', '(not a uuid)', { id: 'nope' }, { ...GUARD, title: 'Renamed' }),
  scratch('update', '(no id)', {}, GUARD),

  // checkpoint
  scratch('checkpoint', 'inline', { id: '{pad}', text: 'Settled the plan.' }, GUARD),
  scratch(
    'checkpoint',
    '-f ids',
    { id: '{pad}', text: 'Settled the plan.' },
    { ...GUARD, format: 'ids' },
  ),
  scratch(
    'checkpoint',
    '-f json',
    { id: '{pad}', text: 'Settled the plan.' },
    { ...GUARD, format: 'json' },
  ),
  scratch(
    'checkpoint',
    '-f jsonl',
    { id: '{pad}', text: 'Settled the plan.' },
    { ...GUARD, format: 'jsonl' },
  ),
  scratch('checkpoint', 'on a blank pad', { id: '{blank}', text: 'First entry.' }, GUARD),
  scratch(
    'checkpoint',
    '-f table',
    { id: '{pad}', text: 'Settled.' },
    { ...GUARD, format: 'table' },
  ),
  scratch('checkpoint', '(no id)', {}, GUARD),
  scratch('checkpoint', '(no content)', { id: '{pad}' }, GUARD),
  scratch('checkpoint', '(no guard)', { id: '{pad}', text: 'Settled.' }),
  scratch(
    'checkpoint',
    '(stale guard)',
    { id: '{pad}', text: 'Settled.' },
    { 'expected-updated-at': STALE },
  ),
  scratch('checkpoint', '(unknown pad)', { id: MISSING, text: 'Settled.' }, GUARD),
  scratch('checkpoint', '(discarded pad)', { id: '{gone}', text: 'Settled.' }, GUARD),

  // agenda
  scratch('agenda', 'add', { action: 'add', id: '{pad}', words: 'Do the thing' }, GUARD),
  scratch(
    'agenda',
    'add -f ids',
    { action: 'add', id: '{pad}', words: 'Do the thing' },
    { ...GUARD, format: 'ids' },
  ),
  scratch(
    'agenda',
    'add -f json',
    { action: 'add', id: '{pad}', words: 'Do the thing' },
    { ...GUARD, format: 'json' },
  ),
  scratch(
    'agenda',
    'add -f table',
    { action: 'add', id: '{pad}', words: 'Do the thing' },
    { ...GUARD, format: 'table' },
  ),
  scratch('agenda', 'add (no content)', { action: 'add', id: '{pad}' }, GUARD),
  scratch('agenda', 'add (no guard)', { action: 'add', id: '{pad}', words: 'Do it' }),
  scratch(
    'agenda',
    'add (stale guard)',
    { action: 'add', id: '{pad}', words: 'Do it' },
    { 'expected-updated-at': STALE },
  ),
  scratch('agenda', 'add (unknown pad)', { action: 'add', id: MISSING, words: 'Do it' }, GUARD),
  scratch('agenda', 'add (discarded pad)', { action: 'add', id: '{gone}', words: 'Do it' }, GUARD),
  scratch('agenda', 'complete 1', { action: 'complete', id: '{pad}', words: '1' }, GUARD),
  scratch(
    'agenda',
    'complete 1 -f json',
    { action: 'complete', id: '{pad}', words: '1' },
    { ...GUARD, format: 'json' },
  ),
  scratch(
    'agenda',
    'complete 1 -f ids',
    { action: 'complete', id: '{pad}', words: '1' },
    { ...GUARD, format: 'ids' },
  ),
  scratch(
    'agenda',
    'complete 3 (already done)',
    { action: 'complete', id: '{pad}', words: '3' },
    GUARD,
  ),
  scratch(
    'agenda',
    'complete 9 (no such item)',
    { action: 'complete', id: '{pad}', words: '9' },
    GUARD,
  ),
  scratch('agenda', 'complete 0', { action: 'complete', id: '{pad}', words: '0' }, GUARD),
  scratch('agenda', 'complete x', { action: 'complete', id: '{pad}', words: 'x' }, GUARD),
  scratch('agenda', 'complete 1.5', { action: 'complete', id: '{pad}', words: '1.5' }, GUARD),
  scratch('agenda', 'complete (no number)', { action: 'complete', id: '{pad}' }, GUARD),
  scratch('agenda', 'complete (no guard)', { action: 'complete', id: '{pad}', words: '1' }),
  scratch(
    'agenda',
    'supersede 2',
    { action: 'supersede', id: '{pad}', words: '2' },
    { ...GUARD, reason: 'folded into 1' },
  ),
  scratch(
    'agenda',
    'supersede 2 -f json',
    { action: 'supersede', id: '{pad}', words: '2' },
    { ...GUARD, format: 'json', reason: 'folded' },
  ),
  scratch(
    'agenda',
    'supersede 2 -f ids',
    { action: 'supersede', id: '{pad}', words: '2' },
    { ...GUARD, format: 'ids', reason: 'folded' },
  ),
  scratch(
    'agenda',
    'supersede 3 (already done)',
    { action: 'supersede', id: '{pad}', words: '3' },
    { ...GUARD, reason: 'too late' },
  ),
  scratch(
    'agenda',
    'supersede 2 (no reason)',
    { action: 'supersede', id: '{pad}', words: '2' },
    GUARD,
  ),
  scratch('agenda', 'supersede (no number)', { action: 'supersede', id: '{pad}' }, GUARD),
  scratch(
    'agenda',
    'supersede 9 (no such item)',
    { action: 'supersede', id: '{pad}', words: '9' },
    { ...GUARD, reason: 'why' },
  ),
  scratch('agenda', 'frob', { action: 'frob', id: '{pad}', words: 'x' }, GUARD),
  scratch('agenda', '(no action)', {}, GUARD),
  scratch('agenda', '(no id)', { action: 'add' }, GUARD),

  // freeze
  scratch('freeze', '--summary', { id: '{pad}' }, { ...GUARD, summary: 'The index notes' }),
  scratch(
    'freeze',
    '--summary -f ids',
    { id: '{pad}' },
    { ...GUARD, format: 'ids', summary: 'The index notes' },
  ),
  scratch(
    'freeze',
    '--summary -f json',
    { id: '{pad}' },
    { ...GUARD, format: 'json', summary: 'The index notes' },
  ),
  scratch(
    'freeze',
    '--summary -f jsonl',
    { id: '{pad}' },
    { ...GUARD, format: 'jsonl', summary: 'The index notes' },
  ),
  scratch(
    'freeze',
    '--summary -f table',
    { id: '{pad}' },
    { ...GUARD, format: 'table', summary: 'The index notes' },
  ),
  scratch(
    'freeze',
    '--tag',
    { id: '{pad}' },
    { ...GUARD, summary: 'The index notes', tag: ['design', 'index'] },
  ),
  scratch('freeze', 'a blank pad', { id: '{blank}' }, { ...GUARD, summary: 'Nothing yet' }),
  scratch('freeze', '(no summary)', { id: '{pad}' }, GUARD),
  scratch('freeze', '(no guard)', { id: '{pad}' }, { summary: 'The index notes' }),
  scratch(
    'freeze',
    '(stale guard)',
    { id: '{pad}' },
    { 'expected-updated-at': STALE, summary: 'x' },
  ),
  scratch('freeze', '(unknown pad)', { id: MISSING }, { ...GUARD, summary: 'x' }),
  scratch('freeze', '(discarded pad)', { id: '{gone}' }, { ...GUARD, summary: 'x' }),

  // discard
  scratch('discard', 'a blank pad', { id: '{blank}' }, GUARD),
  scratch('discard', 'a blank pad -f ids', { id: '{blank}' }, { ...GUARD, format: 'ids' }),
  scratch('discard', 'a blank pad -f json', { id: '{blank}' }, { ...GUARD, format: 'json' }),
  scratch('discard', 'a blank pad -f jsonl', { id: '{blank}' }, { ...GUARD, format: 'jsonl' }),
  scratch('discard', 'a blank pad -f table', { id: '{blank}' }, { ...GUARD, format: 'table' }),
  scratch('discard', 'a pad with work', { id: '{pad}' }, GUARD),
  scratch('discard', '--force', { id: '{pad}' }, { ...GUARD, force: true }),
  scratch(
    'discard',
    '--force --reason',
    { id: '{pad}' },
    { ...GUARD, force: true, reason: 'superseded by the host work' },
  ),
  scratch('discard', '--reason', { id: '{blank}' }, { ...GUARD, reason: 'changed my mind' }),
  scratch('discard', '(no guard)', { id: '{blank}' }),
  scratch('discard', '(stale guard)', { id: '{blank}' }, { 'expected-updated-at': STALE }),
  scratch('discard', '(unknown pad)', { id: MISSING }, GUARD),
  scratch('discard', '(discarded pad)', { id: '{gone}' }, GUARD),

  // Through Loom's parser, as a shell spells them.
  argvCase(['scratch', 'create', 'Index rewrite', '-s', 'MMR']),
  argvCase(['scratch', 'create', 'a', 'b', 'c', '-s', 'MMR']),
  argvCase(['scratch', 'create', '--title', 'x', '-s', 'MMR', '-f', 'json']),
  argvCase(['scratch', 'create', 'x', '--link', 'MMR-3', '--link', 'MMR-4', '-s', 'MMR']),
  argvCase(['scratch', 'create', 'x', '-s', 'MMR', '-s', 'XX']),
  argvCase(['scratch', 'create', 'x', '-s', 'MMR'], true),
  argvCase(['scratch', 'update', '{pad}', '--expected-updated-at', '{token}', '--title', 't']),
  argvCase(
    ['scratch', 'update', '{pad}', '--expected-updated-at', '{token}', '--title', 't'],
    true,
  ),
  argvCase([
    'scratch',
    'update',
    '{pad}',
    '--expected-updated-at',
    '{token}',
    '--title',
    't',
    '--title',
    'u',
  ]),
  // A checkpoint from a file; its content is distinctive so the board snapshot covers it.
  inDir(
    argvCase([
      'scratch',
      'checkpoint',
      '{pad}',
      '--file',
      file,
      '--expected-updated-at',
      '{token}',
    ]),
  ),
  inDir(
    argvCase([
      'scratch',
      'checkpoint',
      '{pad}',
      'Both.',
      '--file',
      file,
      '--expected-updated-at',
      '{token}',
    ]),
  ),
  argvCase(['scratch', 'checkpoint', '{pad}', 'a', 'b', '--expected-updated-at', '{token}'], true),
  // Misplaced flags, each redirected as the old CLI redirected them.
  ...SCRATCH_REDIRECTS.map((line) => argvLine(line, { path: line.split(' ').slice(0, 2) })),
  // A write's -s before the verb: Loom scopes an option to the command that declares it.
  argvCase(['-s', 'MMR', 'scratch', 'create', 'x'], undefined, undefined, ['scratch', 'create']),
  argvCase(['scratch', 'checkpoint', '{pad}', 'a', 'b', 'c', '--expected-updated-at', '{token}']),
  // Words after -- are text, as the old CLI's positionals took them.
  argvCase([
    'scratch',
    'checkpoint',
    '{pad}',
    'Settled',
    '--expected-updated-at',
    '{token}',
    '--',
    '-1',
    'day',
  ]),
  argvCase([
    'scratch',
    'agenda',
    'add',
    '{pad}',
    'Do',
    '--expected-updated-at',
    '{token}',
    '--',
    '-x',
    'item',
  ]),
  argvCase([
    'scratch',
    'agenda',
    'supersede',
    '{pad}',
    '2',
    'because',
    '--expected-updated-at',
    '{token}',
    '--',
    '-1',
    'day',
  ]),
  argvCase([
    'scratch',
    'agenda',
    'complete',
    '{pad}',
    '--expected-updated-at',
    '{token}',
    '--',
    '1',
  ]),
  argvCase(['scratch', 'create', 'Index', '-s', 'MMR', '--', '-rewrite']),
  argvCase(['scratch', 'agenda', 'add', '{pad}', 'a', 'b', '--expected-updated-at', '{token}']),
  argvCase(['scratch', 'agenda', 'complete', '{pad}', '1', '--expected-updated-at', '{token}']),
  argvCase([
    'scratch',
    'agenda',
    'supersede',
    '{pad}',
    '2',
    'because',
    '--expected-updated-at',
    '{token}',
  ]),
  argvCase(
    ['scratch', 'agenda', 'supersede', '{pad}', '2', 'because', '--expected-updated-at', '{token}'],
    true,
  ),
  argvCase([
    'scratch',
    'freeze',
    '{pad}',
    '--summary',
    's',
    '-t',
    'a',
    '-t',
    'b',
    '--expected-updated-at',
    '{token}',
  ]),
  argvCase(
    ['scratch', 'freeze', '{pad}', '--summary', 's', '--expected-updated-at', '{token}'],
    true,
  ),
  argvCase(['scratch', 'discard', '{blank}', '--force', '--expected-updated-at', '{token}']),
  argvCase(['scratch', 'discard', '{blank}', '--expected-updated-at', '{token}'], true),
];

writeCases(import.meta.url, CASES);

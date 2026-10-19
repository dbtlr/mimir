import { GET_REDIRECTS } from '../parity/differences';
import { argvCase, argvLine } from '../testing/argv-case';
import { parityCases } from '../testing/parity';
import type { ParityCase } from '../testing/parity';

const get = (name: string, id: string | undefined, options: ParityCase['options'] = {}) => ({
  ...(id === undefined ? {} : { args: { id } }),
  name,
  options,
  path: ['get'],
});

const CASES: ParityCase[] = [
  // A task, through every format.
  get('get MMR-3', 'MMR-3'),
  get('get MMR-3 -f records', 'MMR-3', { format: 'records' }),
  get('get MMR-3 -f table', 'MMR-3', { format: 'table' }),
  get('get MMR-3 -f ids', 'MMR-3', { format: 'ids' }),
  get('get MMR-3 -f json', 'MMR-3', { format: 'json' }),
  get('get MMR-3 -f jsonl', 'MMR-3', { format: 'jsonl' }),
  get('get MMR-3 --ascii', 'MMR-3', { ascii: true }),
  // Facets, repeated and comma-separated.
  get('get MMR-3 --col history', 'MMR-3', { col: ['history'] }),
  get('get MMR-3 --col history -f json', 'MMR-3', { col: ['history'], format: 'json' }),
  get('get MMR-3 --col annotations', 'MMR-3', { col: ['annotations'] }),
  get('get MMR-3 --col verdicts', 'MMR-3', { col: ['verdicts'] }),
  get('get MMR-3 --col deps,tags -f json', 'MMR-3', { col: ['deps,tags'], format: 'json' }),
  get('get MMR-3 --col content', 'MMR-3', { col: ['content'] }),
  // Other states and containers.
  get('get MMR-4', 'MMR-4'),
  get('get MMR-4 -f json', 'MMR-4', { format: 'json' }),
  get('get MMR-5', 'MMR-5'),
  get('get MMR-5 -f json', 'MMR-5', { format: 'json' }),
  get('get MMR-5 --col history', 'MMR-5', { col: ['history'] }),
  get('get MMR-6', 'MMR-6'),
  get('get MMR-7 -f json', 'MMR-7', { format: 'json' }),
  get('get MMR-7', 'MMR-7'),
  get('get MMR-7 --col history', 'MMR-7', { col: ['history'] }),
  get('get MMR-2', 'MMR-2'),
  get('get MMR-2 -f json', 'MMR-2', { format: 'json' }),
  get('get MMR-1 -f table', 'MMR-1', { format: 'table' }),
  get('get MMR', 'MMR'),
  get('get MMR -f json', 'MMR', { format: 'json' }),
  // An artifact.
  get('get MMR-a1', 'MMR-a1'),
  get('get MMR-a1 --col content', 'MMR-a1', { col: ['content'] }),
  get('get MMR-a1 --col content -f json', 'MMR-a1', { col: ['content'], format: 'json' }),
  get('get MMR-a1 -f table', 'MMR-a1', { format: 'table' }),
  get('get MMR-a1 -f ids', 'MMR-a1', { format: 'ids' }),
  // A seed.
  get('get MMR-s1', 'MMR-s1'),
  get('get MMR-s1 -f json', 'MMR-s1', { format: 'json' }),
  get('get MMR-s1 -f table', 'MMR-s1', { format: 'table' }),
  get('get MMR-s1 -f ids', 'MMR-s1', { format: 'ids' }),
  // Refusals Mimir raises.
  get('get MMR-99', 'MMR-99'),
  get('get MMR-99 -f json', 'MMR-99', { format: 'json' }),
  get('get MMR-a99', 'MMR-a99'),
  get('get MMR-s99', 'MMR-s99'),
  get('get NOPE', 'NOPE'),
  get('get mmr-3', 'mmr-3'),
  get('get MMR-3 --col bogus', 'MMR-3', { col: ['bogus'] }),
  get('get MMR-3 --col status', 'MMR-3', { col: ['status'] }),
  get('get MMR-3 --col lede', 'MMR-3', { col: ['lede'] }),
  get('get MMR-3 --col .history', 'MMR-3', { col: ['.history'] }),
  // Faults Loom's parser raises.
  get('get (no id)', undefined),
  get('get MMR-3 --tz UTC', 'MMR-3', { tz: 'UTC' }),
  get('get MMR-3 -f yaml', 'MMR-3', { format: 'yaml' }),
  // Through Loom's parser, as a shell spells them.
  argvCase(['get', 'MMR-3']),
  argvCase(['get', 'MMR-3', '-f', 'json']),
  argvCase(['get', 'MMR-3', '--format', 'ids']),
  argvCase(['get', 'MMR-3', '--col', 'lede']),
  argvCase(['get', 'MMR-3', '--col', 'bogus']),
  argvCase(['get', 'NOPE', '-f', 'json']),
  // Invocations the old CLI accepted and Loom's parser refuses.
  argvCase(['get', 'MMR-3', '-f', 'json', '-f', 'ids']),
  argvCase(['get', 'MMR-3', 'extra']),
  // Flags that belong to the query commands, redirected as the old CLI redirected them.
  ...GET_REDIRECTS.map((line) => argvLine(`get ${line}`)),
  // On a color terminal.
  argvCase(['get', 'MMR-3'], true),
  argvCase(['get', 'MMR-3', '-f', 'table'], true),
  argvCase(['get', 'MMR-a1'], true),
];

parityCases(/^get /, CASES);

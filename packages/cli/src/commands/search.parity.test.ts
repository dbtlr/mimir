import { argvCase } from '../testing/argv-case';
import { parityCases } from '../testing/parity';
import type { ParityCase } from '../testing/parity';

/**
 * By-name cases carry a one-word query; the Engine searches the one project, so
 * every query here matches records of the named project alone.
 */
const search = (
  name: string,
  query?: string,
  options: ParityCase['options'] = {},
  bound?: string,
): ParityCase => ({
  ...(query === undefined ? {} : { args: { query } }),
  name,
  options,
  path: ['search'],
  ...(bound === undefined ? {} : { bound }),
});

const CASES: ParityCase[] = [
  // The hits, through every format.
  search('search store -s MMR', 'store', { scope: 'MMR' }),
  search('search store -s MMR -f records', 'store', { format: 'records', scope: 'MMR' }),
  search('search store -s MMR -f ids', 'store', { format: 'ids', scope: 'MMR' }),
  search('search store -s MMR -f json', 'store', { format: 'json', scope: 'MMR' }),
  search('search store -s MMR -f jsonl', 'store', { format: 'jsonl', scope: 'MMR' }),
  search('search store -s MMR --ascii', 'store', { ascii: true, scope: 'MMR' }),
  // An id finds its record, and what links to it.
  search('search MMR-3 -s MMR', 'MMR-3', { scope: 'MMR' }),
  search('search MMR-3 -s MMR -f json', 'MMR-3', { format: 'json', scope: 'MMR' }),
  search('search 3 -s MMR -f ids', '3', { format: 'ids', scope: 'MMR' }),
  search('search notes -s MMR', 'notes', { scope: 'MMR' }),
  search('search keep -s MMR -f json', 'keep', { format: 'json', scope: 'MMR' }),
  // The clone binding supplies the project; an explicit -s overrides it.
  search('search store (bound to MMR)', 'store', {}, 'MMR'),
  search('search store (bound to MMR) -f ids', 'store', { format: 'ids' }, 'MMR'),
  search('search ours -s XX (bound to MMR)', 'ours', { scope: 'XX' }, 'MMR'),
  // Paging.
  search('search store -s MMR -n 1', 'store', { limit: '1', scope: 'MMR' }),
  search('search task -s MMR -n 100 -f ids', 'task', { format: 'ids', limit: '100', scope: 'MMR' }),
  // An empty set.
  search('search zzzz -s MMR', 'zzzz', { scope: 'MMR' }),
  search('search zzzz -s MMR -f json', 'zzzz', { format: 'json', scope: 'MMR' }),
  search('search zzzz -s MMR -f ids', 'zzzz', { format: 'ids', scope: 'MMR' }),
  // Refusals Mimir raises.
  search('search store -s MMR -n 0', 'store', { limit: '0', scope: 'MMR' }),
  search('search store -s MMR -n 101', 'store', { limit: '101', scope: 'MMR' }),
  search('search store -s MMR -n 2x', 'store', { limit: '2x', scope: 'MMR' }),
  search('search store -s NOPE', 'store', { scope: 'NOPE' }),
  search('search store -s mmr', 'store', { scope: 'mmr' }),
  // Faults Loom's parser raises.
  search('search (no query)'),
  search('search store -s MMR --bogus', 'store', { bogus: true, scope: 'MMR' }),
  // Through Loom's parser, as a shell spells them.
  argvCase(['search', 'store', '-s', 'MMR']),
  argvCase(['search', 'store', '-s', 'MMR', '-f', 'json']),
  argvCase(['search', 'cross', 'record', '-s', 'MMR']),
  argvCase(['search', 'Wire', 'the', 'store', '-s', 'MMR', '-f', 'ids']),
  argvCase(['search', '--scope', 'MMR', '--limit', '2', '--format', 'ids', 'store']),
  argvCase(['search', 'store', '-s', 'MMR', '-n', '0', '-f', 'json']),
  argvCase(['search', 'store', '-s', 'MMR', '--bogus', '-f', 'json']),
  // Words after -- are query text, as the old CLI's positionals took them.
  argvCase(['search', '-s', 'MMR', '-f', 'ids', '--', 'store']),
  argvCase(['search', '-s', 'MMR', '-f', 'json', '--', '-store']),
  // Invocations the old CLI accepted and Loom's parser refuses.
  argvCase(['search', 'store', '-s', 'MMR', '-n', '1', '-n', '2', '-f', 'ids']),
  argvCase(['-s', 'MMR', 'search', 'store', '-f', 'ids'], undefined, undefined, ['search']),
  // The old CLI also returned other projects' hits; the new one reads the named board (ADR 0034).
  argvCase(['search', 'ours', '-s', 'MMR', '-f', 'ids']),
  // On a color terminal.
  argvCase(['search', 'store', '-s', 'MMR'], true),
  argvCase(['search', 'MMR-3', '-s', 'MMR', '-f', 'records'], true),
  argvCase(['search', 'zzzz', '-s', 'MMR'], true),
];

parityCases(import.meta.url, CASES);

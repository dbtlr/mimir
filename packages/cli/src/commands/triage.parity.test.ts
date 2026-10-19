import { SEED_REDIRECTS } from '../parity/differences';
import { argvLine } from '../testing/argv-case';
import type { ParityCase } from '../testing/parity';
import { twinCases } from '../testing/twin';

const triage = (
  name: string,
  board: string | undefined,
  options: ParityCase['options'] = {},
  bound?: string,
): ParityCase => ({
  ...(board === undefined ? {} : { args: { board } }),
  name,
  options,
  path: ['triage'],
  ...(bound === undefined ? {} : { bound }),
});

/** A case both CLIs run as `triage <rest>`, the new one through Loom's parser. */
const argv = (rest: string, tty?: true): ParityCase =>
  argvLine(`triage ${rest}`, tty ? { tty } : {});

const CASES: ParityCase[] = [
  // The bound board, through every format.
  triage('triage (bound)', undefined, {}, 'MMR'),
  triage('triage -f records', undefined, { format: 'records' }, 'MMR'),
  triage('triage -f table', undefined, { format: 'table' }, 'MMR'),
  triage('triage -f ids', undefined, { format: 'ids' }, 'MMR'),
  triage('triage -f json', undefined, { format: 'json' }, 'MMR'),
  triage('triage -f jsonl', undefined, { format: 'jsonl' }, 'MMR'),
  triage('triage --ascii', undefined, { ascii: true, format: 'records' }, 'MMR'),
  // A preview writes nothing.
  triage('triage --dry-run', undefined, { 'dry-run': true }, 'MMR'),
  triage('triage --dry-run -f records', undefined, { 'dry-run': true, format: 'records' }, 'MMR'),
  // Another board: its seed resolved upstream of a task, so check (c) has a row.
  triage('triage XX', 'XX', { format: 'records' }),
  triage('triage XX -f json', 'XX', { format: 'json' }),
  triage('triage XX -f ids', 'XX', { format: 'ids' }),
  triage('triage XX --dry-run -f records', 'XX', { 'dry-run': true, format: 'records' }),
  triage('triage XX --dry-run -f json', 'XX', { 'dry-run': true, format: 'json' }),
  triage('triage XX (bound elsewhere)', 'XX', { format: 'records' }, 'MMR'),
  triage('triage --scope XX', undefined, { format: 'records', scope: 'XX' }),
  triage('triage --scope XX (bound elsewhere)', undefined, { format: 'json', scope: 'XX' }, 'MMR'),
  // Refusals Mimir raises.
  triage('triage (unbound)', undefined),
  triage('triage (blank board)', ' '),
  triage('triage ZZ', 'ZZ'),
  triage('triage nope', 'nope'),
  triage('triage --scope all', undefined, { scope: 'all' }, 'MMR'),
  // Faults Loom's parser raises.
  triage('triage --bogus', undefined, { bogus: 'x' }, 'MMR'),
  // Through Loom's parser, as a shell spells it.
  argv('MMR -f json'),
  argv('MMR --format jsonl'),
  argv('XX --dry-run -f records'),
  argv('-s MMR'),
  argv('MMR XX'),
  argv('MMR -f json -f ids'),
  // A misplaced flag, redirected as the old CLI redirected it.
  ...SEED_REDIRECTS.filter((line) => line.startsWith('triage ')).map((line) => argvLine(line)),
  // On a color terminal, where the default is the records report.
  argv('MMR', true),
  argv('XX', true),
  argv('XX --dry-run', true),
  argv('MMR -f json', true),
];

twinCases(/^triage /, CASES);

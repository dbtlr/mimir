import { argvLine } from '../testing/argv-case';
import type { ParityCase } from '../testing/parity';
import { writeCases } from '../testing/writes';

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
  // The bound board, through every format; piped, the default is json. Every
  // other case is one distinct input.
  triage('triage (bound)', undefined, {}, 'MMR'),
  triage('triage -f records', undefined, { format: 'records' }, 'MMR'),
  triage('triage -f table', undefined, { format: 'table' }, 'MMR'),
  triage('triage -f ids', undefined, { format: 'ids' }, 'MMR'),
  triage('triage -f jsonl', undefined, { format: 'jsonl' }, 'MMR'),
  triage('triage --ascii', undefined, { ascii: true, format: 'records' }, 'MMR'),
  // A preview writes nothing.
  triage('triage --dry-run', undefined, { 'dry-run': true }, 'MMR'),
  // Another board: its seed resolved upstream of a task, so check (c) has a row.
  triage('triage XX', 'XX', { format: 'records' }),
  triage('triage XX --dry-run -f records', 'XX', { 'dry-run': true, format: 'records' }),
  triage('triage XX (bound elsewhere)', 'XX', { format: 'records' }, 'MMR'),
  triage('triage --scope XX', undefined, { format: 'records', scope: 'XX' }),
  triage('triage --scope XX (bound elsewhere)', undefined, { format: 'json', scope: 'XX' }, 'MMR'),
  // Refusals Mimir raises.
  triage('triage (unbound)', undefined),
  triage('triage (blank board)', ' '),
  triage('triage ZZ', 'ZZ'),
  triage('triage nope', 'nope'),
  triage('triage --scope all', undefined, { scope: 'all' }, 'MMR'),
  // Through Loom's parser, as a shell spells it.
  argv('MMR -f json'),
  argv('XX --dry-run -f records'),
  argv('-s MMR'),
  // On a color terminal, where the default is the records report.
  argv('MMR', true),
];

writeCases(import.meta.url, CASES);

import { argvLine } from '../testing/argv-case';
import type { ArgvExtras } from '../testing/argv-case';
import type { ParityBoard } from '../testing/fixture';
import type { ParityCase } from '../testing/parity';
import { MACHINE_REDIRECTS } from '../testing/redirects';
import { writeCases } from '../testing/writes';

/** A clone's origin, which matches no project's remote. */
const STRANGER = 'git@github.com:acme/widgets.git';
/** The origin MMR records, so binding to MMR records nothing. */
const MIMIR_ORIGIN = 'git@github.com:dbtlr/mimir.git';
/** An origin two projects record, which makes an unbound clone ambiguous. */
const SHARED_ORIGIN = 'git@github.com:acme/shared.git';

const bind = (
  name: string,
  key: string | undefined,
  options: ParityCase['options'] = {},
  bound?: string,
  origin?: string,
): ParityCase => ({
  name,
  options,
  path: ['bind'],
  ...(key === undefined ? {} : { args: { key } }),
  ...(bound === undefined ? {} : { bound }),
  ...(origin === undefined ? {} : { origin }),
});

/** A case both CLIs run as this literal argv, the new one through Loom's parser. */
const argv = (line: string, extras: ArgvExtras = {}): ParityCase => {
  const named = argvLine(line, extras);
  return { ...named, name: `${named.name}${extras.bound === undefined ? '' : ' (bound)'}` };
};

const CASES: ParityCase[] = [
  // Bare: the clone's bound project.
  bind('bind (bound to MMR)', undefined, {}, 'MMR'),
  bind('bind (bound to MMR) -f records', undefined, { format: 'records' }, 'MMR'),
  bind('bind (bound to MMR) -f table', undefined, { format: 'table' }, 'MMR'),
  bind('bind (bound to MMR) -f ids', undefined, { format: 'ids' }, 'MMR'),
  bind('bind (bound to MMR) -f json', undefined, { format: 'json' }, 'MMR'),
  bind('bind (bound to MMR) -f jsonl', undefined, { format: 'jsonl' }, 'MMR'),
  // Bare on a clone that is bound to nothing fails, and its origin matches no project.
  bind('bind (unbound)', undefined),
  bind('bind (unbound) -f json', undefined, { format: 'json' }),
  bind('bind (unbound, origin matches nothing)', undefined, {}, undefined, STRANGER),
  // A clone whose origin names exactly one project binds itself.
  // Two projects share one origin, so the clone cannot choose.
  bind('bind (origin matches two projects)', undefined, {}, undefined, SHARED_ORIGIN),
  bind(
    'bind (origin matches two projects) -f json',
    undefined,
    { format: 'json' },
    undefined,
    SHARED_ORIGIN,
  ),
  bind('bind (origin matches MMR)', undefined, {}, undefined, MIMIR_ORIGIN),
  bind('bind (origin matches MMR) -f json', undefined, { format: 'json' }, undefined, MIMIR_ORIGIN),
  // Writing the binding.
  bind('bind MMR', 'MMR'),
  bind('bind MMR -f records', 'MMR', { format: 'records' }),
  bind('bind MMR -f table', 'MMR', { format: 'table' }),
  bind('bind MMR -f ids', 'MMR', { format: 'ids' }),
  bind('bind MMR -f json', 'MMR', { format: 'json' }),
  bind('bind MMR -f jsonl', 'MMR', { format: 'jsonl' }),
  bind('bind MMR (bound to XX)', 'MMR', {}, 'XX'),
  // The origin is recorded on a project that has none, and only then.
  bind('bind XX (origin)', 'XX', {}, undefined, STRANGER),
  bind('bind XX (origin) -f json', 'XX', { format: 'json' }, undefined, STRANGER),
  bind('bind XX (origin) -f ids', 'XX', { format: 'ids' }, undefined, STRANGER),
  bind('bind MMR (origin)', 'MMR', {}, undefined, STRANGER),
  // Refusals Mimir raises.
  bind('bind NOPE', 'NOPE'),
  bind('bind MMR-3', 'MMR-3'),
  bind('bind MMR-3 -f json', 'MMR-3', { format: 'json' }),
  // Faults Loom's parser raises.
  bind('bind MMR -f yaml', 'MMR', { format: 'yaml' }),
  bind('bind MMR --bogus', 'MMR', { bogus: true }),
  // Through Loom's parser, as a shell spells them.
  argv('bind MMR'),
  argv('bind MMR -f json'),
  argv('bind --format ids MMR'),
  argv('bind -f json', { bound: 'MMR' }),
  argv('bind -f json'),
  // Invocations the old CLI accepted and Loom's parser refuses.
  argv('bind MMR extra'),
  argv('bind MMR -f json -f ids'),
  // On a color terminal.
  argv('bind MMR', { tty: true }),
  argv('bind XX', { origin: STRANGER, tty: true }),
  argv('bind', { bound: 'MMR', tty: true }),
  // Misplaced flags, redirected as the old CLI redirected them.
  ...MACHINE_REDIRECTS.filter((line) => line.startsWith('bind ')).map((line) => argvLine(line)),
];

/** Two projects that record one origin, which a clone with that origin cannot choose between. */
async function sharedOriginProjects(board: ParityBoard): Promise<void> {
  for (const key of ['AA', 'BB']) {
    await board.engine.create({ key, name: key, remote: SHARED_ORIGIN, type: 'project' });
  }
}

// Binding records an origin on a project, so each CLI runs on its own board.
writeCases(import.meta.url, CASES, sharedOriginProjects);

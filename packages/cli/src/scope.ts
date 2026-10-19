/**
 * The one project a board read names: an explicit `-s KEY`, else the clone's
 * binding (ADR 0036). The Engine reads one board at a time, so `-s all` is
 * retired and an unbound clone with no `-s` is refused. A name not shaped like
 * a key is refused as the missing project it is, as the old CLI refused it,
 * rather than reaching the Engine's input schema.
 */
import { PROJECT_KEY_PATTERN, projectNotFound } from '@mimir/contract';

import { domainError, MimirUsageError } from './failures';
import type { Ports } from './ports';

/** The project `verb` reads; `notify` hears an auto-bind from the origin remote. */
export async function boardProject(
  ports: Ports,
  explicit: string | undefined,
  verb: string,
  notify: (line: string) => void,
): Promise<string> {
  if (explicit === 'all') {
    throw new MimirUsageError(
      `'-s all' is retired: ${verb} reads one project`,
      "name it with -s KEY; 'mimir projects' lists the keys",
    );
  }
  const key = explicit ?? (await ports.scope(notify));
  if (key === undefined) {
    throw new MimirUsageError(
      `${verb} needs a project`,
      "pass -s KEY, or bind this clone with 'mimir bind KEY'",
    );
  }
  if (!PROJECT_KEY_PATTERN.test(key)) {
    throw domainError(projectNotFound(key));
  }
  return key;
}

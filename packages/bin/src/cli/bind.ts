import type { Engine } from '@mimir/contract';
/**
 * The bare `mimir bind` check (ADR 0036): print the clone's project, resolving
 * it from the origin remote when git config has none, or fail as unbound.
 */
import { resolveBinding } from '@mimir/core';
import type { GitPort } from '@mimir/core';

import type { Format, Io } from '../presentation';

/** The retired checked-in binding file (ADR 0011); `bind` only notes that it is ignored. */
export const LEGACY_BINDING_FILE = '.mimir.toml';

/** Exit 0 printing the bound key, or exit 1 with `unbound: run mimir bind KEY`. */
export async function cmdBindCheck(
  engine: Pick<Engine, 'projectsByRemote'>,
  git: GitPort,
  format: Format,
  io: Io,
): Promise<number> {
  const found = await resolveBinding(engine, git, (line) => {
    io.error(line);
  });
  if (found.state === 'unbound') {
    const several =
      found.reason === 'ambiguous'
        ? ` (several projects match this origin: ${found.candidates.join(', ')})`
        : '';
    io.error(`unbound: run mimir bind KEY${several}`);
    return 1;
  }
  if (format === 'json' || format === 'jsonl') {
    io.write(JSON.stringify({ bound: { project: found.key, source: found.source } }));
  } else {
    io.write(found.key);
  }
  return 0;
}

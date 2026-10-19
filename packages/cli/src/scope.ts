/**
 * The one project a board read names: an explicit `-s KEY`, else the clone's
 * binding (ADR 0036). The Engine reads one board at a time, so `-s all` is
 * retired and an unbound clone with no `-s` is refused. A name not shaped like
 * a key is refused as the missing project it is, as the old CLI refused it,
 * rather than reaching the Engine's input schema. Writes name their project
 * the same way, through `boundProject` and `targetProject` below.
 */
import { PROJECT_KEY_PATTERN, projectNotFound } from '@mimir/contract';
import type { MimirError } from '@mimir/contract';

import { domainError, MimirUsageError } from './failures';
import type { Ports } from './ports';

/**
 * The clone's bound project, or the `-s` scope in its place. `-s all` names no
 * project, as in the old CLI, so a write that needs one refuses it.
 */
export async function boundProject(
  ports: Ports,
  scope: string | undefined,
  notify: (line: string) => void,
): Promise<string | undefined> {
  if (scope === 'all') {
    return undefined;
  }
  return scope ?? (await ports.scope(notify));
}

/**
 * The project a write targets: `target` when given, else `fallback`. A name not
 * shaped like a key is refused as the missing project it is, before the Engine
 * is asked, in `malformed`'s words.
 */
export function targetProject(
  target: string | undefined,
  fallback: string | undefined,
  missing: { message: string; hint: string },
  malformed: (key: string) => MimirError = projectNotFound,
): string {
  const key = target ?? fallback;
  if (key === undefined) {
    throw new MimirUsageError(missing.message, missing.hint);
  }
  if (!PROJECT_KEY_PATTERN.test(key)) {
    throw domainError(malformed(key));
  }
  return key;
}

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
  return targetProject(explicit ?? (await ports.scope(notify)), undefined, {
    hint: "pass -s KEY, or bind this clone with 'mimir bind KEY'",
    message: `${verb} needs a project`,
  });
}

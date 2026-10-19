/**
 * A parity case that both CLIs run as one literal argv, the new one through
 * Loom's parser. Its name is the argv as a shell would show it, so a
 * difference entry can name it. Test-only.
 */
import type { ParityCase } from './parity';

/** `word`, quoted when a shell would need it to be. */
const shown = (word: string): string => (/\s|^$/.test(word) ? JSON.stringify(word) : word);

/** The command groups whose second word names the subcommand a line runs. */
const GROUPS: ReadonlySet<string> = new Set(['create', 'scratch']);

/**
 * The case for `line` on a color terminal when `tty`. `path` names the command
 * the case runs when the line does not lead with it, as `-s MMR list` does,
 * it defaults to the line's first word, or to the group and subcommand when the
 * first word is a command group.
 */
export function argvCase(
  line: readonly string[],
  tty?: true,
  bound?: string,
  path?: readonly string[],
): ParityCase {
  const [first = '', second] = line;
  const grouped = GROUPS.has(first) && second !== undefined;
  const routed = path ?? (grouped ? [first, second] : [first]);
  const command = routed[0] ?? '';
  const rest = line[0] === command ? line.slice(1) : line;
  const words = rest.length === 0 ? '(no arguments)' : rest.map((word) => shown(word)).join(' ');
  return {
    argv: line,
    name: `${command} argv: ${words}${tty ? ' (terminal)' : ''}`,
    path: routed,
    ...(tty ? { tty } : {}),
    ...(bound === undefined ? {} : { bound }),
  };
}

/** The extras an argv case takes beyond its line. */
export type ArgvExtras = { tty?: true; bound?: string; path?: readonly string[] };

/** The case for a literal command line, split on spaces: `argvLine('list -s MMR -f ids')`. */
export function argvLine(line: string, extras: ArgvExtras = {}): ParityCase {
  return argvCase(line.split(' '), extras.tty, extras.bound, extras.path);
}

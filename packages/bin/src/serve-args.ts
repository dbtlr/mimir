/**
 * `serve`'s flags. Parsed strictly: an unknown or misspelled flag is a usage
 * fault, because a `--store` typo that fell through would serve the
 * installation's store instead of the file the operator named.
 */
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { parsePort } from '@mimir/helpers';

export type ServeArgs = {
  /** The bind port; absent leaves it to MIMIR_PORT, config, and the default. */
  port?: number;
  noHunt: boolean;
  /** A SQLite file to serve instead of the installation's store, resolved
   * against the working directory. */
  storeFile?: string;
};

const PORT_FAULT = '--port expects an integer in 1–65535';
const STORE_FAULT = '--store expects a SQLite store file';

/** Parse `serve`'s arguments, or name the usage fault. */
export function parseServeArgs(
  args: readonly string[],
): ServeArgs | { error: string; hint?: string } {
  let values: { port?: string; 'no-hunt'?: boolean; store?: string };
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        'no-hunt': { type: 'boolean' },
        port: { type: 'string' },
        store: { type: 'string' },
      },
      strict: true,
    }));
  } catch (error) {
    return usageFault(error);
  }
  const parsed: ServeArgs = { noHunt: values['no-hunt'] === true };
  if (values.port !== undefined) {
    const port = parsePort(values.port);
    if (port === null) {
      return { error: PORT_FAULT };
    }
    parsed.port = port;
  }
  if (values.store !== undefined) {
    if (values.store === '') {
      return { error: STORE_FAULT };
    }
    parsed.storeFile = resolve(values.store);
  }
  return parsed;
}

const HELP = "run 'mimir serve -h' for its flags";

/**
 * Re-voice a parseArgs failure (library text never ships; the shapes match the
 * CLI's own rewriter in cli/run.ts). A known flag missing its value gets that
 * flag's own message.
 */
function usageFault(error: unknown): { error: string; hint?: string } {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (/^Option '--store[ ']/.test(message)) {
    return { error: STORE_FAULT };
  }
  if (/^Option '--port[ ']/.test(message)) {
    return { error: PORT_FAULT };
  }
  const token = /'([^']+)'/.exec(message)?.[1] ?? '';
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    return { error: `unknown flag '${token}'`, hint: HELP };
  }
  if (code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') {
    return { error: `unexpected argument '${token}'`, hint: HELP };
  }
  if (/does not take an argument/.test(message)) {
    return { error: `'${token}' doesn't take a value`, hint: HELP };
  }
  return { error: 'invalid arguments', hint: HELP };
}

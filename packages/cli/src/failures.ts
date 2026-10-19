/**
 * Mimir's failures in Loom's failure shape `{code, exitCode, message, hints}`.
 * A domain refusal (`MimirError`) exits 1 with its code in kebab case, and a
 * usage error Mimir raises exits 2 with the code `usage`. A failure's hint is
 * its one hint line. Loom raises its own parser faults in its own voice.
 */
import { FatalError, plugin, translate, UnknownOptionError, UsageError } from '@loomcli/core';
import type { FailureHook, OptionNode, Plugin } from '@loomcli/core';
import { MimirError } from '@mimir/contract';
import type { ErrorCode } from '@mimir/contract';

import { flagRedirect } from './flag-owners';

/** A usage error Mimir raises: the invocation is wrong. Exit 2. */
export class MimirUsageError extends UsageError {
  static override readonly code: string = 'usage';
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'MimirUsageError';
    this.hint = hint;
  }
}

/** A domain refusal the Engine raised. Exit 1; each code is a subclass. */
export abstract class DomainError extends FatalError {
  readonly hint: string | undefined;

  constructor(error: MimirError) {
    super(error.message, { cause: error });
    this.name = 'DomainError';
    this.hint = error.hint;
  }
}

export class NotFoundError extends DomainError {
  static override readonly code: string = 'not-found';

  constructor(error: MimirError) {
    super(error);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends DomainError {
  static override readonly code: string = 'validation';

  constructor(error: MimirError) {
    super(error);
    this.name = 'ValidationError';
  }
}

export class ConflictError extends DomainError {
  static override readonly code: string = 'conflict';

  constructor(error: MimirError) {
    super(error);
    this.name = 'ConflictError';
  }
}

export class InvariantError extends DomainError {
  static override readonly code: string = 'invariant';

  constructor(error: MimirError) {
    super(error);
    this.name = 'InvariantError';
  }
}

const DOMAIN_ERRORS: Record<ErrorCode, new (error: MimirError) => DomainError> = {
  conflict: ConflictError,
  invariant: InvariantError,
  not_found: NotFoundError,
  validation: ValidationError,
};

/** The domain failure for a `MimirError`. */
export function domainError(error: MimirError): DomainError {
  return new DOMAIN_ERRORS[error.code](error);
}

/** Re-raise a core grammar refusal as the usage error it is, hint intact. */
export function asUsage(error: unknown): never {
  if (error instanceof MimirError) {
    throw new MimirUsageError(error.message, error.hint);
  }
  throw error;
}

/**
 * What a `create` that read its title as an option should do: the parser takes
 * `--weird-title` for a flag, and the `--` terminator ends the flags.
 */
export const DASH_TITLE_HINT =
  "a leading-dash title needs the '--' terminator: mimir create <type> [flags] -- <title>";

/**
 * Does the argv carry a positional after the `create` type word? Words without
 * `create` do not prove the title missing, so they read as given. A word after
 * `--` counts, and so does any bare word that is not the value of an option
 * that takes one. `options` are the options the failing command and the
 * application declare, which say which flags consume the next word.
 */
export function createTitleGiven(
  words: readonly string[],
  options: readonly OptionNode[],
): boolean {
  const typeAt = words.indexOf('create') + 2;
  if (typeAt < 2) {
    // The words do not hold the create path (a by-name call, an MCP server): the argv
    // does not prove the title missing, so there is no dash hint to give.
    return true;
  }
  const takesValue = (word: string): boolean =>
    options.some(
      (option) =>
        option.type !== 'boolean' &&
        option.type !== 'count' &&
        (word === option.long || word === option.short),
    );
  for (let at = typeAt; at < words.length; at++) {
    const word = words[at] ?? '';
    if (word === '--') {
      return at + 1 < words.length;
    }
    if (!word.startsWith('-')) {
      return true;
    }
    if (!word.includes('=') && takesValue(word)) {
      at++;
    }
  }
  return false;
}

/**
 * The hook for a failure: an unknown option under a `create` type whose title
 * never parsed is probably a title that leads with a dash, so point at the
 * `--` terminator (MMR-359). Any other misplaced or retired flag gets the old
 * CLI's redirect for it.
 */
function hintOf(argv: () => readonly string[]): FailureHook {
  return (failure, { command, graph, path, style }) => {
    if (failure instanceof UnknownOptionError) {
      if (
        path[0] === 'create' &&
        path.length === 2 &&
        !createTitleGiven(argv(), [...command.options, ...graph.globals])
      ) {
        return style.escape(DASH_TITLE_HINT);
      }
      const redirect = flagRedirect(failure.spelling, path[0]);
      return redirect === undefined ? undefined : style.escape(redirect);
    }
    return (failure instanceof DomainError || failure instanceof MimirUsageError) &&
      failure.hint !== undefined
      ? style.escape(failure.hint)
      : undefined;
  };
}

/**
 * Translates every `MimirError` a command lets through, and prints each failure's hint under it.
 * `argv` is the words of the run, which the leading-dash title hint reads.
 */
export function failures(argv: () => readonly string[] = () => process.argv.slice(2)): Plugin {
  return plugin('@mimir/cli/failures', {
    onFailure: hintOf(argv),
    translators: [translate(MimirError, domainError)],
  });
}

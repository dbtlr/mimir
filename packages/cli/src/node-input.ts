/**
 * The input rules the node-write commands share: how a typed id or flag value
 * becomes what the Engine takes. The Engine takes canonical ids and typed
 * values; deciding that a token names the wrong kind of record, or reading
 * `--upstream none` as a clear, is the client's job, and the refusals keep the
 * old CLI's words.
 */
import { MimirError, projectNotFound } from '@mimir/contract';

import { MimirUsageError } from './failures';
import type { Grammar } from './ports';

/** What a not-found refusal points at when the Engine named none. */
export const LIST_HINT = 'see what exists: mimir list -f ids';

/** What a refusal says when a seed id stands where a node id belongs. */
export const SEED_HINT = 'act on a seed with promote / reject / resolve';

/** Comma-separated ids or tags as a list, blanks dropped. */
export function splitCsv(csv: string): string[] {
  return csv
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token !== '');
}

/** A comma-separated id list as it reads in a note: `MMR-3, MMR-4`. */
export const idList = (csv: string): string => splitCsv(csv).join(', ');

/**
 * A token that must name a task, phase, or initiative. A project, artifact, or
 * seed id is a refusal that says what it names; a malformed or absent id is
 * left to the Engine, which answers that it does not exist.
 */
export function nodeToken(
  grammar: Grammar,
  token: string,
  expected = 'task, phase, or initiative',
): string {
  const kind = grammar.idKind(token);
  if (kind === 'project') {
    throw new MimirError('validation', `${token} is a project, not a ${expected}`);
  }
  if (kind === 'artifact') {
    throw new MimirError('validation', `${token} is an artifact, not a ${expected}`);
  }
  if (kind === 'seed') {
    throw new MimirError('validation', `${token} is a seed, not a ${expected}`, SEED_HINT);
  }
  return token;
}

/** A blank where an id belongs is a malformed invocation, not a lookup miss. */
export function requireIdToken(token: string, verb: string, flag: string): string {
  if (token.trim() === '') {
    throw new MimirUsageError(`${verb} --${flag} expects an id (KEY-seq)`);
  }
  return token;
}

/**
 * Run an Engine write whose ids were typed by the caller. A not-found refusal
 * that names one of `tokens` and carries no hint gains the list hint, so the
 * caller learns where to look.
 */
export async function withListHint<T>(
  tokens: readonly string[],
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof MimirError &&
      error.code === 'not_found' &&
      error.hint === undefined &&
      tokens.some((token) => error.message === `${token} doesn't exist`)
    ) {
      throw new MimirError('not_found', error.message, LIST_HINT);
    }
    throw error;
  }
}

/** Run an Engine write on a project the caller named; one that is not there gains the create hint. */
export async function withProjectHint<T>(key: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof MimirError &&
      error.code === 'not_found' &&
      error.hint === undefined &&
      error.message === `${key} doesn't exist`
    ) {
      throw projectNotFound(key);
    }
    throw error;
  }
}

/** The clear sentinel `--upstream` takes. */
const UPSTREAM_CLEAR = 'none';

/**
 * `--upstream KEY-sN` or `--upstream none`: a seed id, `null` to clear, or
 * `undefined` to leave it alone. Anything else is a usage error.
 */
export function parseUpstream(
  grammar: Grammar,
  raw: string | undefined,
): string | null | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === UPSTREAM_CLEAR) {
    return null;
  }
  if (grammar.idKind(raw) === 'seed') {
    return raw;
  }
  throw new MimirUsageError(
    `--upstream expects a seed id (KEY-sN) or '${UPSTREAM_CLEAR}' to clear, got ${raw}`,
  );
}

/** The tri-state of a converse flag pair such as `--open-ended` and `--not-open-ended`. */
export function flagPair(
  on: boolean | undefined,
  off: boolean | undefined,
  usage: string,
): boolean | undefined {
  if (on === true && off === true) {
    throw new MimirUsageError(usage);
  }
  if (on === true) {
    return true;
  }
  return off === true ? false : undefined;
}

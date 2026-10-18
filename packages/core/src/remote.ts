import { validation } from './errors';

/**
 * `git@host:path` — the scp-like form Git accepts for ssh remotes. The host must
 * carry a dot or a `user@`, so `foo:bar` and a Windows `C:\\path` are not remotes.
 */
const SCP_LIKE = /^(?:([^@/\s]+)@)?([^:/\s\\]+):(?!\/\/)(.+)$/;
/** `scheme://[userinfo@]host[:port]/path`. */
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?([^:/\s]+)(?::\d+)?\/(.+)$/i;

/** Drop trailing slashes and a `.git` suffix (any case) until neither remains. */
function stripSuffixes(path: string | undefined): string | undefined {
  let current = path;
  while (current !== undefined) {
    const next = current.replace(/\/+$/, '').replace(/\.git$/i, '');
    if (next === current) {
      return current;
    }
    current = next;
  }
  return current;
}

/**
 * Reduce a Git remote URL to the identity of its repository: `host/path`, with
 * the scheme, credentials, and port dropped, the host lowercased, and a trailing
 * `/` or `.git` removed. The ssh and https forms of one repository compare equal.
 * The path keeps its case, since hosting paths can be case-sensitive. Anything
 * that is not a recognizable remote is refused.
 */
export function normalizeRemote(raw: string): string {
  const text = raw.trim();
  const url = URL_LIKE.exec(text);
  const scp = url === null ? SCP_LIKE.exec(text) : null;
  const scpHostOk = scp !== null && (scp[1] !== undefined || (scp[2] ?? '').includes('.'));
  const host = (url?.[1] ?? (scpHostOk ? scp[2] : undefined))?.toLowerCase();
  const path = stripSuffixes((url?.[2] ?? (scpHostOk ? scp[3] : undefined))?.replace(/^\/+/, ''));
  if (host === undefined || path === undefined || path === '' || /[?#]/.test(path)) {
    throw validation(
      `not a Git remote: ${JSON.stringify(raw)}`,
      'use the clone URL, such as git@github.com:owner/repo.git or https://github.com/owner/repo',
    );
  }
  return `${host}/${path}`;
}

/** `normalizeRemote`, or `undefined` when `raw` is not a recognizable network remote. */
export function tryNormalizeRemote(raw: string): string | undefined {
  try {
    return normalizeRemote(raw);
  } catch {
    return undefined;
  }
}

/** The `host/path` form `normalizeRemote` produces, with no scheme, credentials, or port. */
const STORED_FORM = /^[^\s:@/?#\\]+\/[^\s?#]*[^\s?#/]$/;

/**
 * Normalize a remote read back from an export: an already-normalized `host/path`
 * is kept, anything else is normalized as a written remote. Refused when it is
 * not a remote.
 */
export function normalizeStoredRemote(raw: string): string {
  const text = raw.trim();
  return STORED_FORM.test(text) && !/\.git$/i.test(text) ? text : normalizeRemote(text);
}

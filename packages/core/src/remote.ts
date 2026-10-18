import { validation } from './errors';

/** `git@host:path` — the scp-like form Git accepts for ssh remotes. */
const SCP_LIKE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/;
/** `scheme://[userinfo@]host[:port]/path`. */
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?([^:/\s]+)(?::\d+)?\/(.+)$/i;

/**
 * Reduce a Git remote URL to the identity of its repository: `host/path`, with
 * the scheme, credentials, and port dropped, the host lowercased, and a trailing
 * `/` or `.git` removed. The ssh and https forms of one repository compare equal.
 * The path keeps its case, since hosting paths can be case-sensitive. Anything
 * that is not a recognizable remote is refused.
 */
export function normalizeRemote(raw: string): string {
  const text = raw.trim();
  const match = URL_LIKE.exec(text) ?? SCP_LIKE.exec(text);
  const host = match?.[1]?.toLowerCase();
  const path = match?.[2]
    ?.replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/^\/+/, '');
  if (host === undefined || path === undefined || path === '') {
    throw validation(
      `not a Git remote: ${JSON.stringify(raw)}`,
      'use the clone URL, such as git@github.com:owner/repo.git or https://github.com/owner/repo',
    );
  }
  return `${host}/${path}`;
}

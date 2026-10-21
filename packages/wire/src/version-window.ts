import { MIN_CLIENT } from '@mimir/contract';
import { lt, parse } from 'semver';

/**
 * Where a client build sits against a host's version window (ADR 0038):
 * `below-minimum` means update the CLI; `above-host` means update the host
 * first; `malformed` means a version could not be read as SemVer, so the
 * window cannot be judged (the client's, the host's, or the host's minimum)
 * and the client counts as outside it.
 */
export type WindowVerdict = 'inside' | 'malformed' | 'below-minimum' | 'above-host';

/**
 * The one version-window rule, shared by the host's version middleware and a
 * client that checks `/health` before it pairs. The lower bound is a full
 * SemVer comparison against `minClient`. The upper bound compares major and
 * minor only, so a prerelease of the host's own minor is inside the window.
 */
export function versionWindow(
  clientVersion: string,
  hostVersion: string,
  minClient: string = MIN_CLIENT,
): WindowVerdict {
  const client = parse(clientVersion);
  const host = parse(hostVersion);
  const minimum = parse(minClient);
  if (!client || !host || !minimum) {
    return 'malformed';
  }
  if (lt(client, minimum)) {
    return 'below-minimum';
  }
  return client.major > host.major || (client.major === host.major && client.minor > host.minor)
    ? 'above-host'
    : 'inside';
}

/**
 * The config-file permission check. `[store] url` can carry Postgres
 * credentials, and `writeConfig` writes the file 0600, so the gap this closes is
 * the hand-edited or copied config that kept a looser mode. It is an install
 * check, not a record check: it reads the config file, not the store, so it sits
 * beside the backend contract and is composed onto a backend's diagnosis rather
 * than implemented by each backend. A warning, never an error (ADR 0017).
 */
import { configFileMode, readConfig } from '../service/config';
import { findingLine } from './commands';
import type { DoctorDiagnosis, DoctorFinding } from './contract';

/** Group-read and other-read bits; the permission the credential file must not grant. */
const GROUP_OR_WORLD_READ = 0o044;

/** The scope word store-level findings carry; no project key can be this. */
const STORE_SCOPE = 'store';

/** The file's permission bits as a four-digit octal string, e.g. `0644`. */
function modeString(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, '0');
}

/**
 * Warn when `file` carries `[store] url` but grants group or world read. Silent
 * for an absent or unparseable file, a file with no url, and an owner-only file.
 * The message names the path and the fix and never echoes the url.
 */
export function checkConfigPermissions(file: string): DoctorFinding[] {
  const mode = configFileMode(file);
  if (
    mode === undefined ||
    (mode & GROUP_OR_WORLD_READ) === 0 ||
    readConfig(file).store.url === undefined
  ) {
    return [];
  }
  const shown = modeString(mode);
  return [
    {
      check: 'config-permissions',
      code: 'config-readable',
      evidence: { mode: shown },
      locator: file,
      message: `the config file carries [store] url but is readable by group or others (mode ${shown}) — run 'chmod 600 ${file}'`,
      node: 'config',
      scopeKey: STORE_SCOPE,
      severity: 'warn',
      stem: 'config',
      where: 'config · mode',
    },
  ];
}

/**
 * Add the config-file findings to a backend's diagnosis. A project scope
 * excludes them, as it does every store-level finding: the config file belongs
 * to the install, not to a project.
 */
export function withConfigFindings(
  diagnosis: DoctorDiagnosis,
  scope: string | undefined,
  file: string,
): DoctorDiagnosis {
  if (scope !== undefined && scope !== '') {
    return diagnosis;
  }
  return { ...diagnosis, findings: [...diagnosis.findings, ...checkConfigPermissions(file)] };
}

/**
 * Print the config-file warnings straight to a line writer. The check reads only
 * the config file, so it can run where the store never answers: before a repair
 * pass, and when the backend throws (unreachable database, bad credentials) —
 * the cases `withConfigFindings` cannot reach because there is no diagnosis to
 * append to. A project scope excludes them, as it does in `withConfigFindings`.
 */
export function warnConfigPermissions(
  scope: string | undefined,
  file: string,
  write: (line: string) => void,
): void {
  if (scope !== undefined && scope !== '') {
    return;
  }
  for (const finding of checkConfigPermissions(file)) {
    write(findingLine(finding));
  }
}

/**
 * The config-file permission check. `[store] url` can carry Postgres
 * credentials, and the file decides which store every command opens, so it must
 * be neither readable nor writable by group or others. `writeConfig` writes it
 * 0600; the gap this closes is the hand-edited or copied config that kept a
 * looser mode. It is an install
 * check, not a record check: it reads the config file, not the store, so it sits
 * beside the backend contract and is composed onto a backend's diagnosis rather
 * than implemented by each backend. A warning, never an error (ADR 0017).
 */
import { configFileMode, readConfig } from '../service/config';
import { findingLine } from './commands';
import type { DoctorDiagnosis, DoctorFinding } from './contract';

/** Group-read and other-read bits; the permission the credential file must not grant. */
const GROUP_OR_WORLD_READ = 0o044;

/** Group-write and other-write bits; a writer could point `[store] url` at its own database. */
const GROUP_OR_WORLD_WRITE = 0o022;

/** The scope word store-level findings carry; no project key can be this. */
const STORE_SCOPE = 'store';

/** The file's permission bits as a four-digit octal string, e.g. `0644`. */
function modeString(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, '0');
}

/** One config-permission warning for `file`; every one names the same fix. */
function configFinding(file: string, code: string, shown: string, risk: string): DoctorFinding {
  return {
    check: 'config-permissions',
    code,
    evidence: { mode: shown },
    locator: file,
    message: `${risk} (mode ${shown}) — run 'chmod 600 ${file}'`,
    node: 'config',
    scopeKey: STORE_SCOPE,
    severity: 'warn',
    stem: 'config',
    where: 'config · mode',
  };
}

/**
 * Warn when `file` carries `[store] url` but grants group or world read, and
 * when it grants group or world write at all: a writer can add a url, so the
 * write warning does not wait for one. Silent for an absent file and an
 * owner-only file. The messages name the path and the fix and never echo the url.
 */
export function checkConfigPermissions(file: string): DoctorFinding[] {
  const mode = configFileMode(file);
  if (mode === undefined) {
    return [];
  }
  const shown = modeString(mode);
  const findings: DoctorFinding[] = [];
  if ((mode & GROUP_OR_WORLD_READ) !== 0 && readConfig(file).store.url !== undefined) {
    findings.push(
      configFinding(
        file,
        'config-readable',
        shown,
        'the config file carries [store] url but is readable by group or others',
      ),
    );
  }
  if ((mode & GROUP_OR_WORLD_WRITE) !== 0) {
    findings.push(
      configFinding(
        file,
        'config-writable',
        shown,
        'the config file is writable by group or others, who could redirect the store',
      ),
    );
  }
  return findings;
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

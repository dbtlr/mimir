/**
 * The config-file permission check. `[store] url` can carry Postgres
 * credentials, and the file decides which store every command opens, so it must
 * be neither readable nor writable by group or others. `writeConfig` writes it
 * 0600; the gap this closes is the hand-edited or copied config that kept a
 * looser mode. Mode bits alone are not enough: whoever owns the file, or can
 * rename entries in a directory above it, can swap in a config of their own, so
 * the check also walks the path's owners and directory modes. It is an install
 * check, not a record check: it reads the config file, not the store, so it sits
 * beside the backend contract and is composed onto a backend's diagnosis rather
 * than implemented by each backend. A warning, never an error (ADR 0017).
 */
import type { ConfigPathStat } from '../service/config';
import { configFileMode, configPathStats, readConfig } from '../service/config';
import { findingLine } from './commands';
import type { DoctorBackend, DoctorDiagnosis, DoctorFinding } from './contract';
import { isUnscoped } from './contract';
import { withFindings } from './facet';

/** Group-read and other-read bits; the permission the credential file must not grant. */
const GROUP_OR_WORLD_READ = 0o044;

/** Group-write and other-write bits; a writer could point `[store] url` at its own database. */
const GROUP_OR_WORLD_WRITE = 0o022;

/** The sticky bit: in a writable directory, only an entry's owner may rename or remove it. */
const STICKY = 0o1000;

/** The owner every path may have besides the current user; root can rewrite anything anyway. */
const ROOT_UID = 0;

/** The scope word store-level findings carry; no project key can be this. */
const STORE_SCOPE = 'store';

/** The closed code vocabulary of the config check. */
type ConfigCode =
  | 'config-dir-writable'
  | 'config-foreign-owner'
  | 'config-readable'
  | 'config-writable';

/** The plain-language cause chip the record-health panel shows per code. */
const CAUSES = {
  'config-dir-writable': 'writable config directory',
  'config-foreign-owner': 'foreign config owner',
  'config-readable': 'readable config',
  'config-writable': 'writable config',
} satisfies Record<ConfigCode, string>;

/** Permission bits, sticky bit included, as a four-digit octal string, e.g. `0644` or `1777`. */
function modeString(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, '0');
}

/** One config-permission warning about `path`; `message` names the risk and the fix. */
function configFinding(
  path: string,
  code: ConfigCode,
  field: 'mode' | 'owner',
  evidence: Record<string, unknown>,
  message: string,
): DoctorFinding {
  return {
    check: 'config-permissions',
    code,
    evidence,
    locator: path,
    message,
    node: 'config',
    scopeKey: STORE_SCOPE,
    severity: 'warn',
    stem: 'config',
    where: `config · ${field}`,
  };
}

/** A warning about the config file's own mode; every one names `chmod 600`. */
function fileModeFinding(
  file: string,
  code: ConfigCode,
  shown: string,
  risk: string,
): DoctorFinding {
  return configFinding(
    file,
    code,
    'mode',
    { mode: shown },
    `${risk} (mode ${shown}) — run 'chmod 600 ${file}'`,
  );
}

/**
 * Warn about each path in `stats` (the config file, then the directories above
 * it) that lets someone other than user `uid` replace the config: a directory
 * group- or world-writable without the sticky bit, or a file or directory owned
 * by anyone but `uid` or root. The file's own mode is left to the read and
 * write checks. Silent without a POSIX `uid`, since there are no owners to compare.
 */
export function checkConfigReplaceable(
  stats: readonly ConfigPathStat[],
  uid: number | undefined,
): DoctorFinding[] {
  if (uid === undefined) {
    return [];
  }
  const findings: DoctorFinding[] = [];
  for (const { isDirectory, mode, path, uid: owner } of stats) {
    if (isDirectory && (mode & GROUP_OR_WORLD_WRITE) !== 0 && (mode & STICKY) === 0) {
      const shown = modeString(mode);
      findings.push(
        configFinding(
          path,
          'config-dir-writable',
          'mode',
          { mode: shown },
          `the directory ${path} is writable by group or others, who could replace the config (mode ${shown}) — run 'chmod go-w ${path}'`,
        ),
      );
    }
    if (owner !== uid && owner !== ROOT_UID) {
      findings.push(
        configFinding(
          path,
          'config-foreign-owner',
          'owner',
          { owner },
          `${path} is owned by uid ${owner}, who could replace the config — keep the config on a path owned only by you or root`,
        ),
      );
    }
  }
  return findings;
}

/** Where the replaceability walk stops and whose ownership it trusts; tests pin both. */
export type ConfigTrust = { home?: string; uid?: number };

/**
 * Warn when `file` carries `[store] url` but grants group or world read, and
 * when it grants group or world write at all: a writer can add a url, so the
 * write warning does not wait for one. Then warn on any owner or directory
 * that lets another user replace the file ({@link checkConfigReplaceable}).
 * Silent for an absent file and an owner-only file on a private path. The
 * messages name the path and the fix and never echo the url.
 */
export function checkConfigPermissions(file: string, trust: ConfigTrust = {}): DoctorFinding[] {
  const mode = configFileMode(file);
  if (mode === undefined) {
    return [];
  }
  const shown = modeString(mode);
  const findings: DoctorFinding[] = [];
  if ((mode & GROUP_OR_WORLD_READ) !== 0 && readConfig(file).store.url !== undefined) {
    findings.push(
      fileModeFinding(
        file,
        'config-readable',
        shown,
        'the config file carries [store] url but is readable by group or others',
      ),
    );
  }
  if ((mode & GROUP_OR_WORLD_WRITE) !== 0) {
    findings.push(
      fileModeFinding(
        file,
        'config-writable',
        shown,
        'the config file is writable by group or others, who could redirect the store',
      ),
    );
  }
  const stats = configPathStats(file, trust.home);
  findings.push(...checkConfigReplaceable(stats, trust.uid ?? process.getuid?.()));
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
  if (!isUnscoped(scope)) {
    return diagnosis;
  }
  return { ...diagnosis, findings: [...diagnosis.findings, ...checkConfigPermissions(file)] };
}

/**
 * The store backend's doctor with the config-file findings composed onto both
 * of its answers, so the CLI's report and the console's facet carry the same
 * warnings. A project scope excludes them from each, as `withConfigFindings` does.
 */
export function withConfigDoctor(backend: DoctorBackend, file: string): DoctorBackend {
  return {
    diagnose: async (scope) => withConfigFindings(await backend.diagnose(scope), scope, file),
    facet: async (scope) => {
      const facet = await backend.facet(scope);
      return isUnscoped(scope) ? withFindings(facet, checkConfigPermissions(file), CAUSES) : facet;
    },
  };
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
  if (!isUnscoped(scope)) {
    return;
  }
  for (const finding of checkConfigPermissions(file)) {
    write(findingLine(finding));
  }
}

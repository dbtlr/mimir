import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

import { requireInstallationProtocol } from './protocol';
import { adoptionPaths, readScriptInstallation } from './script-record';
import type { ScriptInstallation } from './script-record';

export type InstallationPaths = { config: string; data: string; cache: string };
type Binding = { mode: 'live' } | { mode: 'sandbox'; sandboxAuthority: string };
export type RegistrationOptions = { executable: string; paths: InstallationPaths } & Binding;
export type Installation = RegistrationOptions & { version: 1; sha256: string };

const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const receiptPath = (executable: string) => `${executable}.installation.json`;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function absolute(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value);
}
function parseReceipt(value: unknown): Installation {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !absolute(value.executable) ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !isRecord(value.paths)
  ) {
    throw new Error('Invalid installation receipt. Reinstall Mimir explicitly.');
  }
  const { cache, config, data } = value.paths;
  if (!absolute(config) || !absolute(data) || !absolute(cache)) {
    throw new Error('Installation paths must be absolute.');
  }
  const common = {
    executable: value.executable,
    paths: { cache, config, data },
    sha256: value.sha256,
    version: 1 as const,
  };
  if (value.mode === 'live' && value.sandboxAuthority === undefined) {
    return { ...common, mode: 'live' };
  }
  if (value.mode === 'sandbox' && absolute(value.sandboxAuthority)) {
    return { ...common, mode: 'sandbox', sandboxAuthority: value.sandboxAuthority };
  }
  throw new Error('Invalid installation authority.');
}

/**
 * What Loom's installation record says for this run: the script installation
 * it holds, and the live directories an adoption binds, resolved only if one
 * is due. `livePaths` returns `undefined` when this run must not adopt.
 */
export type ScriptVouch = {
  installation: ScriptInstallation;
  livePaths: () => InstallationPaths | undefined;
};

/** Whether the script installation names this executable and its bytes as they are. */
function vouches(
  vouch: ScriptVouch | undefined,
  canonical: string,
  sha256: () => string,
): vouch is ScriptVouch {
  if (vouch === undefined) {
    return false;
  }
  try {
    // The path check comes first so a binary the record does not name is never hashed.
    return (
      realpathSync(vouch.installation.path) === canonical && vouch.installation.sha256 === sha256()
    );
  } catch {
    return false;
  }
}

/**
 * Verify the receipt before any installation-bound state is read. A script
 * installation Loom's record vouches for (ADR 0031, refinement MMR-554) stands
 * in for Mimir's installer: with no receipt it is adopted as live, binding the
 * directories the vouch grants now (none, so no receipt, when it refuses), and
 * a receipt whose digest it supersedes is re-recorded with its bindings kept.
 * Anything else that does not match fails closed.
 */
export function readInstallationAt(
  executable: string,
  vouch?: ScriptVouch,
): Installation | undefined {
  const canonical = realpathSync(executable);
  const file = receiptPath(canonical);
  if (!existsSync(file)) {
    // An unregistered run with no script record hashes nothing.
    if (!vouches(vouch, canonical, () => digest(canonical))) {
      return undefined;
    }
    const paths = vouch.livePaths();
    return paths && registerInstallation({ executable: canonical, mode: 'live', paths });
  }
  const value = parseReceipt(JSON.parse(readFileSync(file, 'utf8')));
  const sha256 = digest(canonical);
  if (value.executable === canonical && value.sha256 === sha256) {
    return value;
  }
  if (value.executable === canonical && vouches(vouch, canonical, () => sha256)) {
    return registerInstallation(value);
  }
  throw new Error(
    'Installation executable does not match its receipt. Reinstall Mimir explicitly.',
  );
}

/** This process's installation, read once: `env.ts` and Postgres access both ask. */
let processInstallation: { installation: Installation | undefined } | undefined;

/**
 * Source interpreters cannot acquire installation authority from a receipt.
 * The read happens once per process, so an adoption's or a refusal's stderr
 * line prints once however many callers ask.
 */
export function readInstallation(): Installation | undefined {
  if (
    !import.meta.url.startsWith('file:///$bunfs/') &&
    !import.meta.url.startsWith('file:///~BUN/')
  ) {
    return undefined;
  }
  processInstallation ??= {
    installation: readInstallationAt(process.execPath, scriptVouch(process.env, process.platform)),
  };
  return processInstallation.installation;
}

/**
 * Loom's record vouches only outside a sandbox or test run, and adopts only
 * the `$HOME` default directories: an adoption anywhere else could bind the
 * real installation to throwaway directories for good, so it is refused. Both
 * an adoption and a refusal say so on stderr.
 */
export function scriptVouch(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  stderr: (line: string) => void = (line) => process.stderr.write(line),
): ScriptVouch | undefined {
  if (env.MIMIR_SANDBOX_AUTHORITY !== undefined || env.MIMIR_TEST_POSTGRES_URL !== undefined) {
    return undefined;
  }
  const installation = readScriptInstallation(env, platform);
  return (
    installation && {
      installation,
      livePaths: () => {
        const adoption = adoptionPaths(env, platform);
        if ('refusal' in adoption) {
          stderr(
            `mimir: Loom's installation record names this binary, but this run does not adopt it as live: ${adoption.refusal}. ${adoption.remedy}. Until then it uses the development directories beside it.\n`,
          );
          return undefined;
        }
        const { paths } = adoption;
        stderr(
          `mimir: adopted this installation as live, binding config ${paths.config}, data ${paths.data}, cache ${paths.cache}.\n`,
        );
        return paths;
      },
    }
  );
}

/** Registration is an explicit installer action; builds never call it. */
export function registerInstallation(options: RegistrationOptions): Installation {
  const executable = realpathSync(options.executable);
  const receipt = parseReceipt({ ...options, executable, sha256: digest(executable), version: 1 });
  const target = receiptPath(executable);
  const staging = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(staging, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(staging, target);
  } finally {
    rmSync(staging, { force: true });
  }
  return receipt;
}

/** Upgrades retain validated bindings; an interrupted swap fails closed. */
export function installBinary(options: {
  source: string;
  target: string;
  registration: Omit<RegistrationOptions, 'executable'> & Binding;
}): Installation {
  const previous = existsSync(options.target) ? readInstallationAt(options.target) : undefined;
  const target = existsSync(options.target) ? realpathSync(options.target) : options.target;
  if (!isAbsolute(target)) {
    throw new Error('Installation target must be absolute.');
  }
  const bindings =
    previous ??
    parseReceipt({
      ...options.registration,
      executable: target,
      sha256: digest(options.source),
      version: 1,
    });
  mkdirSync(dirname(target), { recursive: true });
  const staging = `${target}.${randomUUID()}.install`;
  try {
    copyFileSync(options.source, staging);
    chmodSync(staging, 0o755);
    requireInstallationProtocol(staging);
    renameSync(staging, target);
    return registerInstallation({ ...bindings, executable: target });
  } finally {
    rmSync(staging, { force: true });
  }
}

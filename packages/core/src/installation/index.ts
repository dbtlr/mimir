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

/** Verify the receipt before any installation-bound state is read. */
export function readInstallationAt(executable: string): Installation | undefined {
  const canonical = realpathSync(executable);
  const file = receiptPath(canonical);
  if (!existsSync(file)) {
    return undefined;
  }
  const value = parseReceipt(JSON.parse(readFileSync(file, 'utf8')));
  if (value.executable !== canonical || value.sha256 !== digest(canonical)) {
    throw new Error(
      'Installation executable does not match its receipt. Reinstall Mimir explicitly.',
    );
  }
  return value;
}

/** Source interpreters cannot acquire installation authority from a receipt. */
export function readInstallation(): Installation | undefined {
  if (
    !import.meta.url.startsWith('file:///$bunfs/') &&
    !import.meta.url.startsWith('file:///~BUN/')
  ) {
    return undefined;
  }
  return readInstallationAt(process.execPath);
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

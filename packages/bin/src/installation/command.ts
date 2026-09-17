import { installBinary } from './index';

/** The staged candidate installs without reading any runtime configuration. */
export function runInstallationCommand(args: string[]): void {
  if (
    !import.meta.url.startsWith('file:///$bunfs/') &&
    !import.meta.url.startsWith('file:///~BUN/')
  ) {
    throw new Error('installation-install requires a compiled candidate.');
  }
  const values = new Map<string, string>();
  const allowed = new Set([
    '--target',
    '--mode',
    '--config',
    '--data',
    '--cache',
    '--sandbox-authority',
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      key === undefined ||
      !allowed.has(key) ||
      values.has(key) ||
      value === undefined ||
      value.startsWith('--')
    ) {
      throw new Error(
        'installation-install expects unique --target, --mode, --config, --data, --cache options.',
      );
    }
    values.set(key, value);
  }
  const target = values.get('--target');
  const config = values.get('--config');
  const data = values.get('--data');
  const cache = values.get('--cache');
  const mode = values.get('--mode');
  if (target === undefined || config === undefined || data === undefined || cache === undefined) {
    throw new Error('Installation target and all three paths are required.');
  }
  const paths = { cache, config, data };
  if (mode === 'live' && !values.has('--sandbox-authority')) {
    installBinary({ registration: { mode, paths }, source: process.execPath, target });
  } else if (mode === 'sandbox') {
    const sandboxAuthority = values.get('--sandbox-authority');
    if (sandboxAuthority === undefined) {
      throw new Error('Sandbox installation requires --sandbox-authority.');
    }
    installBinary({
      registration: { mode, paths, sandboxAuthority },
      source: process.execPath,
      target,
    });
  } else {
    throw new Error('Installation mode must be live or sandbox.');
  }
}

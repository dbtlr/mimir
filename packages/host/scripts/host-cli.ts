import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const entry = fileURLToPath(new URL('../src/admin/main.ts', import.meta.url));
const run = promisify(execFile);

/**
 * Run `mimir-host` from source against a development or fixture host, as an
 * operator runs it in the image, and answer its stdout. `env` names the host's
 * store the way the host reads it; no `MIMIR_*` variable of the calling shell
 * leaks in, so a sandbox's Postgres URL never redirects the fixture.
 */
export async function runHostCli(args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('MIMIR_')),
  );
  try {
    return (await run('bun', [entry, ...args], { env: { ...inherited, ...env } })).stdout;
  } catch (error) {
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error ? error.stderr : '';
    throw new Error(`mimir-host ${args.join(' ')} failed: ${String(stderr)}`, { cause: error });
  }
}

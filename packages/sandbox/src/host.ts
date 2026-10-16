import { join } from 'node:path';

import type { DatabaseSandboxAuthority } from '../../core/src/sandbox-authority';
import { parsePort, PROD_PORT } from '../../helpers/src/ports';
import { InterruptedError, isolatedEnvironment } from './process';

export function hostEnvironment(
  authority: DatabaseSandboxAuthority,
  port?: string,
): NodeJS.ProcessEnv {
  hostPort(port);
  return {
    ...isolatedEnvironment(),
    MIMIR_DATABASE_URL: authority.postgresUrl,
    MIMIR_PORT: port,
    MIMIR_SANDBOX_AUTHORITY: join(authority.root, 'authority.json'),
  };
}

export function hostPort(port?: string): string {
  if (port !== undefined && parsePort(port) === null) {
    throw new Error('--port must be an integer from 1 to 65535');
  }
  return port ?? String(PROD_PORT);
}

export async function launchHost(
  repository: string,
  authority: DatabaseSandboxAuthority,
  options: { port?: string; signal?: AbortSignal; timeout?: number } = {},
): Promise<void> {
  const env = hostEnvironment(authority, options.port);
  const child = Bun.spawn(
    [
      process.execPath,
      'run',
      'dev',
      '--host',
      '127.0.0.1',
      '--port',
      hostPort(options.port),
      '--strictPort',
    ],
    {
      cwd: join(repository, 'packages', 'host'),
      detached: true,
      env,
      stderr: 'inherit',
      stdin: 'inherit',
      stdout: 'inherit',
    },
  );
  let interrupted = false;
  let timedOut = false;
  const kill = () => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  };
  const stop = () => {
    interrupted = true;
    kill();
  };
  const timer = setTimeout(
    () => {
      timedOut = true;
      kill();
    },
    options.timeout ?? 12 * 60 * 60 * 1000,
  );
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted === true) {
    stop();
  }
  try {
    const exit = await child.exited;
    if (interrupted) {
      throw new InterruptedError('Sandbox host interrupted; the sandbox remains available.');
    }
    if (timedOut) {
      throw new Error('Sandbox host session timed out; the sandbox remains available.');
    }
    if (exit !== 0) {
      throw new Error(`Sandbox host failed (${String(exit)}).`);
    }
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    options.signal?.removeEventListener('abort', stop);
    kill();
  }
}

/**
 * The sandbox tooling's process and file edges, shared by every workflow:
 * bounded subprocesses with explicit environments and checked exit status
 * (ADR 0031), and private, atomically written records.
 */
import { createHash, randomUUID } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of Bun.file(path).stream()) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export async function privateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/** The caller's environment without database or Mimir overrides, with the
 *  workspace Bun first on PATH. */
export function isolatedEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('PG') || key.startsWith('MIMIR_')) {
      delete environment[key];
    }
  }
  environment.PATH = `${dirname(process.execPath)}:${environment.PATH ?? ''}`;
  return environment;
}

export class InterruptedError extends Error {
  override name = 'InterruptedError';
}

/** A command whose failure is expected (best-effort teardown, probes): stdout, or undefined. */
export async function attempt(args: string[], cwd: string): Promise<string | undefined> {
  try {
    return await command(args, { cwd, timeout: 60_000 });
  } catch {
    return undefined;
  }
}

export type Captured = { stdout: string; stderr: string; exit: number };

type SpawnOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  inputFile?: string;
  timeout?: number;
  /** Kill the child when this aborts; the call then rejects as interrupted. */
  signal?: AbortSignal;
};

/** A bounded subprocess whose exit status is the caller's to judge. */
export async function capture(args: string[], options: SpawnOptions): Promise<Captured> {
  const child = Bun.spawn(args, {
    cwd: options.cwd,
    env: options.env ?? isolatedEnvironment(),
    stderr: 'pipe',
    stdin: options.inputFile ? Bun.file(options.inputFile) : 'ignore',
    stdout: 'pipe',
  });
  let interrupted = false;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, options.timeout ?? 120_000);
  const stop = () => {
    interrupted = true;
    child.kill('SIGKILL');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted === true) {
    stop();
  }
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (interrupted) {
      throw new InterruptedError(
        'Sandbox operation interrupted; owned resources retained for cleanup.',
      );
    }
    if (timedOut) {
      throw new Error(`Sandbox subprocess timed out: ${args[0]}`);
    }
    return { exit, stderr, stdout };
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    options.signal?.removeEventListener('abort', stop);
  }
}

export async function command(args: string[], options: SpawnOptions): Promise<string> {
  const { exit, stderr, stdout } = await capture(args, options);
  if (exit !== 0) {
    throw new Error(
      `${args[0]} failed (${exit}): ${stderr.replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[database URL redacted]').slice(-4000)}`,
    );
  }
  return stdout.trim();
}

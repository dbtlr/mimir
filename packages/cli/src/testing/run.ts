/**
 * Run an Application on argv with a captured host, as a terminal or a pipe.
 * Test-only.
 */
import { isAbsolute } from 'node:path';
import { PassThrough } from 'node:stream';

import { processHandle } from '@loomcli/core';
import type { Application } from '@loomcli/core';

export type ArgvRun = { exitCode: number; stdout: string; stderr: string };

function capture(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

/**
 * `tty` makes stdout and stderr capable terminals; `env` replaces the
 * environment; `stdin` is the piped input, which is closed after it (empty
 * when none is given, so a read that expected input ends rather than hangs);
 * `interactive` makes stdin a terminal too, which with `tty` is an interactive host;
 * `keys` types onto that terminal (raw mode, left open) for the questions a run asks;
 * `signal` is a caller-owned abort that cancels the run.
 */
export async function runArgv(
  app: Pick<Application, 'run'>,
  argv: string[],
  opts: {
    tty?: boolean;
    env?: Record<string, string>;
    stdin?: string;
    interactive?: boolean;
    keys?: string;
    signal?: AbortSignal;
  } = {},
): Promise<ArgvRun> {
  const out = capture();
  const err = capture();
  const tty = opts.tty ?? false;
  const stdin = new PassThrough();
  if (opts.keys === undefined) {
    stdin.end(opts.stdin ?? '');
  } else {
    // A terminal reads keys in raw mode and stays open; the prompts library requires both.
    Object.assign(stdin, { setRawMode: () => stdin });
    stdin.write(opts.keys);
  }
  const terminal = { columns: tty ? 120 : undefined, isTTY: tty, rows: tty ? 40 : undefined };
  // run() sets the process exit code too; the test process keeps its own.
  const before = process.exitCode;
  const env = opts.env ?? { TERM: 'xterm-256color' };
  // Without an absolute HOME the handle's home falls back to the real one; '' is no home.
  const home = isAbsolute(env.HOME ?? '') ? undefined : '';
  const exitCode = await app.run({
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    process: processHandle({
      argv,
      env,
      ...(home === undefined ? {} : { home }),
      stderr: err.stream,
      stdin,
      stdout: out.stream,
      terminal: {
        stderr: terminal,
        stdin: { isTTY: opts.interactive ?? false },
        stdout: terminal,
      },
    }),
  });
  process.exitCode = before ?? 0;
  return { exitCode, stderr: err.text(), stdout: out.text() };
}

/**
 * Run an Application on argv with a captured host, as a terminal or a pipe.
 * Test-only.
 */
import { PassThrough } from 'node:stream';

import type { Application } from '@loomcli/core';

export type ArgvRun = { exitCode: number; stdout: string; stderr: string };

function capture(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

/** `tty` makes stdout and stderr capable terminals; `env` replaces the environment. */
export async function runArgv(
  app: Pick<Application, 'run'>,
  argv: string[],
  opts: { tty?: boolean; env?: Record<string, string> } = {},
): Promise<ArgvRun> {
  const out = capture();
  const err = capture();
  const tty = opts.tty ?? false;
  const terminal = { columns: tty ? 120 : undefined, isTTY: tty, rows: tty ? 40 : undefined };
  // run() sets the process exit code too; the test process keeps its own.
  const before = process.exitCode;
  const exitCode = await app.run({
    host: {
      argv,
      env: opts.env ?? { TERM: 'xterm-256color' },
      stderr: err.stream,
      stdin: new PassThrough(),
      stdout: out.stream,
      terminal: { stderr: terminal, stdin: { isTTY: false }, stdout: terminal },
    },
  });
  process.exitCode = before ?? 0;
  return { exitCode, stderr: err.text(), stdout: out.text() };
}

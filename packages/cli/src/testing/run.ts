/**
 * Run an Application on argv over @loomcli/testing's `mockProcess`, as a
 * terminal or a pipe, and read back what it wrote. The mock reads nothing from
 * the real process: no environment, home, working directory, or zone. This
 * adapter only maps the options 23 test files already spell (`tty`,
 * `interactive`, `keys`, `stdin`, `env`, `signal`) onto the mock's fields and
 * flattens its recording into one result. Test-only.
 */
import type { Application } from '@loomcli/core';
import { mockProcess } from '@loomcli/testing';

export type ArgvRun = { exitCode: number; stdout: string; stderr: string };

/** The width and height a `tty` run reports. */
const SCREEN = { columns: 120, rows: 40 };

/**
 * `tty` makes stdout and stderr capable terminals; `env` replaces the
 * environment; `stdin` is the piped input (empty when none is given, so a read
 * that expected input ends rather than hangs); `interactive` makes stdin a
 * terminal too, which with `tty` is an interactive host; `keys` is what the
 * operator types onto that terminal while one question holds it; `signal` is a
 * caller-owned abort that cancels the run.
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
  const keyboard = opts.interactive === true || opts.keys !== undefined;
  const terminal = {
    ...SCREEN,
    // A keyboard without `tty` leaves the output streams piped.
    ...(opts.tty === true ? {} : { streams: [] as const }),
  };
  const mock = mockProcess({
    argv,
    env: opts.env ?? { TERM: 'xterm-256color' },
    ...(keyboard
      ? { terminal: { ...terminal, keys: opts.keys === undefined ? [] : [opts.keys] } }
      : {
          stdin: opts.stdin ?? '',
          ...(opts.tty === true ? { terminal } : {}),
        }),
  });
  const exitCode = await app.run({
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    process: mock,
  });
  return { exitCode, stderr: mock.stderr.text, stdout: mock.stdout.text };
}

/**
 * The one impure process edge: run an argv, capture exit code and output.
 * Consumers (the launchd supervisor, the vault's git operations) take an
 * `Exec` so tests inject a fake; `bunExec` is the real implementation.
 */

export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
};
export type Exec = (argv: string[]) => Promise<ExecResult>;

/** Run an argv via Bun, capturing exit code and output. */
export const bunExec: Exec = async (argv) => {
  const proc = Bun.spawn(argv, { stderr: 'pipe', stdout: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stderr, stdout };
};

type Harness = 'claude' | 'codex' | 'opencode';

type Detection =
  | { kind: 'none' }
  | { kind: 'single'; harness: Harness; session: string | undefined }
  | { kind: 'conflict'; harnesses: Harness[] };

type PassedHandle = string | null | undefined;

export type ShellFill =
  | { kind: 'conflict'; harnesses: Harness[] }
  | { kind: 'filled'; harness: PassedHandle; session: PassedHandle };

/** Detect shell harness identity without choosing between inherited nested harnesses. */
export function detectHarness(env: Readonly<Record<string, string | undefined>>): Detection {
  const detected: { harness: Harness; session: string | undefined }[] = [];
  if (env.CLAUDECODE === '1') {
    detected.push({ harness: 'claude', session: env.CLAUDE_CODE_SESSION_ID });
  }
  if (env.CODEX_THREAD_ID !== undefined && env.CODEX_THREAD_ID.trim() !== '') {
    detected.push({ harness: 'codex', session: env.CODEX_THREAD_ID });
  }
  if (env.OPENCODE === '1') {
    detected.push({ harness: 'opencode', session: env.OPENCODE_SESSION_ID });
  }
  if (detected.length > 1) {
    return { harnesses: detected.map(({ harness }) => harness), kind: 'conflict' };
  }
  const [single] = detected;
  return single === undefined ? { kind: 'none' } : { ...single, kind: 'single' };
}

/**
 * Fill a missing main harness or session from the shell, but only when every
 * field the caller passed (blank or null included) equals the shell's own value.
 * A passed field that differs, or is blank, means the caller chose an identity,
 * so the shell must not mix its own into it. Several detected harnesses fill
 * nothing and are reported as a conflict.
 */
export function fillFromShell(
  passed: Readonly<{ harness?: PassedHandle; session?: PassedHandle }>,
  env: Readonly<Record<string, string | undefined>>,
): ShellFill {
  const detected = detectHarness(env);
  if (detected.kind === 'conflict') {
    return detected;
  }
  const unchanged = { harness: passed.harness, kind: 'filled', session: passed.session } as const;
  if (detected.kind === 'none') {
    return unchanged;
  }
  const agrees =
    (passed.harness === undefined || passed.harness === detected.harness) &&
    (passed.session === undefined || passed.session === detected.session);
  if (!agrees) {
    return unchanged;
  }
  return {
    harness: passed.harness ?? detected.harness,
    kind: 'filled',
    session: passed.session ?? detected.session,
  };
}

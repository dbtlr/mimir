type Harness = 'claude' | 'codex' | 'opencode' | 't3';

type Detection =
  | { kind: 'none' }
  | { kind: 'single'; harness: Harness; session: string | undefined }
  | { kind: 'conflict'; harnesses: Harness[] };

type PassedHandle = string | null | undefined;

export type ShellFill =
  | { kind: 'conflict'; harnesses: Harness[] }
  | { kind: 'filled'; harness: PassedHandle; session: PassedHandle };

/**
 * Detect shell harness identity without choosing between inherited nested harnesses.
 * A T3 thread is the exception: it is the conversation the user resumes, so it
 * wins over every agent detected under it, including agents started inside it.
 */
export function detectHarness(env: Readonly<Record<string, string | undefined>>): Detection {
  if (env.T3CODE_THREAD_ID !== undefined && env.T3CODE_THREAD_ID.trim() !== '') {
    return { harness: 't3', kind: 'single', session: env.T3CODE_THREAD_ID };
  }
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

/**
 * Fill an omitted host from the T3 environment a T3 thread runs in, so Open in
 * T3 can link the thread (ADR 0040). Fleet sets `T3CODE_ENVIRONMENT_ID` on each
 * T3 server. It fills only when the identity being recorded is this shell's
 * own T3 thread: another harness or session may run on another machine.
 * A passed host, blank included, always wins.
 */
export function t3HostFromShell(
  recorded: Readonly<{ harness?: PassedHandle; host?: PassedHandle; session?: PassedHandle }>,
  env: Readonly<Record<string, string | undefined>>,
): PassedHandle {
  if (recorded.host !== undefined) {
    return recorded.host;
  }
  // The store trims every handle, so compare and fill the values it would keep.
  const thread = env.T3CODE_THREAD_ID?.trim() ?? '';
  const environment = env.T3CODE_ENVIRONMENT_ID?.trim() ?? '';
  const isThisThread =
    thread !== '' && recorded.harness?.trim() === 't3' && recorded.session?.trim() === thread;
  return isThisThread && environment !== '' ? environment : undefined;
}

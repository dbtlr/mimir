type Harness = 'claude' | 'codex' | 'opencode';

type Detection =
  | { kind: 'none' }
  | { kind: 'single'; harness: Harness; session: string | undefined }
  | { kind: 'conflict'; harnesses: Harness[] };

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

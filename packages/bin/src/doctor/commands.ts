/**
 * The `mimir doctor` command (MMR-166) — ask the store backend for its
 * diagnosis and report it. The backend owns every check (ADR 0030 Decision 6);
 * this module is rendering, scope warnings, and the exit-code contract, and it
 * names nothing backend-specific.
 *
 * Output honors the CLI contract: findings print to stderr and a clean run
 * prints one line on stdout. Doctor is a **non-gating diagnostic** (ADR 0017):
 * it always exits `0` on a successful run regardless of findings — surfacing
 * issues _is_ its job — so a nonzero exit is reserved for doctor itself failing
 * (the backend read throws).
 * Per-finding `error`/`warn` is an informational triage label, not an exit gate.
 * The `json` (pretty array) / `jsonl` (one finding per line) formats emit
 * findings on stdout, same exit-0 contract.
 */
import type { Format, Io } from '../presentation';
import { ok, warn } from '../presentation';
import type { DoctorBackend, DoctorFinding, DoctorScopeMatch } from './contract';

/** One finding as the human line the CLI prints to stderr, e.g. `[warn] node: message (where)`. */
export function findingLine(f: DoctorFinding): string {
  // Tier-1 short spelling (`[err]`/`[warn]`, never `[error]`), so `error` never
  // reads as a `warn`. The wire `severity` field keeps its `error`/`warn` vocabulary.
  const tag = f.severity === 'error' ? 'err' : f.severity;
  return `[${tag}] ${f.node}: ${f.message} (${f.where})`;
}

/** An absent or stale project scope must never read as a clean scan. */
function warnEmptyScope(io: Io, match: DoctorScopeMatch): void {
  if (match?.matched_records === 0) {
    warn(io, `doctor scope '${match.key}' matched 0 records`);
  }
}

export async function cmdDoctor(
  io: Io,
  doctor: DoctorBackend,
  format: Format,
  scope: string | undefined,
): Promise<number> {
  // One backend pass answers both the findings and what the scope matched, so a
  // stale `-s` can never be mistaken for a clean store.
  const { findings, scope: match } = await doctor.diagnose(scope);
  warnEmptyScope(io, match);

  if (format === 'jsonl') {
    // One finding per line — the NDJSON contract every mimir surface honors.
    io.write(findings.map((f) => JSON.stringify(f)).join('\n'));
  } else if (format === 'json') {
    io.write(JSON.stringify(findings, null, 2));
  } else if (findings.length === 0) {
    ok(io, 'doctor: no problems found');
  } else {
    // Findings are the loud channel: each on stderr, tagged by its informational
    // severity.
    for (const f of findings) {
      io.error(findingLine(f));
    }
  }

  // Non-gating (ADR 0017): a successful run always exits 0 — findings are the
  // output, not the status. A doctor-itself failure (the backend read above throws)
  // is never caught here, so the rejection propagates out and the process exits
  // nonzero — the reserved failure signal.
  return 0;
}

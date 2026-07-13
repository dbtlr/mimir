/**
 * The `mimir doctor` command (MMR-166) — run the vault diagnostics registry and
 * report. A vault-only surface: the body-section records it checks live in
 * hand-editable markdown. `readSnapshot` is the injected whole-vault diagnostic
 * read handle.
 *
 * Output honors the CLI contract: findings print to stderr and a clean run
 * prints one line on stdout. Doctor is a **non-gating diagnostic** (ADR 0017):
 * it always exits `0` on a successful run regardless of findings — surfacing
 * issues _is_ its job — so a nonzero exit is reserved for doctor itself failing
 * (the vault read throws). Per-finding `error`/`warn` is an informational triage
 * label, not an exit gate. The `json` (pretty array) / `jsonl` (one finding per
 * line) formats emit findings on stdout, same exit-0 contract.
 */
import type { Format, Io } from '../cli/render';
import { ok } from '../cli/render';
import type { DoctorFinding } from './checks';
import { CHECKS } from './checks';
import type { DoctorSnapshot } from './snapshot';
import { doctorContextFromSnapshot } from './snapshot';

export type DoctorDeps = {
  /** Read every diagnostic input from one whole-vault enumeration (MMR-241). */
  readSnapshot: () => Promise<DoctorSnapshot>;
};

export async function cmdDoctor(
  io: Io,
  deps: DoctorDeps,
  format: Format,
  scope: string | undefined,
): Promise<number> {
  // One shared post-refresh document set serves bodies, graph/declarations, and
  // section diagnostics. The projection keeps MMR-240's authoritative stem scope
  // while the unfiltered snapshot remains available to MMR-183's repair planner.
  const ctx = doctorContextFromSnapshot(await deps.readSnapshot(), scope);
  const findings: DoctorFinding[] = [];
  for (const check of CHECKS) {
    findings.push(...(await check.run(ctx)));
  }

  if (format === 'jsonl') {
    // One finding per line — the NDJSON contract every mimir surface honors.
    io.write(findings.map((f) => JSON.stringify(f)).join('\n'));
  } else if (format === 'json') {
    io.write(JSON.stringify(findings, null, 2));
  } else if (findings.length === 0) {
    ok(io, 'doctor: no problems found');
  } else {
    // Findings are the loud channel: each on stderr, tagged by its informational
    // severity label (there is no per-severity render glyph, and `error` must not
    // read as a `warn`).
    for (const f of findings) {
      io.error(`[${f.severity}] ${f.node}: ${f.message} (${f.where})`);
    }
  }

  // Non-gating (ADR 0017): a successful run always exits 0 — findings are the
  // output, not the status. A doctor-itself failure (the vault read above throws)
  // is never caught here, so the rejection propagates out and the process exits
  // nonzero — the reserved failure signal.
  return 0;
}

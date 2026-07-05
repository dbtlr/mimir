/**
 * The `mimir doctor` command (MMR-166) — run the vault diagnostics registry and
 * report. A vault-only surface: the body-section records it checks live in
 * hand-editable markdown, so on the SQLite backend (typed rows, nothing
 * malformable) doctor no-ops. `readNodeDocs` is the injected vault read handle,
 * `null` when no vault backend is active.
 *
 * Output honors the CLI contract: findings are alerts — stderr + a nonzero exit
 * so doctor can gate a cutover; a clean run prints one line on stdout. The
 * `json`/`jsonl` formats emit the findings array on stdout regardless, still
 * exiting nonzero when any `error` finding is present.
 */
import type { Format, Io } from '../cli/render';
import { ok, warn } from '../cli/render';
import type { DoctorFinding } from './checks';
import { CHECKS } from './checks';

export type DoctorDeps = {
  /** Read every work-state document's raw markdown, or `null` when no vault
   * backend is active (doctor then no-ops). */
  readNodeDocs: (() => Promise<{ stem: string; body: string }[]>) | null;
};

/** Keep only docs in the `-s` scope: the project itself (`KEY`) or its nodes
 * (`KEY-…`). No scope keeps the whole vault. */
function inScope(stem: string, scope: string | undefined): boolean {
  return scope === undefined || stem === scope || stem.startsWith(`${scope}-`);
}

export async function cmdDoctor(
  io: Io,
  deps: DoctorDeps,
  format: Format,
  scope: string | undefined,
): Promise<number> {
  if (deps.readNodeDocs === null) {
    // No vault backend: node bodies live in typed SQLite rows — nothing to lint.
    if (format === 'json' || format === 'jsonl') {
      io.write(JSON.stringify([]));
    } else {
      ok(io, 'doctor: vault backend not active — no body sections to check');
    }
    return 0;
  }

  const readNodeDocs = deps.readNodeDocs;
  const ctx = {
    readNodeDocs: async () => (await readNodeDocs()).filter((d) => inScope(d.stem, scope)),
  };
  const findings: DoctorFinding[] = [];
  for (const check of CHECKS) {
    findings.push(...(await check.run(ctx)));
  }

  if (format === 'json' || format === 'jsonl') {
    io.write(JSON.stringify(findings));
  } else if (findings.length === 0) {
    ok(io, 'doctor: no problems found');
  } else {
    for (const f of findings) {
      warn(io, `${f.node}: ${f.message} (${f.where})`);
    }
  }

  return findings.some((f) => f.severity === 'error') ? 1 : 0;
}

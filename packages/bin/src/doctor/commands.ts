/**
 * The `mimir doctor` command (MMR-166) — run the vault diagnostics registry and
 * report. A vault-only surface: the body-section records it checks live in
 * hand-editable markdown, so on the SQLite backend (typed rows, nothing
 * malformable) doctor no-ops. `readNodeDocs` is the injected vault read handle,
 * `null` when no vault backend is active.
 *
 * Output honors the CLI contract: findings print to stderr and a clean run
 * prints one line on stdout. Only an `error` finding (a record the reader drops)
 * gates with a nonzero exit — so doctor can gate a cutover; a `warn` (a
 * heading-shaped line the reader still reads as content) is surfaced but
 * non-gating. The `json` (pretty array) / `jsonl` (one finding per line) formats
 * emit findings on stdout, still exiting nonzero when any `error` is present.
 */
import type { Format, Io } from '../cli/render';
import { ok } from '../cli/render';
import type { VaultGraph } from '../core/store-norn';
import type { DoctorContext, DoctorFinding } from './checks';
import { CHECKS } from './checks';

export type DoctorDeps = {
  /** Read every work-state document's raw markdown, or `null` when no vault
   * backend is active (doctor then no-ops). */
  readNodeDocs: (() => Promise<{ stem: string; body: string }[]>) | null;
  /** Read the vault's raw, unresolved relational graph, or `null` on the SQLite
   * backend. Wired with {@link readNodeDocs}: both present, or both null. */
  readVaultGraph: (() => Promise<VaultGraph>) | null;
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
  if (deps.readNodeDocs === null || deps.readVaultGraph === null) {
    // No vault backend: node state lives in typed SQLite rows — nothing here can
    // be malformed (body sections) or dangle (the parent_id/project_id FKs hold).
    if (format === 'json') {
      io.write('[]');
    } else if (format !== 'jsonl') {
      ok(io, 'doctor: vault backend not active — no body sections to check');
    }
    return 0;
  }

  // Read the vault once and share it across every check (and apply the -s scope
  // here, not per check) — the registry is built to grow, so a per-check read
  // would be one whole-vault scan per check.
  const docs = (await deps.readNodeDocs()).filter((d) => inScope(d.stem, scope));
  // The graph stays whole-vault (unscoped): a referential break anywhere breaks
  // the entire vault load, so `-s` must not hide it.
  const graph = await deps.readVaultGraph();
  const ctx: DoctorContext = {
    readNodeDocs: () => Promise.resolve(docs),
    readVaultGraph: () => Promise.resolve(graph),
  };
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
    // Findings are the loud channel: each on stderr, tagged by severity (there
    // is no per-severity render glyph, and `error` must not read as a `warn`).
    for (const f of findings) {
      io.error(`[${f.severity}] ${f.node}: ${f.message} (${f.where})`);
    }
  }

  return findings.some((f) => f.severity === 'error') ? 1 : 0;
}

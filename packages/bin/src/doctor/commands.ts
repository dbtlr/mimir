/**
 * The `mimir doctor` command (MMR-166) — run the vault diagnostics registry and
 * report. A vault-only surface: the body-section records it checks live in
 * hand-editable markdown. `readNodeDocs` / `readSectionFailures` / `readVaultGraph`
 * / `validate` are the injected vault read handles.
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
import type { VaultGraph } from '../core/store-norn';
import { validate } from '../core/validate';
import { decodeValidateFindings, stemOf } from '../norn/decode';
import type { DoctorContext, DoctorFinding } from './checks';
import { CHECKS } from './checks';

export type DoctorDeps = {
  /** Read work-state documents' raw markdown. Doctor always calls this unscoped,
   * then filters by canonical stem so corrupt `project` frontmatter cannot hide
   * a document from its true project (MMR-240). */
  readNodeDocs: (scope: string | undefined) => Promise<{ stem: string; body: string }[]>;
  /** Read work-state docs whose `## History`/`## Annotations` heading norn cannot
   * resolve (ambiguous duplicate or missing). Doctor calls this unscoped for the
   * same canonical-identity reason as {@link readNodeDocs}. */
  readSectionFailures: (scope: string | undefined) => Promise<{ stem: string; section: string }[]>;
  /** Read the vault's raw, unresolved relational graph. */
  readVaultGraph: () => Promise<VaultGraph>;
  /** Run norn's `vault.validate` and return its raw (untyped) payload. Surfaces
   * the frontmatter corruptions (parse-failed, untyped) that make a doc invisible
   * to the reader AND to every graph-based check (MMR-191). */
  validate: () => Promise<unknown>;
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
  // Read the per-document inputs whole-vault, then narrow by canonical stem.
  // Pushing `scope` into Norn would query the corruptible `project` projection:
  // a doc whose field lies falls out before this authoritative filter can see it
  // (MMR-240). MMR-241 will consolidate these independent scans into one shared
  // snapshot; this checkpoint deliberately fixes only their scope semantics.
  const docs = (await deps.readNodeDocs(undefined)).filter((d) => inScope(d.stem, scope));
  // The graph stays whole-vault (unscoped): a referential break anywhere breaks
  // the entire vault load, so `-s` must not hide it. Validate it ONCE here and
  // share the `dropped[]` across every referential check (MMR-182) — the four
  // that render it would otherwise each recompute a whole validator pass.
  const graph = await deps.readVaultGraph();
  const { dropped } = validate(graph);
  // The frontmatter check (MMR-191) reads norn's own schema validation, decoded
  // defensively — a doc whose frontmatter fails to parse (or lacks a `type`) is
  // absent from the graph above, so only `vault.validate` sees it. Scope it by
  // `-s` like `docs` (a per-document check): an isolated parse failure does not
  // break the whole load, so — unlike the referential `dropped[]` — it honors
  // scope. Filter here so the check receives pre-scoped findings.
  const validateFindings = decodeValidateFindings(await deps.validate()).filter((f) =>
    inScope(stemOf(f.path), scope),
  );
  // Section-resolution failures are per-document and honor `-s`, but their read
  // must also enumerate whole-vault before the canonical stem filter (MMR-240).
  const sectionFailures = (await deps.readSectionFailures(undefined)).filter((f) =>
    inScope(f.stem, scope),
  );
  const ctx: DoctorContext = {
    dropped,
    // Whole-vault (graph is unscoped): the stem-vs-project check must see docs a
    // scoped read would misfile out of view (MMR-231).
    projectRefs: graph.declarations ?? [],
    readNodeDocs: () => Promise.resolve(docs),
    sectionFailures,
    validateFindings,
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

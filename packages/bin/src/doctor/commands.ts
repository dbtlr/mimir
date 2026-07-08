/**
 * The `mimir doctor` command (MMR-166) — run the vault diagnostics registry and
 * report. A vault-only surface: the body-section records it checks live in
 * hand-editable markdown, so on the SQLite backend (typed rows, nothing
 * malformable) doctor no-ops. `readNodeDocs` is the injected vault read handle,
 * `null` when no vault backend is active.
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
  /** Read every work-state document's raw markdown, or `null` when no vault
   * backend is active (doctor then no-ops). A `scope` (project KEY) pushes into
   * the vault query so a scoped run fetches only that project's docs (MMR-170). */
  readNodeDocs: ((scope: string | undefined) => Promise<{ stem: string; body: string }[]>) | null;
  /** Read the vault's raw, unresolved relational graph, or `null` on the SQLite
   * backend. Wired with {@link readNodeDocs}: both present, or both null. */
  readVaultGraph: (() => Promise<VaultGraph>) | null;
  /** Run norn's `vault.validate` and return its raw (untyped) payload, or `null`
   * on the SQLite backend. Surfaces the frontmatter corruptions (parse-failed,
   * untyped) that make a doc invisible to the reader AND to every graph-based
   * check (MMR-191). Wired with {@link readNodeDocs}: all present, or all null. */
  validate: (() => Promise<unknown>) | null;
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
  if (deps.readNodeDocs === null || deps.readVaultGraph === null || deps.validate === null) {
    // No vault backend: node state lives in typed SQLite rows — nothing here can
    // be malformed (body sections) or dangle (the parent_id/project_id FKs hold).
    if (format === 'json') {
      io.write('[]');
    } else if (format !== 'jsonl') {
      ok(io, 'doctor: vault backend not active — no body sections to check');
    }
    return 0;
  }

  // Read the vault once and share it across every check — the registry is built
  // to grow, so a per-check read would be one scan per check. The `-s` scope is
  // pushed into the vault query (MMR-170) so a scoped run fetches only its
  // project's docs; the stem-based `inScope` filter stays as the authoritative
  // backstop (the query scopes on the `project` frontmatter field, a projection
  // of the stem — the stem is the truth, so a filter here can never widen the
  // set, only guarantee it).
  const docs = (await deps.readNodeDocs(scope)).filter((d) => inScope(d.stem, scope));
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
  const ctx: DoctorContext = {
    dropped,
    // Whole-vault (graph is unscoped): the stem-vs-project check must see docs a
    // scoped read would misfile out of view (MMR-231).
    projectRefs: graph.declarations ?? [],
    readNodeDocs: () => Promise.resolve(docs),
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

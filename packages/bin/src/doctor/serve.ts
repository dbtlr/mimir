/**
 * The `/api/doctor` orchestrator (MMR-185) — gather the vault reads the shared
 * validator needs, run the one detector ({@link CHECKS}), fetch the affected
 * documents' `.raw` text for location + snippet enrichment, and shape it all into
 * the {@link DoctorFacet} the console panel consumes. The gather mirrors
 * `cmdDoctor` (ADR 0017: the CLI and the facet read the SAME findings); the extra
 * over the CLI is the `.raw` fetch and the per-project readable/dropped tally.
 *
 * Every read is a Norn read (ADR 0018): the `.raw` disk representation is fetched
 * by path, so it resolves even for a document whose frontmatter won't parse — the
 * one class of corruption absent from the type-enumerated node read.
 */
import type { VaultGraph } from '../core/store-norn';
import { validate } from '../core/validate';
import { decodeValidateFindings, stemOf } from '../norn/decode';
import type { DoctorContext, DoctorFinding } from './checks';
import { CHECKS } from './checks';
import { buildDoctorFacet, pathOfStem } from './facet';
import type { DoctorFacet } from './facet';

/** The vault read handles the facet needs — the `cmdDoctor` set plus `readRaw`
 * (the `.raw` fetch for location enrichment). All present on the Norn backend, all
 * null on SQLite (typed rows carry no malformable vault documents). */
export type DoctorFacetDeps = {
  readNodeDocs: (scope: string | undefined) => Promise<{ stem: string; body: string }[]>;
  readSectionFailures: (scope: string | undefined) => Promise<{ stem: string; section: string }[]>;
  readVaultGraph: () => Promise<VaultGraph>;
  validate: () => Promise<unknown>;
  /** Fetch each path's `.raw` disk text (frontmatter + body), keyed back by path. */
  readRaw: (paths: string[]) => Promise<{ path: string; raw: string }[]>;
};

/** Keep only docs in the `-s` scope — the project itself or its nodes (mirrors
 * `cmdDoctor`'s filter). */
function inScope(stem: string, scope: string | undefined): boolean {
  return scope === undefined || stem === scope || stem.startsWith(`${scope}-`);
}

/**
 * Compute the record-health facet over the whole vault. The `scope` narrows the
 * per-document reads (as `mimir doctor -s` does); the referential graph stays
 * whole-vault (a break anywhere breaks the load). The caller filters the returned
 * groups to a single project for a project-scoped panel.
 */
export async function computeDoctorFacet(
  deps: DoctorFacetDeps,
  scope: string | undefined,
): Promise<DoctorFacet> {
  const docs = (await deps.readNodeDocs(scope)).filter((d) => inScope(d.stem, scope));
  const graph = await deps.readVaultGraph();
  const { dropped } = validate(graph);
  const validateFindings = decodeValidateFindings(await deps.validate()).filter((f) =>
    inScope(stemOf(f.path), scope),
  );
  const sectionFailures = (await deps.readSectionFailures(scope)).filter((f) =>
    inScope(f.stem, scope),
  );
  const ctx: DoctorContext = {
    dropped,
    projectRefs: graph.declarations ?? [],
    readNodeDocs: () => Promise.resolve(docs),
    sectionFailures,
    validateFindings,
  };
  const findings: DoctorFinding[] = [];
  for (const check of CHECKS) {
    findings.push(...(await check.run(ctx)));
  }

  // Fetch `.raw` for each affected document (deduped) — the location + snippet
  // enrichment source. Keyed by path (its stem resolves the finding).
  const paths = [...new Set(findings.map((f) => pathOfStem(f.node)).filter((p) => p !== null))];
  const rawByStem = new Map<string, string>();
  if (paths.length > 0) {
    for (const { path, raw } of await deps.readRaw(paths)) {
      rawByStem.set(stemOf(path), raw);
    }
  }

  return buildDoctorFacet({
    findings,
    rawByStem,
    readableDocStems: docs.map((d) => d.stem),
    scannedAt: new Date().toISOString(),
  });
}

/** The empty facet — the SQLite backend (no vault) and the clean-vault zero state. */
export function emptyDoctorFacet(): DoctorFacet {
  return { dropped_total: 0, groups: [], scanned_at: new Date().toISOString() };
}

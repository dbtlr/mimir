/**
 * The `/api/doctor` orchestrator (MMR-185) — gather the vault reads the shared
 * validator needs, run the one detector ({@link CHECKS}), fetch the affected
 * documents' exact Markdown for location + snippet enrichment, and shape it into
 * the {@link DoctorFacet} the console panel consumes. The gather mirrors
 * `cmdDoctor` (ADR 0017: the CLI and the facet read the SAME findings); the extra
 * over the CLI is the raw-Markdown fetch and the per-project readable/dropped tally.
 *
 * Every read is a Norn read (ADR 0018): the exact Markdown is fetched by path
 * (norn 0.48 retired the `.raw` facet; `vault.get format: markdown` replaces it),
 * so it resolves even for a document whose frontmatter won't parse — the one
 * class of corruption absent from the type-enumerated node read.
 */
import { stemOf } from '../norn/decode';
import { diagnoseDoctor } from './diagnosis';
import { buildDoctorFacet, pathOfStem } from './facet';
import type { DoctorFacet } from './facet';
import type { DoctorSnapshot } from './snapshot';
import { doctorIdentityIndex, doctorLogicalStemAtPath, doctorStemInScope } from './snapshot';

/** The vault read handles the facet needs — the `cmdDoctor` set plus `readRaw`
 * (the exact-Markdown fetch for location enrichment). Norn is the sole `Store` port
 * implementor (ADR 0016 Refinement, MMR-279), so both are always available
 * wherever a vault-backed doctor facet is wired in. */
export type DoctorFacetDeps = {
  /** The same one-enumeration diagnostic snapshot the CLI consumes (MMR-241). */
  readSnapshot: () => Promise<DoctorSnapshot>;
  /** Fetch each path's exact on-disk text (frontmatter + body), keyed back by
   * path — norn 0.48 sources this from `vault.get { format: "markdown" }`. */
  readRaw: (paths: string[]) => Promise<{ path: string; raw: string }[]>;
};

/**
 * Compute the record-health facet over the whole vault. The `scope` narrows the
 * per-document inputs by canonical stem after whole-vault enumeration (as
 * `mimir doctor -s` does); the referential graph stays whole-vault (a break
 * anywhere breaks the load). The caller filters the returned groups to a single
 * project for a project-scoped panel.
 */
export async function computeDoctorFacet(
  deps: DoctorFacetDeps,
  scope: string | undefined,
): Promise<DoctorFacet> {
  const snapshot = await deps.readSnapshot();
  const findings = await diagnoseDoctor(snapshot, scope);
  const identityIndex = doctorIdentityIndex(snapshot);
  const physicalPathsByStem = identityIndex.pathsByStem;

  // Fetch the exact Markdown for each affected document (deduped) — the location + snippet
  // enrichment source. Keyed by path (its stem resolves the finding).
  const paths = [
    ...new Set(
      findings
        .filter((finding) => {
          const logicalStem = finding.locator.endsWith('.md')
            ? (doctorLogicalStemAtPath(identityIndex, finding.locator) ?? finding.stem)
            : finding.stem;
          return physicalPathsByStem.get(logicalStem)?.size === 1;
        })
        .map((finding) =>
          finding.locator.endsWith('.md') ? finding.locator : pathOfStem(finding.node),
        )
        .filter((path) => path !== null),
    ),
  ];
  const rawByStem = new Map<string, string>();
  if (paths.length > 0) {
    for (const { path, raw } of await deps.readRaw(paths)) {
      rawByStem.set(path, raw);
      rawByStem.set(stemOf(path), raw);
    }
  }

  return buildDoctorFacet({
    findings,
    rawByStem,
    readableDocStems: snapshot.documents
      .map((document) => document.stem)
      .filter((stem) => doctorStemInScope(stem, scope)),
    scannedAt: new Date().toISOString(),
  });
}

/** The empty facet — the clean-vault zero state, and the fallback for a caller
 * (e.g. a doctor-agnostic test server) that never wires a doctor facet provider. */
export function emptyDoctorFacet(): DoctorFacet {
  return { dropped_total: 0, groups: [], scanned_at: new Date().toISOString() };
}

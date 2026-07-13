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
import { stemOf } from '../norn/decode';
import { diagnoseDoctor } from './diagnosis';
import { buildDoctorFacet, pathOfStem } from './facet';
import type { DoctorFacet } from './facet';
import type { DoctorSnapshot } from './snapshot';
import { doctorPhysicalPathsByStem, doctorStemInScope } from './snapshot';

/** The vault read handles the facet needs — the `cmdDoctor` set plus `readRaw`
 * (the `.raw` fetch for location enrichment). All present on the Norn backend, all
 * null on SQLite (typed rows carry no malformable vault documents). */
export type DoctorFacetDeps = {
  /** The same one-enumeration diagnostic snapshot the CLI consumes (MMR-241). */
  readSnapshot: () => Promise<DoctorSnapshot>;
  /** Fetch each path's `.raw` disk text (frontmatter + body), keyed back by path. */
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
  const physicalPathsByStem = doctorPhysicalPathsByStem(snapshot);

  // Fetch `.raw` for each affected document (deduped) — the location + snippet
  // enrichment source. Keyed by path (its stem resolves the finding).
  const paths = [
    ...new Set(
      findings
        .filter((finding) => (physicalPathsByStem.get(finding.stem)?.size ?? 0) <= 1)
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

/** The empty facet — the SQLite backend (no vault) and the clean-vault zero state. */
export function emptyDoctorFacet(): DoctorFacet {
  return { dropped_total: 0, groups: [], scanned_at: new Date().toISOString() };
}

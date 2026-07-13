import { stemOf } from '../norn/decode';
import type { DoctorFinding } from './checks';
import { CHECKS } from './checks';
import type { DoctorSnapshot } from './snapshot';
import { doctorContextFromSnapshot } from './snapshot';

/** Every known physical owner of a logical stem, including malformed/untyped
 * documents visible only through `vault.validate`. */
export function doctorPhysicalPathsByStem(
  snapshot: DoctorSnapshot,
): ReadonlyMap<string, ReadonlySet<string>> {
  const pathsByStem = new Map<string, Set<string>>();
  const add = (stem: string, path: string): void => {
    const paths = pathsByStem.get(stem) ?? new Set<string>();
    paths.add(path);
    pathsByStem.set(stem, paths);
  };
  for (const doc of snapshot.documents) {
    add(doc.stem, doc.path);
  }
  for (const finding of snapshot.validateFindings) {
    add(stemOf(finding.path), finding.path);
  }
  return pathsByStem;
}

/** Shared diagnosis seam for every transport. Enriches findings with a physical
 * locator only when all snapshot evidence names one unique owner of the stem. */
export async function diagnoseDoctor(
  snapshot: DoctorSnapshot,
  scope: string | undefined,
): Promise<DoctorFinding[]> {
  const ctx = doctorContextFromSnapshot(snapshot, scope);
  const findings: DoctorFinding[] = [];
  for (const check of CHECKS) {
    findings.push(...(await check.run(ctx)));
  }
  const pathsByStem = doctorPhysicalPathsByStem(snapshot);
  for (const finding of findings) {
    const paths = pathsByStem.get(finding.stem);
    if (paths?.size === 1) {
      finding.locator = [...paths][0] ?? finding.locator;
    }
  }
  return findings;
}

import type { DoctorFinding } from './checks';
import { CHECKS } from './checks';
import type { DoctorSnapshot } from './snapshot';
import { doctorContextFromSnapshot } from './snapshot';

/** Shared diagnosis seam for every transport. Enriches findings with a physical
 * locator only when one snapshot document uniquely owns the canonical stem. */
export async function diagnoseDoctor(
  snapshot: DoctorSnapshot,
  scope: string | undefined,
): Promise<DoctorFinding[]> {
  const ctx = doctorContextFromSnapshot(snapshot, scope);
  const findings: DoctorFinding[] = [];
  for (const check of CHECKS) {
    findings.push(...(await check.run(ctx)));
  }
  const pathsByStem = new Map<string, string[]>();
  for (const doc of snapshot.documents) {
    pathsByStem.set(doc.stem, [...(pathsByStem.get(doc.stem) ?? []), doc.path]);
  }
  for (const finding of findings) {
    const paths = pathsByStem.get(finding.stem);
    if (paths?.length === 1) {
      finding.locator = paths[0] ?? finding.locator;
    }
  }
  return findings;
}

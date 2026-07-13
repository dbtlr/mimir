import type { DoctorFinding } from './checks';
import { CHECKS } from './checks';
import type { DoctorSnapshot } from './snapshot';
import { doctorContextFromSnapshot, doctorPhysicalPathsByStem } from './snapshot';

/** Shared diagnosis seam for every transport. Exact per-document locators survive
 * ambiguity; logical locators are enriched only for one uniquely owned stem. */
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
    if (finding.locator.endsWith('.md')) {
      continue;
    }
    const paths = pathsByStem.get(finding.stem);
    if (paths?.size === 1) {
      finding.locator = [...paths][0] ?? finding.locator;
    }
  }
  return findings;
}

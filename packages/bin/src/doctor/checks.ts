/**
 * The `mimir doctor` check registry (MMR-166). Doctor is a vault diagnostics
 * surface: each check is an independent {@link Diagnostic} that inspects the
 * vault and reports {@link DoctorFinding}s for a human to fix. This slice ships
 * one check — body-section record integrity — with the registry structured so
 * siblings (orphans, acyclicity, backend parity, …) register the same way
 * without touching the runner (MMR-169).
 */
import type { BodyRecordProblem } from '../core/history-codec';
import { lintBodySections } from '../core/history-codec';

/** What a check reads: the raw vault documents to diagnose. */
export type DoctorContext = {
  /** Every work-state document's raw markdown, as `{ stem, body }`. */
  readNodeDocs: () => Promise<{ stem: string; body: string }[]>;
};

/** One problem a check found, anchored for a human to locate and fix. */
export type DoctorFinding = {
  /** The reporting check's {@link Diagnostic.name}. */
  check: string;
  /** `error` fails the run (nonzero exit); `warn` is advisory. */
  severity: 'error' | 'warn';
  /** The offending node's `KEY-seq` stem. */
  node: string;
  /** Where in the document, e.g. `History · line 6`. */
  where: string;
  /** A one-line human description of the problem. */
  message: string;
};

/** A registered diagnostic: a named check over the vault. */
export type Diagnostic = {
  name: string;
  title: string;
  run: (ctx: DoctorContext) => Promise<DoctorFinding[]>;
};

const PROBLEM_MESSAGE: Record<BodyRecordProblem, string> = {
  'malformed-history-heading': 'history heading is not a valid record',
  'non-iso-annotation-heading': 'annotation heading is not an ISO-8601 timestamp',
  'unknown-transition-kind': 'history record has an unknown transition kind',
  'unparseable-history-record': 'history record is missing or has an unparseable edge line',
};

/**
 * Body-section record integrity: scan each node/project body for malformed
 * `## History` / `## Annotations` records — the ones the read path (MMR-161)
 * tolerate-and-skips with no channel to warn. Every finding is an `error`: a
 * malformed record is silently dropped or mis-absorbed on read.
 */
export const bodySectionCheck: Diagnostic = {
  name: 'body-sections',
  run: async (ctx) => {
    const findings: DoctorFinding[] = [];
    for (const { stem, body } of await ctx.readNodeDocs()) {
      for (const f of lintBodySections(body)) {
        findings.push({
          check: 'body-sections',
          message: `${PROBLEM_MESSAGE[f.problem]} — ${f.heading}`,
          node: stem,
          severity: 'error',
          where: `${f.section} · line ${String(f.line)}`,
        });
      }
    }
    return findings;
  },
  title: 'Body-section record integrity',
};

/** The registered checks `mimir doctor` runs, in report order. */
export const CHECKS: readonly Diagnostic[] = [bodySectionCheck];

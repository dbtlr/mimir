import { expect, test } from 'bun:test';

import { applyReportOutcome, createdStem, decodeApplyReport } from './apply-report';

// ── decodeApplyReport (MMR-250) ───────────────────────────────────────────────
// The one home for the raw `vault.apply` report decode: envelope unwrap (the
// `report.report` double nesting), outcome extraction, and per-op field reads
// (`op_id`/`kind`/`status`/`stem`/`error`). Each field narrows to a string or
// null so a degraded report never reads as a false success.

test('unwraps the double-nested `report.report` envelope (the refusal shape)', () => {
  const decoded = decodeApplyReport({ report: { operations: [], outcome: 'refused' } });
  expect(decoded.outcome).toBe('refused');
});

test('reads a flat report with no double nesting', () => {
  const decoded = decodeApplyReport({ operations: [], outcome: 'applied' });
  expect(decoded.outcome).toBe('applied');
});

test('outcome is null when absent or non-string', () => {
  expect(decodeApplyReport({ report: { operations: [] } }).outcome).toBeNull();
  expect(decodeApplyReport({ report: { operations: [], outcome: 7 } }).outcome).toBeNull();
  expect(decodeApplyReport(null).outcome).toBeNull();
  expect(decodeApplyReport('nope').outcome).toBeNull();
});

test('operations are empty when the report is not a record or `operations` is not an array', () => {
  expect(decodeApplyReport({ report: { operations: 'x', outcome: 'applied' } }).operations).toEqual(
    [],
  );
  expect(decodeApplyReport(42).operations).toEqual([]);
});

test('normalizes an applied create op — op_id, kind, status, stem', () => {
  const decoded = decodeApplyReport({
    report: {
      operations: [{ kind: 'create_document', op_id: '0', status: 'applied', stem: 'MMR-2' }],
      outcome: 'applied',
    },
  });
  expect(decoded.operations).toEqual([
    { error: null, kind: 'create_document', opId: '0', status: 'applied', stem: 'MMR-2' },
  ]);
});

test('normalizes a failed op error to { code, message }', () => {
  const decoded = decodeApplyReport({
    report: {
      operations: [
        {
          error: {
            code: 'expected-old-value-mismatch',
            message: 'stale plan',
            path: 'MMR/MMR-1.md',
          },
          kind: 'set_frontmatter',
          status: 'failed',
        },
      ],
      outcome: 'refused',
    },
  });
  expect(decoded.operations[0]?.error).toEqual({
    code: 'expected-old-value-mismatch',
    message: 'stale plan',
  });
});

test('error is null when the op carries no structured error object', () => {
  const decoded = decodeApplyReport({
    report: { operations: [{ kind: 'create_document', op_id: '0', status: 'skipped' }] },
  });
  expect(decoded.operations[0]).toEqual({
    error: null,
    kind: 'create_document',
    opId: '0',
    status: 'skipped',
    stem: null,
  });
});

test('a non-string field on an op decodes to null (never a false value)', () => {
  const decoded = decodeApplyReport({
    report: {
      operations: [{ error: { code: 9, message: null }, kind: 42, op_id: 0, status: {}, stem: [] }],
    },
  });
  expect(decoded.operations[0]).toEqual({
    error: { code: null, message: null },
    kind: null,
    opId: null,
    status: null,
    stem: null,
  });
});

test('tolerates the norn 0.48 v3 report shape — schema_version 3 and preconditions[] (MMR-297)', () => {
  // NRN-264 / ADR 0015 moved ApplyReport to schema v3: reports gain a
  // first-class `preconditions` results array (and carry `schema_version`,
  // `trace_id`, precondition-result records mimir never reads). The decode reads
  // only `outcome` and the per-op fields, so the additive v3 fields pass through
  // untouched — the create stem still resolves and no unknown field derails it.
  const v3Report = {
    report: {
      applied: 1,
      failed: 0,
      operations: [{ kind: 'create_document', op_id: '0', status: 'applied', stem: 'MMR-2' }],
      outcome: 'applied',
      preconditions: [
        {
          actual_paths: ['projects/mimir.md'],
          expected_paths: ['projects/mimir.md'],
          id: 'project-owner',
          status: 'passed',
        },
      ],
      schema_version: 3,
      skipped: 0,
      trace_id: 'trace-abc',
      vault_root: '/vault',
    },
  };
  expect(decodeApplyReport(v3Report).outcome).toBe('applied');
  expect(createdStem(v3Report)).toEqual({ stem: 'MMR-2' });
});

test('drops non-record operation entries', () => {
  const decoded = decodeApplyReport({
    report: {
      operations: [null, 'x', 42, { kind: 'create_document', op_id: '0', stem: 'MMR-3' }],
      outcome: 'applied',
    },
  });
  expect(decoded.operations).toHaveLength(1);
  expect(decoded.operations[0]?.stem).toBe('MMR-3');
});

// ── applyReportOutcome (MMR-250) ──────────────────────────────────────────────
// The light outcome-only read: same envelope unwrap as decodeApplyReport, no
// operations-array normalization.

test('applyReportOutcome unwraps the double-nested envelope and reads outcome', () => {
  expect(applyReportOutcome({ report: { operations: [], outcome: 'refused' } })).toBe('refused');
});

test('applyReportOutcome is null on a degraded report (absent or non-string outcome)', () => {
  expect(applyReportOutcome({ report: { operations: [] } })).toBeNull();
  expect(applyReportOutcome({ report: { operations: [], outcome: 7 } })).toBeNull();
  expect(applyReportOutcome(null)).toBeNull();
  expect(applyReportOutcome('nope')).toBeNull();
});

// ── createdStem (MMR-250) ──────────────────────────────────────────────────
// The shared create read-back the artifact and seed stores both ran
// byte-identically: resolved stem on an applied create_document, else the
// assembled failure detail.

test('createdStem resolves the stem on an applied create_document op', () => {
  const result = createdStem({
    report: {
      operations: [{ kind: 'create_document', op_id: '0', status: 'applied', stem: 'MMR-2' }],
      outcome: 'applied',
    },
  });
  expect(result).toEqual({ stem: 'MMR-2' });
});

test('createdStem assembles the failure detail from outcome and op error', () => {
  const result = createdStem({
    report: {
      operations: [
        {
          error: { code: 'internal-error', message: 'destination already exists' },
          kind: 'create_document',
          op_id: '0',
          status: 'failed',
        },
      ],
      outcome: 'refused',
    },
  });
  expect(result).toEqual({
    failure: 'apply outcome: refused — internal-error: destination already exists',
  });
});

test('createdStem falls back to "unrecognized" with no error detail on a degraded report', () => {
  expect(createdStem(null)).toEqual({ failure: 'apply outcome: unrecognized' });
});

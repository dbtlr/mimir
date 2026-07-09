import { describe, expect, test } from 'bun:test';

import { annotationRecordsResolution, renderUpstreamAnnotation } from './triage';

/**
 * The triage annotation grammar (MMR-246) — the machine-recognizable marker that
 * makes check (c) idempotent. These are pure (no vault); the integration test
 * exercises the full pass against a converged vault.
 */
describe('triage annotation grammar', () => {
  test('renders the marker head with the reason as human detail', () => {
    expect(renderUpstreamAnnotation('MMR-s3', 'resolved', 'shipped in MMR-9')).toBe(
      'upstream MMR-s3 resolved: shipped in MMR-9',
    );
    expect(renderUpstreamAnnotation('NRN-s2', 'rejected', 'out of scope')).toBe(
      'upstream NRN-s2 rejected: out of scope',
    );
  });

  test('a null/blank reason degrades gracefully to the bare marker head', () => {
    // A seed whose History carries no terminal reason (hand-edited/legacy) still
    // annotates — the marker head alone, no dangling colon.
    expect(renderUpstreamAnnotation('MMR-s3', 'resolved', null)).toBe('upstream MMR-s3 resolved');
    expect(renderUpstreamAnnotation('MMR-s3', 'resolved', '   ')).toBe('upstream MMR-s3 resolved');
  });

  test('recognizes its own annotation — the idempotency key (with or without reason)', () => {
    expect(
      annotationRecordsResolution(
        'upstream MMR-s3 resolved: shipped in MMR-9',
        'MMR-s3',
        'resolved',
      ),
    ).toBe(true);
    expect(annotationRecordsResolution('upstream MMR-s3 resolved', 'MMR-s3', 'resolved')).toBe(
      true,
    );
    // The reason text is not part of the key — a hand-edited reason still matches.
    expect(
      annotationRecordsResolution('upstream MMR-s3 resolved: hand edited', 'MMR-s3', 'resolved'),
    ).toBe(true);
  });

  test('does not match a different seed, a different terminal, or an unrelated note', () => {
    // Different terminal.
    expect(
      annotationRecordsResolution('upstream MMR-s3 rejected: nope', 'MMR-s3', 'resolved'),
    ).toBe(false);
    // Different seed — and no prefix collision (s3 vs s30).
    expect(annotationRecordsResolution('upstream MMR-s30 resolved', 'MMR-s3', 'resolved')).toBe(
      false,
    );
    expect(annotationRecordsResolution('upstream MMR-s3 resolved', 'MMR-s30', 'resolved')).toBe(
      false,
    );
    // Unrelated freeform note.
    expect(
      annotationRecordsResolution('a normal annotation about MMR-s3', 'MMR-s3', 'resolved'),
    ).toBe(false);
  });

  test('render → recognize round-trips for both terminals', () => {
    for (const terminal of ['resolved', 'rejected'] as const) {
      const content = renderUpstreamAnnotation('MMR-s7', terminal, 'because');
      expect(annotationRecordsResolution(content, 'MMR-s7', terminal)).toBe(true);
    }
  });
});

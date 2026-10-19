import { describe, expect, it } from 'vitest';

import type { WireDoctorFacet } from '../api/doctor-facet';
import { recordHealthOf } from '../api/fns/browse';

/** A facet holding one finding with `evidence`. */
function facetWith(evidence: Record<string, unknown>): WireDoctorFacet {
  return {
    finding_total: 1,
    groups: [
      {
        finding_count: 1,
        project: 'MMR',
        records: [
          {
            cause: 'orphan',
            evidence,
            field: null,
            id: 'MMR-2',
            locator: 'node',
            note: 'a note',
            severity: 'warn',
            value: null,
          },
        ],
      },
    ],
    scanned_at: '2026-06-01T10:00:00.000Z',
    scope: null,
  };
}

describe('record health over a server function (MMR-540)', () => {
  it('carries each finding as the doctor facet writes it', () => {
    const facet = facetWith({
      at: new Date('2026-06-01T10:00:00.000Z'),
      count: 2,
      missing: undefined,
      nested: { at: new Date('2026-06-02T10:00:00.000Z'), ids: ['MMR-3'] },
    });
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- the JSON round trip is what the facet carries
    expect(recordHealthOf(facet)).toStrictEqual(JSON.parse(JSON.stringify(facet)));
  });
});

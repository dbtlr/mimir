import { describe, expect } from 'vitest';

import { artifactInput } from '../api/browse-queries';

describe('artifactInput', () => {
  it('names only the project when no filter is set', () => {
    expect(artifactInput({ project: 'MMR' })).toStrictEqual({ project: 'MMR' });
  });

  it('carries only the set filters, and no zone without a date', () => {
    expect(artifactInput({ project: 'MMR', q: 'auth gate', tag: 'kind:spec' })).toStrictEqual({
      project: 'MMR',
      q: 'auth gate',
      tag: 'kind:spec',
    });
    expect(artifactInput({ atOrAfter: '', project: 'MMR', q: '' })).toStrictEqual({
      project: 'MMR',
    });
  });

  it('sends date filters on the creation instant, with this browser zone', () => {
    expect(
      artifactInput({ atOrAfter: '2026-06-01', atOrBefore: '2026-06-30', project: 'MMR' }),
    ).toStrictEqual({
      dates: [
        { field: 'created_at', op: 'at-or-after', value: '2026-06-01' },
        { field: 'created_at', op: 'at-or-before', value: '2026-06-30' },
      ],
      project: 'MMR',
      timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });
});

import { afterEach, describe, expect, it } from 'vitest';

import { dayOf, newestArtifacts, shippedTime, tallyOf } from '../lib/work-page';
import type { RecordArtifact } from '../lib/work-page';
import { engineTree } from './engine-fixtures';

const NY = 'America/New_York';

describe('dayOf', () => {
  const format = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, 'format');
  afterEach(() => {
    if (format !== undefined) {
      Object.defineProperty(Intl.DateTimeFormat.prototype, 'format', format);
    }
  });

  it('keys a day YYYY-MM-DD in the zone, whatever pattern a locale formats whole dates in', () => {
    // ICU has shipped en-CA with a slashed pattern; the key must not follow it.
    Object.defineProperty(Intl.DateTimeFormat.prototype, 'format', {
      configurable: true,
      get: () => () => '11/23/2026',
    });
    const at = Date.parse('2026-11-24T03:30:00Z');
    expect(dayOf(at, 'America/New_York')).toBe('2026-11-23');
    expect(dayOf(at, 'UTC')).toBe('2026-11-24');
  });
});

describe('shippedTime', () => {
  it('reads the finish as a 24-hour HH:MM in the zone', () => {
    expect(shippedTime(new Date('2026-10-12T14:05:00.000Z'), NY)).toBe('10:05');
    expect(shippedTime(new Date('2026-10-13T04:00:00.000Z'), NY)).toBe('00:00');
  });
});

const artifact = (id: string, createdAt: string): RecordArtifact => ({
  createdAt: new Date(createdAt),
  id,
  tags: [],
  title: id,
});

describe('newestArtifacts', () => {
  it('orders newest first, takes the limit, and leaves the input alone', () => {
    const input = [
      artifact('a', '2026-06-01T10:00:00.000Z'),
      artifact('c', '2026-06-03T10:00:00.000Z'),
      artifact('b', '2026-06-02T10:00:00.000Z'),
    ];

    expect(newestArtifacts(input, 2).map((a) => a.id)).toStrictEqual(['c', 'b']);
    expect(input.map((a) => a.id)).toStrictEqual(['a', 'c', 'b']);
  });

  it('breaks equal timestamps on the higher artifact seq, as the server list does', () => {
    const at = '2026-06-01T10:00:00.000Z';
    const input = [artifact('MMR-a2', at), artifact('MMR-a10', at), artifact('MMR-a9', at)];

    expect(newestArtifacts(input, 3).map((a) => a.id)).toStrictEqual([
      'MMR-a10',
      'MMR-a9',
      'MMR-a2',
    ]);
  });
});

describe('tallyOf (MMR-730)', () => {
  it('reads ∞ for an open-ended container that is also parked', () => {
    const parkedOpen = engineTree({
      id: 'MMR-8',
      open_ended: true,
      status: 'parked',
      type: 'initiative',
    });
    expect(tallyOf(parkedOpen)).toStrictEqual({ kind: 'open_ended' });
  });
});

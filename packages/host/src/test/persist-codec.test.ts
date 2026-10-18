import type { PersistedClient } from '@tanstack/react-query-persist-client';
import { describe, expect, it } from 'vitest';

import { PERSIST_BUSTER, deserializeClient, serializeClient } from '../lib/persist';
import { engineProject } from './engine-fixtures';

/*
 * The offline snapshot's codec (MMR-537): Engine reads answer `Date` instants,
 * and a restored snapshot must hand the same `Date`s back, or a page reading a
 * restored project would call date methods on a string.
 */

function snapshot(data: unknown): PersistedClient {
  return {
    buster: PERSIST_BUSTER,
    clientState: {
      mutations: [],
      queries: [
        {
          dehydratedAt: 0,
          queryHash: '["projects"]',
          queryKey: ['projects'],
          state: {
            data,
            dataUpdateCount: 1,
            dataUpdatedAt: 0,
            error: null,
            errorUpdateCount: 0,
            errorUpdatedAt: 0,
            fetchFailureCount: 0,
            fetchFailureReason: null,
            fetchMeta: null,
            fetchStatus: 'idle',
            isInvalidated: false,
            status: 'success',
          },
        },
      ],
    },
    timestamp: 0,
  };
}

describe('the persisted snapshot codec', () => {
  it('restores an Engine read with its Date instants intact', () => {
    const lastActivityAt = new Date('2026-09-05T12:00:00.000Z');
    const project = engineProject({ id: 'MMR', lastActivityAt });
    const restored = deserializeClient(serializeClient(snapshot([project])));
    const data = restored.clientState.queries[0]?.state.data;
    expect(data).toStrictEqual([project]);
    expect(Array.isArray(data) && data[0]?.lastActivityAt instanceof Date).toBe(true);
  });

  it('reads a snapshot written before the codec as stale, so the restore drops it', () => {
    const legacy = JSON.stringify({ ...snapshot([]), buster: 'mimir-ui-v4' });
    const restored = deserializeClient(legacy);
    expect(restored.buster).not.toBe(PERSIST_BUSTER);
    expect(restored.clientState.queries).toStrictEqual([]);
  });

  it('reads an unreadable snapshot as stale instead of failing the restore', () => {
    expect(deserializeClient('not json').buster).not.toBe(PERSIST_BUSTER);
  });
});

import { useQuery } from '@tanstack/react-query';
import type { QueryKey, UseQueryOptions } from '@tanstack/react-query';
import { useState } from 'react';

/** A list read's answer: the rows it returned and how many the whole set holds. */
export type WindowedSet = { items: readonly unknown[]; total: number };

/**
 * A list read with its Show more window (MMR-460, MMR-725): `query` asks for
 * the first `windows` windows of the set. `windows` grows on each Show more
 * and resets whenever `scope` (the filters) changes; the query refetches the
 * larger prefix, keeping the shown rows meanwhile. If that larger read fails
 * the last good rows stay on screen and `loadMoreFailed` says so, and the
 * next Show more retries it.
 */
export function useListWindow<D extends WindowedSet, K extends QueryKey>(
  scope: unknown,
  query: (windows: number) => UseQueryOptions<D, Error, D, K>,
) {
  const key = JSON.stringify(scope);
  const [grown, setGrown] = useState({ key, windows: 1 });
  // A filter change starts over at one window (reset during render, so the
  // stale window count never reaches a query).
  if (grown.key !== key) {
    setGrown({ key, windows: 1 });
  }
  const windows = grown.key === key ? grown.windows : 1;
  const read = useQuery(query(windows));

  // The last settled result for these filters, so a failed larger read does
  // not blank the list (an errored query without data has none of its own).
  const [kept, setKept] = useState<{ key: string; data: D }>();
  if (
    read.data !== undefined &&
    !read.isPlaceholderData &&
    (kept?.key !== key || kept.data !== read.data)
  ) {
    setKept({ data: read.data, key });
  }
  const shown = read.data ?? (kept?.key === key ? kept.data : undefined);

  return {
    hasMore: shown !== undefined && shown.items.length < shown.total,
    loadMore: () => {
      if (read.isError) {
        void read.refetch();
      } else {
        setGrown({ key, windows: windows + 1 });
      }
    },
    loadMoreFailed: read.isError && read.data === undefined && shown !== undefined,
    loadingMore: read.isPlaceholderData,
    read,
    /** The rows on screen: this read's, or the last good ones while a larger read fails. */
    shown,
  };
}

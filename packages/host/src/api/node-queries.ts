import { queryOptions } from '@tanstack/react-query';

import { apiGet } from './client';
import type { Collection, WireAnnotation, WireNode, WireScratchpadRow } from './types';

/*
 * The record reads: a project's or node's record, its annotations, and its
 * board's Scratchpads.
 */

/**
 * The persisted shape version of this module's reads. Bump it in the same
 * change that alters a persisted read's key or data shape here; it is part of
 * the persister's buster (lib/persist.ts), so a bump drops every snapshot
 * written in the old shape instead of restoring it into the new code.
 */
export const NODE_CACHE_VERSION = 1;

/** One project record (status word + distribution for the work page header). */
export const projectQuery = (key: string) =>
  queryOptions({
    queryFn: () => apiGet<WireNode>(`/api/projects/${encodeURIComponent(key)}`),
    queryKey: ['project', key],
  });

/** The full node record (deps, tags, verdicts, artifact titles) its page reads. */
export const nodeQuery = (id: string) =>
  queryOptions({
    queryFn: () => apiGet<WireNode>(`/api/nodes/${encodeURIComponent(id)}`),
    queryKey: ['node', id],
  });

/** The node's freeform annotations (their own sub-resource), for its timeline. */
export const annotationsQuery = (id: string) =>
  queryOptions({
    queryFn: () =>
      apiGet<Collection<WireAnnotation>>(`/api/nodes/${encodeURIComponent(id)}/annotations`),
    queryKey: ['node', id, 'annotations'],
  });

/** One board's active Scratchpads, each with the work it is anchored to. */
export const scratchpadsQuery = (key: string) =>
  queryOptions({
    queryFn: () =>
      apiGet<Collection<WireScratchpadRow>>(`/api/scratchpads?project=${encodeURIComponent(key)}`),
    queryKey: ['scratchpads', key],
  });

import type { FacetName } from '@mimir/contract';
import { queryOptions } from '@tanstack/react-query';

import { getNode, scratchList } from './fns/nodes';

/*
 * The record reads (MMR-539): a project's or node's record, its annotations,
 * and its board's Scratchpads. Each Engine read goes through its server
 * function and answers the Engine's own output, with `Date` instants.
 */

/**
 * The persisted shape version of this module's reads. Bump it in the same
 * change that alters a persisted read's key or data shape here; it is part of
 * the persister's buster (lib/persist.ts), so a bump drops every snapshot
 * written in the old shape instead of restoring it into the new code.
 */
export const NODE_CACHE_VERSION = 2;

/** A project record's projection: its structure, rollup, tags, artifacts, and direction. */
const PROJECT_FACETS: FacetName[] = ['children', 'distribution', 'tags', 'artifacts', 'next'];

/** A node record's projection: the list facets plus its artifacts, history, prose, and direction. */
const NODE_FACETS: FacetName[] = [
  'deps',
  'tags',
  'distribution',
  'verdicts',
  'home',
  'artifacts',
  'history',
  'description',
  'next',
];

/** One project record (status word + distribution for the work page header). */
export const projectQuery = (key: string) =>
  queryOptions({
    queryFn: () => getNode({ data: { facets: PROJECT_FACETS, id: key } }),
    queryKey: ['project', key],
  });

/** The full node record (deps, tags, verdicts, artifact titles) its page reads. */
export const nodeQuery = (id: string) =>
  queryOptions({
    queryFn: () => getNode({ data: { facets: NODE_FACETS, id } }),
    queryKey: ['node', id],
  });

/** The node's freeform annotations (their own facet), for its timeline. */
export const annotationsQuery = (id: string) =>
  queryOptions({
    queryFn: async () => {
      const node = await getNode({ data: { facets: ['annotations'], id } });
      return { items: node.annotations ?? [] };
    },
    queryKey: ['node', id, 'annotations'],
  });

/** One board's active Scratchpads, each with the work it is anchored to. */
export const scratchpadsQuery = (key: string) =>
  queryOptions({
    queryFn: () => scratchList({ data: { project: key } }),
    queryKey: ['scratchpads', key],
  });

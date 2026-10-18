import type { EngineNode } from '@mimir/contract';
import { useQuery } from '@tanstack/react-query';

import { archivedProjectsQuery } from '../api/shell-queries';

/**
 * The archived project a key names, or undefined while the archived list has
 * not answered or names no such project. An archived project's own reads (its
 * record, tree, and work) all 404 (ADR 0015), so a page that knows the key is
 * archived stops asking for them and shows the archived notice instead.
 */
export function useArchivedProject(key: string): EngineNode | undefined {
  const archived = useQuery(archivedProjectsQuery);
  return archived.data?.find((p) => p.id === key);
}

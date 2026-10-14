import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { isNotFound } from '../api/errors';
import { projectQuery } from '../api/queries';
import { UnavailableProject } from './project-unavailable';

/**
 * Shows `children` unless the server answers 404 for the project (archived or
 * gone, ADR 0015), in which case it shows the project page's own unavailable
 * notice. The project browsers wrap themselves in it, so an unknown key reads
 * the same under `/p/KEY/tasks` as at `/p/KEY`. It shares the project page's
 * query, so the read is one request.
 */
export function ProjectGate({ projectKey, children }: { projectKey: string; children: ReactNode }) {
  const project = useQuery(projectQuery(projectKey));
  if (isNotFound(project.error)) {
    return <UnavailableProject projectKey={projectKey} />;
  }
  return children;
}

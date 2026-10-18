import { useQuery } from '@tanstack/react-query';

import { doctorQuery } from '../api/browse-queries';
import { isNotFound } from '../api/errors';
import { projectQuery } from '../api/node-queries';
import { OfflineBanner } from '../components/offline-banner';
import { UnavailableProject } from '../components/project-unavailable';
import { RecordPending } from '../components/record-layout';
import { WorkPage } from '../components/work-page';
import { connectivity } from '../lib/connectivity';
import { useRememberRecord } from '../lib/recent-records';
import { useArchivedProject } from '../lib/use-archived-project';
import { projectRoute } from '../router';

/**
 * `/p/$key` — the project opens as its work page (ADR 0013, MMR-467
 * refinement): Now, Needs you, Frontier, Shipped, and Going cold beside a rail
 * of Direction, About, and Artifacts. Its structure is the sidebar outline
 * (MMR-496).
 */
export function ProjectPage() {
  const { key } = projectRoute.useParams();
  // An archived project's record 404s (ADR 0015). Once the archived list names
  // the key, stop asking for it, so a retry or poll cannot swap the notice for
  // the loading skeleton.
  const archived = useArchivedProject(key);
  const project = useQuery({ ...projectQuery(key), enabled: archived === undefined });
  // The doctor read counts findings; a miss only thins the page, so it does not
  // count toward connectivity.
  const health = useQuery(doctorQuery(key));
  const conn = connectivity([project]);
  useRememberRecord(
    project.data && { id: key, kind: 'project', project: key, title: project.data.title },
  );

  // Archived-404 semantics (ADR 0015): the server answered, so this is not
  // "offline"; the project query keeps polling, so an unarchive heals.
  if (archived !== undefined || isNotFound(project.error)) {
    return <UnavailableProject projectKey={key} />;
  }

  if (project.data === undefined) {
    return (
      <>
        <OfflineBanner {...conn} />
        <RecordPending unreachable={project.isError} />
      </>
    );
  }

  return (
    <>
      <OfflineBanner {...conn} />
      <WorkPage
        record={project.data}
        findings={health.data?.finding_total ?? 0}
        offline={conn.offline}
      />
    </>
  );
}

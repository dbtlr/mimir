import { useQuery } from '@tanstack/react-query';

import { isNotFound } from '../api/errors';
import { doctorQuery, projectQuery } from '../api/queries';
import { OfflineBanner } from '../components/offline-banner';
import { RecordPending } from '../components/record-layout';
import { WorkPage } from '../components/work-page';
import { connectivity } from '../lib/connectivity';
import { useRememberRecord } from '../lib/recent-records';
import { projectRoute } from '../router';
import { ProjectUnavailablePage } from './not-found';

/**
 * `/p/$key` — the project opens as its work page (ADR 0013, MMR-467
 * refinement): Now, Needs you, Frontier, Shipped, and Going cold beside a rail
 * of Direction, About, and Artifacts. Its structure is the sidebar outline
 * (MMR-496).
 */
export function ProjectPage() {
  const { key } = projectRoute.useParams();
  const project = useQuery(projectQuery(key));
  // The doctor read counts findings; a miss only thins the page, so it does not
  // count toward connectivity.
  const health = useQuery(doctorQuery(key));
  const conn = connectivity([project]);
  useRememberRecord(
    project.data && { id: key, kind: 'project', project: key, title: project.data.title },
  );

  // Archived-404 semantics (ADR 0015): the server answered, so this is not
  // "offline"; the project query keeps polling, so an unarchive heals.
  if (isNotFound(project.error)) {
    return <ProjectUnavailablePage projectKey={key} />;
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

import { useQuery } from '@tanstack/react-query';

import { isNotFound } from '../api/errors';
import { doctorQuery, projectQuery, treeQuery } from '../api/queries';
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
 * of Direction, Structure, About, and Other views. The board is a view one
 * link away at `/p/$key/board`.
 */
export function ProjectPage() {
  const { key } = projectRoute.useParams();
  const project = useQuery(projectQuery(key));
  // The tree outlines the structure and the doctor read counts findings; a
  // miss on either only thins the page, so neither counts toward connectivity.
  // The tree is the whole board, so it is read once rather than polled, as on
  // the record pages; a console write invalidates it.
  const tree = useQuery({ ...treeQuery(key), refetchInterval: false });
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
        tree={tree.data}
        treeFailed={tree.isError}
        findings={health.data?.finding_total ?? 0}
        offline={conn.offline}
      />
    </>
  );
}

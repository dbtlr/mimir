import { useQuery } from '@tanstack/react-query';

import { doctorQuery } from '../api/browse-queries';
import { projectQuery } from '../api/node-queries';
import { ProjectDecisions } from '../components/decisions-walkthrough';
import { ProjectFrame } from '../components/project-frame';
import { ContainerDetails, WorkTab } from '../components/work-page';
import { useRememberRecord } from '../lib/recent-records';
import { useArchivedProject } from '../lib/use-archived-project';
import { projectRoute } from '../router';

/**
 * `/p/$key` — the project's Work and Details tabs (ADR 0013, MMR-467 and
 * MMR-726 refinements) inside the project's frame, which owns the header, the
 * tab row, and the unavailable and offline states. Work holds the progress
 * bar, Record health, and the work sections; `?tab=details` the Direction,
 * the description, and the dates.
 */
export function ProjectPage() {
  const { key } = projectRoute.useParams();
  const { mode, tab } = projectRoute.useSearch();
  // The frame reads the same record; an archived project's record 404s, so
  // once the archived list names the key, neither asks for it (ADR 0015).
  const archived = useArchivedProject(key);
  const project = useQuery({ ...projectQuery(key), enabled: archived === undefined });
  // The doctor read counts findings; a miss only thins the page, so it does not
  // count toward connectivity.
  const health = useQuery(doctorQuery(key));
  useRememberRecord(
    project.data && { id: key, kind: 'project', project: key, title: project.data.title },
  );
  const details = tab === 'details';
  const offline = project.isError;

  return (
    <ProjectFrame projectKey={key} tab={details ? 'details' : 'work'} reads={[]}>
      {mode === 'decisions' && <ProjectDecisions key={key} projectKey={key} />}
      {project.data !== undefined &&
        (details ? (
          <ContainerDetails record={project.data} />
        ) : (
          <WorkTab
            record={project.data}
            findings={health.data?.finding_total ?? 0}
            offline={offline}
          />
        ))}
    </ProjectFrame>
  );
}

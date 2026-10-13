import { useQuery } from '@tanstack/react-query';
import { Navigate } from '@tanstack/react-router';

import { projectsQuery } from '../api/queries';
import { useCurrentProjectKey } from '../lib/current-project';
import type { ArtifactsSearch, SeedsSearch, TasksSearch } from '../router';

/** A retired top-level browser and the filters its URL carried, less `project`. */
type Props =
  | { view: 'tasks'; search: TasksSearch }
  | { view: 'seeds'; search: SeedsSearch }
  | { view: 'artifacts'; search: ArtifactsSearch };

/**
 * A bare `/tasks`, `/seeds`, or `/artifacts` (MMR-495): the browser moved under
 * the project, so this goes to the current project's, keeping the filters. With
 * no project to name — the store has none — there is no browser to show, so it
 * goes to `/`, the review page, which is where a first project gets created.
 * It waits for the project list, so a remembered project that has since gone
 * is not followed; offline, where the list never arrives, it trusts the
 * remembered one.
 */
export function BrowserRedirect(props: Props) {
  const key = useCurrentProjectKey();
  const projects = useQuery(projectsQuery);
  if (projects.isPending && projects.fetchStatus !== 'paused') {
    return null;
  }
  if (key === undefined) {
    return <Navigate to="/" replace />;
  }
  switch (props.view) {
    case 'tasks': {
      return <Navigate to="/p/$key/tasks" params={{ key }} search={props.search} replace />;
    }
    case 'seeds': {
      return <Navigate to="/p/$key/seeds" params={{ key }} search={props.search} replace />;
    }
    case 'artifacts': {
      return <Navigate to="/p/$key/artifacts" params={{ key }} search={props.search} replace />;
    }
    default: {
      const _exhaustive: never = props;
      return _exhaustive;
    }
  }
}

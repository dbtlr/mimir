import type { EngineNode, TaskStatusWord } from '@mimir/contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';

import { taskTagsQuery, tasksBrowserQuery, tasksCountQuery } from '../../src/api/browse-queries';
import { projectQuery } from '../../src/api/node-queries';
import { browserTimeZone } from '../../src/api/queries';
import { archivedProjectsQuery } from '../../src/api/shell-queries';
import { PreviewRoomProvider } from '../../src/components/patterns/feed/preview-room';
import { taskListFilters } from '../../src/lib/task-list';
import { createConsoleRouter, tasksRoute } from '../../src/router';
import { ShellColumns } from '../../src/routes/shell';
import { engineProject } from '../../src/test/engine-fixtures';
import { engineTask } from '../../src/test/node-fixtures';

/** Titles long enough to wrap at a phone's width, so the groups run past a screen. */
const TITLES = [
  'List page layout and the Tasks presets',
  'Hold the seed archive lock inside the seed write',
  'One edit sheet for a record’s content and properties',
  'Give text-body its 1.65 line height, as DESIGN.md says',
  'Move the status parts into components/ui so patterns can draw a status',
  'A long preview title at large text on a short phone can crowd out the sheet’s footer',
];

/** The project's tags, most used first: more than the Tag field shows before "N more". */
const TAGS = ['ui', 'console', 'engine', 'a11y', 'perf', 'docs', 'cli', 'wire', 'spec'];

const STATUSES: TaskStatusWord[] = ['in_progress', 'under_review', 'staged'];

/** Six tasks in each in-flight status: three groups, each taller than a phone's screen. */
const TASKS: EngineNode[] = STATUSES.flatMap((status, group) =>
  TITLES.map((title, index) =>
    engineTask({
      home: { parentId: 'MMR-1', parentOpenEnded: null, parentTitle: 'Console', projectKey: 'MMR' },
      id: `MMR-${String(700 + group * 10 + index)}`,
      lifecycle: status === 'in_progress' ? 'in_progress' : 'todo',
      size: 'medium',
      status,
      title,
      updatedAt: new Date(Date.now() - (group * 10 + index) * 3_600_000),
    }),
  ),
);

const PROJECT = engineProject({
  description: 'Agent first project and task management system',
  id: 'MMR',
  leafCounts: { in_progress: 6, staged: 6, under_review: 6 },
  title: 'Mimir',
});

/**
 * A cache holding the reads `/p/MMR/tasks?show=in-flight` makes, which never
 * asks the host again: the project, the empty archive, the list, and the
 * Filter sheet's count and tags.
 */
function seededClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(projectQuery('MMR').queryKey, PROJECT);
  client.setQueryData(archivedProjectsQuery.queryKey, []);
  const filters = taskListFilters(
    { show: 'in-flight' },
    { project: 'MMR', zone: browserTimeZone() },
  );
  client.setQueryData(tasksBrowserQuery(filters).queryKey, {
    items: TASKS,
    returned: TASKS.length,
    startsAt: 0,
    total: TASKS.length,
  });
  // The Filter sheet's reads as it opens: its count, and more tags than it shows before "N more".
  client.setQueryData(tasksCountQuery(filters).queryKey, TASKS.length);
  client.setQueryData(taskTagsQuery(filters).queryKey, TAGS);
  return client;
}

const client = seededClient();

// The console's routes take their ids from the console's router, which the
// page's route hooks read; the harness then mounts the Tasks route under its own root.
createConsoleRouter();

const root = createRootRoute({
  component: () => (
    <PreviewRoomProvider>
      <div className="flex h-dvh flex-col overflow-hidden">
        <ShellColumns sidebar={undefined}>
          <Outlet />
        </ShellColumns>
      </div>
    </PreviewRoomProvider>
  ),
});

const router = createRouter({
  history: createMemoryHistory({ initialEntries: ['/p/MMR/tasks?show=in-flight'] }),
  routeTree: root.addChildren([tasksRoute]),
});

/**
 * The Tasks list over a seeded in-flight read, in the shell's frame, under a
 * memory router (e2e/list-page.test.ts).
 */
export function TasksPageHarness() {
  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

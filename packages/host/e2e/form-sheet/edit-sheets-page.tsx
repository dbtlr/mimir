import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { SeedFilterSheet } from '../../src/components/seed-filter-sheet';
import { TaskEditSheet } from '../../src/components/task-edit-sheet';
import { engineTree } from '../../src/test/engine-fixtures';
import { engineTask } from '../../src/test/node-fixtures';

const client = new QueryClient();

/** A todo task, so the edit sheet shows Grooming beside Size and Priority. */
const TODO = engineTask({
  grooming: 'not_groomed',
  id: 'MMR-417',
  parent: 'MMR-2',
  status: 'ready',
  title: 'Add the SQLite dialect',
});

/** The project's outline, for the Parent picker. The harness's host refuses every write, so a move fails. */
const TREE = engineTree({ id: 'MMR', status: 'in_progress', title: 'Mimir', type: 'project' }, [
  engineTree({ id: 'MMR-1', status: 'ready', title: 'Backends', type: 'initiative' }, [
    engineTree({ id: 'MMR-2', parent: 'MMR-1', status: 'ready', title: 'SQLite', type: 'phase' }),
  ]),
  engineTree({ id: 'MMR-3', status: 'ready', title: 'Console', type: 'initiative' }),
]);

const close = () => undefined;

/** The Seeds Filter or a task's edit sheet, open: the sheets that hold a `fit` Segmented track. */
export function EditSheetsPage({ sheet }: { sheet: 'seed-filter' | 'task-edit' }) {
  if (sheet === 'seed-filter') {
    return <SeedFilterSheet open onClose={close} seeds={[]} search={{}} onApply={close} />;
  }
  return (
    <QueryClientProvider client={client}>
      <TaskEditSheet open onClose={close} node={TODO} tree={TREE} />
    </QueryClientProvider>
  );
}

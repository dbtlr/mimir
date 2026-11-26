import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { SeedFilterSheet } from '../../src/components/seed-filter-sheet';
import { TaskEditSheet } from '../../src/components/task-edit-sheet';
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

const close = () => undefined;

/** The sheets that hold a `fit` Segmented track, open: the Seeds Filter's Show, or a task's edit sheet. */
export function FitTracksPage({ sheet }: { sheet: 'seed-filter' | 'task-edit' }) {
  if (sheet === 'seed-filter') {
    return <SeedFilterSheet open onClose={close} seeds={[]} search={{}} onApply={close} />;
  }
  return (
    <QueryClientProvider client={client}>
      <TaskEditSheet open onClose={close} node={TODO} tree={undefined} />
    </QueryClientProvider>
  );
}

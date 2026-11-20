// A page that opens the console's real Form sheet forms in Chromium, for the
// layout checks a DOM without layout cannot make (form-sheet-focus.test.ts).
import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import { ProjectForm } from '../../src/components/project-form';
import { T3LaunchForm } from '../../src/components/t3-launch-form';
import { reachableSystem } from '../../src/test/t3-fixtures';

const params = new URLSearchParams(globalThis.location.search);
const form = params.get('form') ?? 't3';
const theme = params.get('theme') ?? 'dark';
document.documentElement.dataset.theme = theme;

const PROJECT = {
  description: 'The work tool: tasks, the work hierarchy, and frozen artifacts.',
  id: 'MMR',
  title: 'Mimir',
};

function Harness() {
  const [open, setOpen] = useState(true);
  const close = () => {
    setOpen(false);
  };
  return (
    <main className="p-4">
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open
      </button>
      {form === 't3' ? (
        <T3LaunchForm
          open={open}
          taskId="MMR-743"
          taskTitle="Form sheet pattern"
          systems={[reachableSystem()]}
          remembered={null}
          onLaunch={close}
          onClose={close}
        />
      ) : (
        <ProjectForm
          mode="edit"
          open={open}
          onClose={close}
          project={PROJECT}
          onSave={() => Promise.resolve()}
          onArchive={close}
          archiving={false}
          offline={false}
        />
      )}
    </main>
  );
}

const root = document.getElementById('root');
if (root !== null) {
  createRoot(root).render(<Harness />);
}

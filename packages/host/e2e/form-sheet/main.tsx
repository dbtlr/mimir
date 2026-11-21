// A page that opens the console's real Form sheet forms, Notice, and
// Walkthrough in Chromium, for the layout checks a DOM without layout cannot
// make (form-sheet-focus.test.ts, walkthrough-layer.test.ts).
import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import { NoticeHost, toast } from '../../src/components/patterns/notice';
import {
  Walkthrough,
  WalkthroughBar,
  WalkthroughBody,
  WalkthroughChoices,
  WalkthroughHeading,
  WalkthroughNext,
  WalkthroughRow,
  WalkthroughBack,
} from '../../src/components/patterns/walkthrough';
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
  if (form === 'walkthrough') {
    return <WalkthroughPage />;
  }
  if (form === 'notice') {
    return (
      <>
        <button
          type="button"
          onClick={() => {
            toast.error('T3 opened a thread but could not finish the launch', {
              action: { label: 'Retry', onClick: () => undefined },
              cancel: { label: 'Open in T3', onClick: () => undefined },
            });
          }}
        >
          Show notice
        </button>
        <NoticeHost />
      </>
    );
  }
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
          taskTitle={params.get('taskTitle') ?? 'Form sheet pattern'}
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

const ANSWERS = [
  { label: 'Keep the rail', value: 'keep' },
  { detail: 'Drops the rail and its tests.', label: 'Remove it on desktop', value: 'remove' },
  { label: 'Something else', value: 'custom' },
];

/** A console page under a Walkthrough opened over it. */
function WalkthroughPage() {
  const [open, setOpen] = useState(true);
  const [answer, setAnswer] = useState('keep');
  return (
    <main className="p-4">
      <h1 className="text-page">The page beneath</h1>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && (
        <Walkthrough
          title="Deliver the console"
          progress="1 of 2"
          steps={{ count: 2, current: 0 }}
          closeLabel="Close the walkthrough"
          onClose={() => setOpen(false)}
          screen="first"
          aside={<nav aria-label="Decisions" className="w-[300px] max-md:hidden" />}
        >
          <WalkthroughBody>
            <WalkthroughHeading>Keep the rail beside the steps?</WalkthroughHeading>
            <WalkthroughChoices
              label="Your answer to MMR-q1"
              choices={ANSWERS}
              value={answer}
              onChange={setAnswer}
            />
          </WalkthroughBody>
          <WalkthroughBar>
            <WalkthroughRow>
              <WalkthroughBack disabled />
              <WalkthroughNext>Confirm and continue</WalkthroughNext>
            </WalkthroughRow>
          </WalkthroughBar>
        </Walkthrough>
      )}
    </main>
  );
}

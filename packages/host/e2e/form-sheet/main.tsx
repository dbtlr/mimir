// A page that opens the console's real Form sheet forms, Notice, and
// Walkthrough in Chromium, for the layout checks a DOM without layout cannot
// make (form-sheet-focus.test.ts, walkthrough-layer.test.ts).
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { NoticeHost, toast } from '../../src/components/patterns/notice';
import {
  Walkthrough,
  WalkthroughBack,
  WalkthroughBar,
  WalkthroughBarLine,
  WalkthroughBody,
  WalkthroughChoices,
  WalkthroughCommit,
  WalkthroughHeading,
  WalkthroughNext,
  WalkthroughNote,
  WalkthroughRow,
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

const QUESTIONS = ['Keep the rail beside the steps?', 'Group the refused answers?'];

/** The event a check dispatches on `window` to drop what the screen asks about, as a refresh would. */
const DROP_EVENT = 'walkthrough-drop';

/**
 * A console page under a Walkthrough opened over it: two questions, each with
 * answers and a note, then a check screen whose Send counts its writes in
 * the page's `data-writes`.
 */
function WalkthroughPage() {
  const [open, setOpen] = useState(true);
  const [step, setStep] = useState(0);
  const [answer, setAnswer] = useState('keep');
  const [note, setNote] = useState('');
  const [dropped, setDropped] = useState(false);
  const [writes, setWrites] = useState(0);
  useEffect(() => {
    const drop = () => {
      setDropped(true);
    };
    globalThis.addEventListener(DROP_EVENT, drop);
    return () => {
      globalThis.removeEventListener(DROP_EVENT, drop);
    };
  }, []);
  const onCheck = step === QUESTIONS.length;
  return (
    <main className="p-4" data-writes={writes}>
      <h1 className="text-page">The page beneath</h1>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && (
        <Walkthrough
          title="Deliver the console"
          progress={onCheck ? 'Check and send' : `${String(step + 1)} of 2`}
          steps={{ count: 3, current: step }}
          closeLabel="Close the walkthrough"
          onClose={() => setOpen(false)}
          screen={String(step)}
          aside={<nav aria-label="Decisions" className="w-[300px] max-md:hidden" />}
        >
          {onCheck ? (
            <>
              <WalkthroughBody>
                <WalkthroughHeading className="mb-3">Check your answers</WalkthroughHeading>
                <ul>
                  {QUESTIONS.slice(dropped ? 1 : 0).map((question) => (
                    <li key={question} className="flex justify-between gap-3 py-4">
                      <p className="text-pretty">{question}</p>
                      <button type="button" onClick={() => setStep(0)}>
                        Change
                      </button>
                    </li>
                  ))}
                </ul>
              </WalkthroughBody>
              <WalkthroughBar>
                <WalkthroughRow back={<WalkthroughBack onClick={() => setStep(step - 1)} />}>
                  <WalkthroughCommit
                    pendingLabel="Sending…"
                    onCommit={() => {
                      setWrites((count) => count + 1);
                    }}
                  >
                    Send 2 answers
                  </WalkthroughCommit>
                </WalkthroughRow>
              </WalkthroughBar>
            </>
          ) : (
            <>
              <WalkthroughBody>
                <WalkthroughHeading className="mb-3">{QUESTIONS[step]}</WalkthroughHeading>
                <p>It took Keep the rail and kept building.</p>
                {dropped ? (
                  <p role="status" className="mt-5">
                    This decision no longer waits on you
                  </p>
                ) : (
                  <WalkthroughChoices
                    label={`Your answer to MMR-q${String(step + 1)}`}
                    choices={ANSWERS}
                    value={answer}
                    onChange={setAnswer}
                  />
                )}
              </WalkthroughBody>
              <WalkthroughBar>
                <WalkthroughBarLine>Confirming changes nothing.</WalkthroughBarLine>
                <WalkthroughRow
                  back={<WalkthroughBack disabled={step === 0} onClick={() => setStep(step - 1)} />}
                  note={
                    !dropped && (
                      <WalkthroughNote
                        label="Add a note for the agent (optional)"
                        placeholder="Add a note for the agent (optional)"
                        value={note}
                        onChange={setNote}
                      />
                    )
                  }
                >
                  <WalkthroughNext onClick={() => setStep(step + 1)}>
                    {step === QUESTIONS.length - 1 ? 'Confirm and review' : 'Confirm and continue'}
                  </WalkthroughNext>
                </WalkthroughRow>
              </WalkthroughBar>
            </>
          )}
        </Walkthrough>
      )}
    </main>
  );
}

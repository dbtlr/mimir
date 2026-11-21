import { useState } from 'react';

import { ActionMenu } from '../components/patterns/action-menu';
import { Composer } from '../components/patterns/composer';
import { DestructiveConfirm } from '../components/patterns/destructive-confirm';
import {
  FormCheckRow,
  FormField,
  FormGroup,
  FormSheet,
  FormTextArea,
  FormTextInput,
} from '../components/patterns/form-sheet';
import { toast } from '../components/patterns/notice';
import { NoticeBanner } from '../components/patterns/notice-banner';
import { Reason } from '../components/patterns/reason';
import { RecordPicker } from '../components/patterns/record-picker';
import {
  Walkthrough,
  WalkthroughBack,
  WalkthroughBar,
  WalkthroughBody,
  WalkthroughChoices,
  WalkthroughCommit,
  WalkthroughHeading,
  WalkthroughNext,
  WalkthroughNote,
  WalkthroughRow,
} from '../components/patterns/walkthrough';
import { ActionButton } from '../components/ui/action-button';
import { Sample, Section } from './section';

/** The input patterns built on the overlay primitives (ADR 0019, MMR-736). */
export function PatternsKit() {
  return (
    <Section title="Patterns">
      <DestructiveConfirmSample />
      <ReasonSample label="reason · optional" required={false} commit="Park" />
      <ReasonSample label="reason · required" required commit="Reject" />
      <ReasonSample
        label="reason · destructive commit"
        required
        commit="Abandon delivery"
        destructive
      />
      <TwoCommitSample />
      <ActionMenuSample />
      <NoticeSample />
      <FormSheetSample />
      <RecordPickerSample />
      <ComposerSample />
      <WalkthroughSample />
    </Section>
  );
}

function DestructiveConfirmSample() {
  const [open, setOpen] = useState(false);
  return (
    <Sample label="destructive confirm">
      <ActionButton variant="destructiveOutline" onClick={() => setOpen(true)}>
        Unpair valhalla
      </ActionButton>
      <DestructiveConfirm
        open={open}
        onClose={() => setOpen(false)}
        title="Unpair valhalla?"
        commitLabel="Unpair valhalla"
        onConfirm={() => setOpen(false)}
      >
        Its token stops working now, and any waiting request is discarded.
      </DestructiveConfirm>
    </Sample>
  );
}

function ReasonSample({
  label,
  required,
  commit,
  destructive = false,
}: {
  label: string;
  required: boolean;
  commit: string;
  destructive?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Sample label={label}>
      <ActionButton variant="outline" onClick={() => setOpen(true)}>
        {commit}…
      </ActionButton>
      <Reason
        open={open}
        onClose={() => setOpen(false)}
        title={`${commit} MMR-219`}
        required={required}
        commits={[
          {
            label: commit,
            onCommit: () => undefined,
            variant: destructive ? 'destructiveOutline' : undefined,
          },
        ]}
      />
    </Sample>
  );
}

function TwoCommitSample() {
  const [open, setOpen] = useState(false);
  return (
    <Sample label="reason · two commits (decision note)">
      <ActionButton variant="outline" onClick={() => setOpen(true)}>
        Note…
      </ActionButton>
      <Reason
        open={open}
        onClose={() => setOpen(false)}
        title="Answer MMR-q1"
        description="Keep the rail, or drop it?"
        label="Note (required)"
        placeholder=""
        required
        commits={[
          { label: 'Confirm with note', onCommit: () => undefined, variant: 'outline' },
          { label: 'Answer with note', onCommit: () => undefined, variant: 'outline' },
        ]}
      />
    </Sample>
  );
}

function ActionMenuSample() {
  const [theme, setTheme] = useState('dark');
  return (
    <Sample label="action menu · a menu from md up, a bottom sheet below it (resize to see both)">
      <ActionMenu
        title="Android · Chrome"
        description="delivered 1d ago"
        trigger={
          <ActionButton variant="outline" aria-label="More">
            More
          </ActionButton>
        }
        entries={[
          { key: 'settings', kind: 'action', label: 'Choose what notifies…' },
          { key: 'test', kind: 'action', label: 'Send test notification' },
          { key: 'sep', kind: 'separator' },
          {
            key: 'theme',
            kind: 'choice',
            label: 'Theme',
            onChange: setTheme,
            options: [
              { label: 'Dark', value: 'dark' },
              { label: 'Light', value: 'light' },
            ],
            value: theme,
          },
          { key: 'sep2', kind: 'separator' },
          { destructive: true, key: 'remove', kind: 'action', label: 'Remove this browser' },
        ]}
      />
    </Sample>
  );
}

function NoticeSample() {
  return (
    <>
      <Sample label="notice · toast, with Undo or Retry">
        <ActionButton
          variant="outline"
          onClick={() => {
            toast('Archived Mimir', { action: { label: 'Undo', onClick: () => undefined } });
          }}
        >
          Archived (Undo)
        </ActionButton>
        <ActionButton
          variant="outline"
          onClick={() => {
            toast.error("Couldn't save the reason", {
              action: { label: 'Retry', onClick: () => undefined },
            });
          }}
        >
          Failed (Retry)
        </ActionButton>
      </Sample>
      <Sample label="notice · banner, a standing state">
        <div className="flex w-full flex-col gap-2">
          <NoticeBanner action={{ label: 'Refresh now', onClick: () => undefined }}>
            A new version is ready.
          </NoticeBanner>
          <NoticeBanner tone="blocked">Offline — last synced 3m ago</NoticeBanner>
        </div>
      </Sample>
    </>
  );
}

function FormSheetSample() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [plan, setPlan] = useState(false);
  return (
    <Sample label="form sheet · full screen on a phone, 640 panel from md">
      <ActionButton variant="outline" onClick={() => setOpen(true)}>
        New project…
      </ActionButton>
      <FormSheet
        open={open}
        onClose={() => setOpen(false)}
        title="New project"
        note="Joins the project list on the review page."
        commitLabel="Create project"
        commitDisabled={title.trim() === ''}
        onCommit={() => undefined}
      >
        <FormField label="Title">
          <FormTextInput value={title} onChange={(event) => setTitle(event.target.value)} />
        </FormField>
        <FormField label="Key" help="It can’t change later: it names every ID.">
          <FormTextInput className="w-32 font-mono" />
        </FormField>
        <FormField label="Description" optional>
          <FormTextArea />
        </FormField>
        <FormGroup title="Advanced" collapsible>
          <FormCheckRow label="Plan first" checked={plan} onCheckedChange={setPlan} />
        </FormGroup>
      </FormSheet>
    </Sample>
  );
}

const KIT_PROJECTS = [
  { id: 'MMR', title: 'Mimir' },
  { id: 'NRN', title: 'Norn' },
  { id: 'MUN', title: 'Muninn' },
];

function RecordPickerSample() {
  const [project, setProject] = useState<string | null>('MMR');
  return (
    <Sample label="record picker · a form's project field">
      <div className="w-full max-w-[576px]">
        <RecordPicker
          label="Project"
          records={KIT_PROJECTS}
          value={project}
          onValueChange={setProject}
          placeholder="Choose a project…"
          searchLabel="Find a project"
          emptyText="No projects match."
        />
      </div>
    </Sample>
  );
}

/** A promise that resolves after a moment, as a host call would, so the kit shows the pending state. */
function settleSoon(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 1200);
  return promise;
}

function ComposerSample() {
  return (
    <Sample label="composer · inline, one line growing to four; Append waits for text">
      <div className="w-full max-w-[576px]">
        <Composer
          label="Add a note"
          placeholder="Add a note…"
          commitLabel="Append"
          commitName="Append note"
          onCommit={() => settleSoon()}
        />
      </div>
    </Sample>
  );
}

const KIT_STEPS = [
  {
    choices: [
      { label: 'Keep the rail', value: 'keep' },
      {
        detail: 'Drops the rail and its tests; the phone keeps its segmented bar.',
        label: 'Remove it on desktop',
        value: 'remove',
      },
      { label: 'Something else', value: 'custom' },
    ],
    question: 'Keep the rail beside the steps?',
  },
  {
    choices: [
      { label: 'Yes, under their own heading', value: 'yes' },
      { label: 'No, mixed in with the rest', value: 'no' },
    ],
    question: 'Group the refused answers?',
  },
];

function WalkthroughSample() {
  const [open, setOpen] = useState(false);
  return (
    <Sample label="walkthrough · a Dialog over the whole console at every width; arrow keys move the answer">
      <ActionButton variant="outline" onClick={() => setOpen(true)}>
        Review 2 decisions
      </ActionButton>
      {open && <KitWalkthrough onClose={() => setOpen(false)} />}
    </Sample>
  );
}

/** Two questions, then a Send that takes a moment, as a write would. */
function KitWalkthrough({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState(['keep', 'yes']);
  const [note, setNote] = useState('');
  const current = KIT_STEPS[step]!;
  const last = step === KIT_STEPS.length - 1;
  return (
    <Walkthrough
      title={
        <>
          <span className="min-w-0 truncate">Deliver the console</span>{' '}
          <span className="shrink-0 font-mono text-meta font-normal whitespace-nowrap text-ink-dim">
            MMR-d3
          </span>
        </>
      }
      progress={`${String(step + 1)} of ${String(KIT_STEPS.length)}`}
      steps={{ count: KIT_STEPS.length, current: step }}
      closeLabel="Close the walkthrough"
      onClose={onClose}
      screen={String(step)}
    >
      <WalkthroughBody>
        <WalkthroughHeading className="mb-3">{current.question}</WalkthroughHeading>
        <WalkthroughChoices
          label={`Your answer to MMR-q${String(step + 1)}`}
          choices={current.choices}
          value={answers[step]!}
          onChange={(value) =>
            setAnswers((all) => all.map((answer, index) => (index === step ? value : answer)))
          }
        />
      </WalkthroughBody>
      <WalkthroughBar>
        <p className="text-meta text-ink-dim">Confirming changes nothing.</p>
        <WalkthroughRow>
          <WalkthroughBack disabled={step === 0} onClick={() => setStep(step - 1)} />
          <WalkthroughNote
            label="Add a note for the agent (optional)"
            placeholder="Add a note for the agent (optional)"
            value={note}
            onChange={setNote}
            className="max-md:order-first max-md:col-span-2"
          />
          {last ? (
            <WalkthroughCommit
              onCommit={async () => {
                await settleSoon();
                onClose();
              }}
            >
              Confirm and send
            </WalkthroughCommit>
          ) : (
            <WalkthroughNext onClick={() => setStep(step + 1)}>
              Confirm and continue
            </WalkthroughNext>
          )}
        </WalkthroughRow>
      </WalkthroughBar>
    </Walkthrough>
  );
}

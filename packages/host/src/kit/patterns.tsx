import { useState } from 'react';

import { ActionMenu } from '../components/patterns/action-menu';
import { DestructiveConfirm } from '../components/patterns/destructive-confirm';
import { toast } from '../components/patterns/notice';
import { NoticeBanner } from '../components/patterns/notice-banner';
import { Reason } from '../components/patterns/reason';
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

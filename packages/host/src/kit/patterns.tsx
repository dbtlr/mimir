import { useState } from 'react';

import { DestructiveConfirm } from '../components/patterns/destructive-confirm';
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

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { DestructiveConfirm } from '../components/patterns/destructive-confirm';
import { Reason } from '../components/patterns/reason';
import { ActionButton } from '../components/ui/action-button';

/*
 * Where focus goes when a dialog closes. One dialog opened from two controls,
 * as useNodeVerbs opens one Reason from its verb chips: each opening returns
 * focus to the control that opened it.
 */

type Kind = 'confirm' | 'reason';

/** Two openers of one dialog. With `blockOffOnCommit`, a commit disables the Block… opener. */
function TwoOpeners({
  kind,
  blockOffOnCommit = false,
}: {
  kind: Kind;
  blockOffOnCommit?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [blockOff, setBlockOff] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <ActionButton onClick={() => setOpen(true)}>Park…</ActionButton>
      <ActionButton disabled={blockOff} onClick={() => setOpen(true)}>
        Block…
      </ActionButton>
      {kind === 'confirm' ? (
        <DestructiveConfirm
          open={open}
          onClose={close}
          title="Remove it?"
          commitLabel="Commit"
          onConfirm={async () => {
            setBlockOff(blockOffOnCommit);
          }}
        >
          It cannot be undone.
        </DestructiveConfirm>
      ) : (
        <Reason
          open={open}
          onClose={close}
          title="Park it"
          commits={[
            {
              label: 'Commit',
              onCommit: () => {
                setBlockOff(blockOffOnCommit);
              },
            },
          ]}
        />
      )}
    </>
  );
}

const role = { confirm: 'alertdialog', reason: 'dialog' } as const;

async function openFrom(kind: Kind, opener: string) {
  await userEvent.click(screen.getByRole('button', { name: opener }));
  return screen.findByRole(role[kind]);
}

async function closed(kind: Kind) {
  await waitFor(() => expect(screen.queryByRole(role[kind])).toBeNull());
}

describe.each(['confirm', 'reason'] as const)('%s opened from two controls', (kind) => {
  it('returns focus on Escape to the control that opened each opening', async () => {
    render(<TwoOpeners kind={kind} />);
    for (const opener of ['Park…', 'Block…', 'Park…']) {
      await openFrom(kind, opener);
      await userEvent.keyboard('{Escape}');
      await closed(kind);
      expect(screen.getByRole('button', { name: opener })).toHaveFocus();
    }
  });

  it('returns focus after a successful commit to the control that opened each opening', async () => {
    render(<TwoOpeners kind={kind} />);
    for (const opener of ['Park…', 'Block…', 'Park…']) {
      const dialog = await openFrom(kind, opener);
      await userEvent.click(within(dialog).getByRole('button', { name: 'Commit' }));
      await closed(kind);
      expect(screen.getByRole('button', { name: opener })).toHaveFocus();
    }
  });

  it('does not return focus to an opener the commit disabled', async () => {
    render(<TwoOpeners kind={kind} blockOffOnCommit />);
    await openFrom(kind, 'Park…');
    await userEvent.keyboard('{Escape}');
    await closed(kind);
    const dialog = await openFrom(kind, 'Block…');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Commit' }));
    await closed(kind);
    const block = screen.getByRole('button', { name: 'Block…' });
    expect(block).toBeDisabled();
    expect(block).not.toHaveFocus();
  });
});

function OneOpener() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ActionButton onClick={() => setOpen(true)}>Park…</ActionButton>
      <Reason
        open={open}
        onClose={() => setOpen(false)}
        title="Park it"
        commits={[{ label: 'Park', onCommit: () => undefined }]}
      />
    </>
  );
}

describe('a successful Reason commit', () => {
  it('returns focus to its opener, not the page', async () => {
    render(<OneOpener />);
    await userEvent.click(screen.getByRole('button', { name: 'Park…' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Park' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole('button', { name: 'Park…' })).toHaveFocus();
  });
});

/**
 * A Destructive confirm its caller mounts already open, as the stop confirm is:
 * no trigger belongs to it, so only `finalFocus` knows its opener. `Disable`
 * disables the opener while the confirm is open.
 */
function MountedOpen() {
  const [open, setOpen] = useState(false);
  const [off, setOff] = useState(false);
  return (
    <>
      <ActionButton disabled={off} onClick={() => setOpen(true)}>
        Stop…
      </ActionButton>
      <ActionButton onClick={() => undefined}>Next</ActionButton>
      {open && (
        <DestructiveConfirm
          open
          onClose={() => setOpen(false)}
          title="Stop it?"
          commitLabel="Stop"
          onConfirm={async () => {
            setOff(true);
          }}
        >
          It cannot be undone.
        </DestructiveConfirm>
      )}
    </>
  );
}

describe('a Destructive confirm mounted already open', () => {
  it('returns focus to its opener on Escape', async () => {
    render(<MountedOpen />);
    await userEvent.click(screen.getByRole('button', { name: 'Stop…' }));
    await screen.findByRole('alertdialog');
    await userEvent.keyboard('{Escape}');
    await closed('confirm');
    expect(screen.getByRole('button', { name: 'Stop…' })).toHaveFocus();
  });

  it('does not return focus to an opener disabled by the time it closes', async () => {
    render(<MountedOpen />);
    await userEvent.click(screen.getByRole('button', { name: 'Stop…' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop' }));
    await closed('confirm');
    const opener = screen.getByRole('button', { name: 'Stop…' });
    expect(opener).toBeDisabled();
    expect(opener).not.toHaveFocus();
  });
});

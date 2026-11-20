import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { DestructiveConfirm } from '../components/patterns/destructive-confirm';
import { Reason } from '../components/patterns/reason';
import type { ReasonCommit } from '../components/patterns/reason';
import { ActionButton } from '../components/ui/action-button';

/** A page with an opener, so focus return has somewhere to land. */
function ConfirmHarness({ onConfirm }: { onConfirm: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ActionButton onClick={() => setOpen(true)}>Open</ActionButton>
      <DestructiveConfirm
        open={open}
        onClose={() => setOpen(false)}
        title="Remove it?"
        commitLabel="Remove"
        onConfirm={onConfirm}
      >
        It cannot be undone.
      </DestructiveConfirm>
    </>
  );
}

function ReasonHarness({
  commits,
  required = false,
}: {
  commits: ReasonCommit[];
  required?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ActionButton onClick={() => setOpen(true)}>Open</ActionButton>
      <Reason
        open={open}
        onClose={() => setOpen(false)}
        title="Park it"
        label="Reason"
        placeholder="Say why"
        required={required}
        commits={commits}
      />
    </>
  );
}

/** A promise a test settles by hand. */
const deferred = () => Promise.withResolvers<void>();

/** A confirm that already holds an answer in place of its question. */
function Answered() {
  return (
    <DestructiveConfirm
      open
      onClose={() => undefined}
      title="Stop it?"
      commitLabel="Stop"
      answer="Already finishing."
      onConfirm={() => undefined}
    >
      Question text.
    </DestructiveConfirm>
  );
}

describe('DestructiveConfirm', () => {
  it('opens an alert dialog on Cancel and returns focus to the opener on Escape', async () => {
    const onConfirm = vi.fn();
    render(<ConfirmHarness onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove it?' });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(dialog).toHaveTextContent('It cannot be undone.');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('carries the red hairline on its commit and calls onConfirm once', async () => {
    const onConfirm = vi.fn();
    render(<ConfirmHarness onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const commit = within(await screen.findByRole('alertdialog')).getByRole('button', {
      name: 'Remove',
    });
    expect(commit.className).toContain('inset-ring-status-blocked');
    await userEvent.click(commit);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('blocks a second commit and holds the dialog open while the call is pending, then closes', async () => {
    const call = deferred();
    const onConfirm = vi.fn(() => call.promise);
    render(<ConfirmHarness onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(within(dialog).getByRole('button', { name: 'Remove' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    call.resolve();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('stays open when the call fails, with the commit enabled again', async () => {
    const onConfirm = vi.fn().mockRejectedValueOnce(new Error('refused'));
    render(<ConfirmHarness onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Remove' })).toBeEnabled(),
    );
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('shows an answer in place of the question, with one Close that takes focus', async () => {
    render(<Answered />);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Already finishing.');
    expect(dialog).not.toHaveTextContent('Question text.');
    expect(within(dialog).queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();
  });
});

describe('Reason', () => {
  it('opens on the text box, and returns focus to the opener on Escape', async () => {
    render(<ReasonHarness commits={[{ label: 'Park', onCommit: vi.fn() }]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog', { name: 'Park it' });
    expect(within(dialog).getByRole('textbox', { name: 'Reason' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus();
  });

  it('commits an empty optional reason, and a trimmed one when typed, then closes', async () => {
    const onCommit = vi.fn();
    render(<ReasonHarness commits={[{ label: 'Park', onCommit }]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Park' }),
    );
    expect(onCommit).toHaveBeenLastCalledWith('');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('textbox')).toHaveValue('');
    await userEvent.type(within(dialog).getByRole('textbox'), '  later  ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Park' }));
    expect(onCommit).toHaveBeenLastCalledWith('later');
  });

  it('keeps every commit disabled until a required reason is non-blank', async () => {
    const onCommit = vi.fn();
    render(
      <ReasonHarness
        required
        commits={[
          { label: 'Confirm with note', onCommit },
          { label: 'Answer with note', onCommit },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog');
    const first = within(dialog).getByRole('button', { name: 'Confirm with note' });
    const second = within(dialog).getByRole('button', { name: 'Answer with note' });
    expect(first).toBeDisabled();
    expect(second).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox'), '   ');
    expect(first).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox'), 'why');
    expect(second).toBeEnabled();
    await userEvent.click(second);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('why');
  });

  it('styles a destructive commit with the red hairline', async () => {
    render(
      <ReasonHarness
        commits={[{ label: 'Abandon', onCommit: vi.fn(), variant: 'destructiveOutline' }]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const commit = within(await screen.findByRole('dialog')).getByRole('button', {
      name: 'Abandon',
    });
    expect(commit.className).toContain('inset-ring-status-blocked');
  });

  it('holds the dialog while a commit is pending and blocks a second one', async () => {
    const call = deferred();
    const onCommit = vi.fn(() => call.promise);
    render(<ReasonHarness commits={[{ label: 'Park', onCommit }]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog');
    const commit = within(dialog).getByRole('button', { name: 'Park' });
    await userEvent.click(commit);
    expect(commit).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    call.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it('keeps the dialog and the text when a commit fails, and focuses the commit again', async () => {
    const onCommit = vi.fn().mockRejectedValueOnce(new Error('refused'));
    render(<ReasonHarness required commits={[{ label: 'Park', onCommit }]} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'Wait for access');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Park' }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Park' })).toHaveFocus());
    expect(within(dialog).getByRole('textbox')).toHaveValue('Wait for access');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Reason } from '../components/patterns/reason';
import type { DialogContent } from '../components/ui/dialog';

/*
 * In a browser a Reason dialog reopened during its exit transition keeps its
 * content mounted; jsdom has no transition, so it unmounts at once. Keeping the
 * content mounted while closed reproduces that path here.
 */
vi.mock('../components/ui/dialog', async (importOriginal) => {
  const original = await importOriginal<{ DialogContent: typeof DialogContent }>();
  return {
    ...original,
    DialogContent: (props: ComponentProps<typeof original.DialogContent>) => (
      <original.DialogContent keepMounted {...props} />
    ),
  };
});

function Reopenable({ onCommit }: { onCommit: (text: string) => Promise<void> | undefined }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        Force close
      </button>
      <Reason
        open={open}
        onClose={() => setOpen(false)}
        title="Park it"
        commits={[{ label: 'Park', onCommit }]}
      />
    </>
  );
}

describe('Reason reopened while its content stayed mounted', () => {
  it('starts the new opening clear: an empty box, and a commit that runs', async () => {
    const calls = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    let next = 0;
    const onCommit = vi.fn(() => {
      const call = calls[next];
      next += 1;
      return call?.promise;
    });
    render(<Reopenable onCommit={onCommit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const first = await screen.findByRole('dialog');
    const box = within(first).getByRole('textbox');
    fireEvent.change(box, { target: { value: 'first try' } });
    fireEvent.click(within(first).getByRole('button', { name: 'Park' }));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('first try');
    fireEvent.click(screen.getByRole('button', { name: 'Force close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('textbox')).toHaveValue('');
    const park = within(dialog).getByRole('button', { name: 'Park' });
    await waitFor(() => expect(park).toBeEnabled());
    fireEvent.click(park);
    expect(onCommit).toHaveBeenCalledTimes(2);
    await act(async () => {
      calls[1]!.resolve();
      await calls[1]!.promise;
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

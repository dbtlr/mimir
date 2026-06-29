import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, vi } from 'vitest';

import { ReasonDialog } from '../components/reason-dialog';

describe('reasonDialog', () => {
  it('confirms with the typed reason', async () => {
    const onConfirm = vi.fn();
    render(<ReasonDialog verb="park" open onClose={vi.fn()} onConfirm={onConfirm} />);
    await userEvent.type(await screen.findByRole('textbox'), 'waiting on review');
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledWith('waiting on review');
  });

  it('confirms with empty reason when none typed (optional)', async () => {
    const onConfirm = vi.fn();
    render(<ReasonDialog verb="abandon" open onClose={vi.fn()} onConfirm={onConfirm} />);
    await userEvent.click(await screen.findByRole('button', { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledWith('');
  });
});

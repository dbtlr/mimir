import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, vi } from 'vitest';

import { create } from '../api/fns/shell';
import { NewProjectSheet } from '../components/new-project-sheet';
import { engineProject } from './engine-fixtures';

vi.mock('../api/fns/shell');
const { toast } = vi.hoisted(() => ({ toast: { error: vi.fn() } }));
vi.mock('../components/patterns/notice', () => ({ toast }));

afterEach(() => {
  vi.clearAllMocks();
});

function wrap() {
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NewProjectSheet open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return onOpenChange;
}

/** A page whose button opens the sheet, as the project picker's "+ New project" does. */
function Opener() {
  const [open, setOpen] = useState(false);
  return (
    <QueryClientProvider client={new QueryClient()}>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        New project
      </button>
      <NewProjectSheet open={open} onOpenChange={setOpen} />
    </QueryClientProvider>
  );
}

describe('newProjectSheet (MMR-230)', () => {
  it('reopens empty after Escape abandons its edits', async () => {
    const user = userEvent.setup();
    render(<Opener />);
    await user.click(screen.getByRole('button', { name: 'New project' }));
    await user.type(await screen.findByLabelText(/title/i), 'Signal relay');
    await user.type(screen.getByLabelText(/description/i), 'Cross-site relay');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await user.click(screen.getByRole('button', { name: 'New project' }));
    await expect(screen.findByLabelText(/title/i)).resolves.toHaveValue('');
    expect(screen.getByLabelText(/key/i)).toHaveValue('');
    expect(screen.getByLabelText(/description/i)).toHaveValue('');
  });

  it('focuses the title field on open', async () => {
    wrap();
    await waitFor(() => {
      expect(screen.getByLabelText(/title/i)).toHaveFocus();
    });
  });

  it('auto-derives the key from the title and updates the permanence helper', () => {
    wrap();
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Signal relay' } });
    expect(screen.getByLabelText(/key/i)).toHaveValue('SR');
    expect(screen.getByText('SR-1')).toBeInTheDocument();
    expect(screen.getByText('SR-2')).toBeInTheDocument();
  });

  it('an edited key stops tracking the title; clearing it resumes', () => {
    wrap();
    const key = screen.getByLabelText(/key/i);
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Signal relay' } });
    fireEvent.change(key, { target: { value: 'SRL' } });
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Other name' } });
    expect(key).toHaveValue('SRL');
    fireEvent.change(key, { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Signal relay' } });
    expect(key).toHaveValue('SR');
  });

  it('disables Create while the title is empty', () => {
    wrap();
    expect(screen.getByRole('button', { name: /create/i })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Signal relay' } });
    expect(screen.getByRole('button', { name: /create/i })).toBeEnabled();
  });

  it('submitting creates { key, name, description } and closes the sheet', async () => {
    vi.mocked(create).mockResolvedValue(engineProject({ id: 'SR' }));
    const onOpenChange = wrap();
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Signal relay' } });
    fireEvent.change(screen.getByLabelText(/description/i), {
      target: { value: 'Cross-site relay' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    await waitFor(() => {
      expect(create).toHaveBeenCalledWith({
        data: {
          description: 'Cross-site relay',
          key: 'SR',
          name: 'Signal relay',
          type: 'project',
        },
      });
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('omits an empty description from the body', async () => {
    vi.mocked(create).mockResolvedValue(engineProject({ id: 'SR' }));
    wrap();
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Signal relay' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    await waitFor(() => {
      expect(create).toHaveBeenCalledWith({
        data: { key: 'SR', name: 'Signal relay', type: 'project' },
      });
    });
  });

  it('a server rejection toasts and keeps the sheet open with its values', async () => {
    vi.mocked(create).mockRejectedValue(new Error('project SR already exists'));
    const onOpenChange = wrap();
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Signal relay' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('project SR already exists');
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/title/i)).toHaveValue('Signal relay');
    expect(screen.getByLabelText(/key/i)).toHaveValue('SR');
  });
});

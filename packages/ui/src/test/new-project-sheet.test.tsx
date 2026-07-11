import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, vi } from 'vitest';

import { NewProjectSheet } from '../components/new-project-sheet';

const { apiSend } = vi.hoisted(() => ({ apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiSend }));
const { toast } = vi.hoisted(() => ({ toast: { error: vi.fn() } }));
vi.mock('sonner', () => ({ toast }));

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

describe('newProjectSheet (MMR-230)', () => {
  it('renders title, key, optional description, and the footer note', () => {
    wrap();
    expect(screen.getByLabelText(/title/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/key/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/description/i)).toBeInTheDocument();
    expect(screen.getByText(/lands in At rest until work starts moving/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create/i })).toBeInTheDocument();
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

  it('submitting posts { key, name, description } and closes the sheet', async () => {
    apiSend.mockResolvedValue({ id: 'SR' });
    const onOpenChange = wrap();
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Signal relay' } });
    fireEvent.change(screen.getByLabelText(/description/i), {
      target: { value: 'Cross-site relay' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/projects', {
        description: 'Cross-site relay',
        key: 'SR',
        name: 'Signal relay',
      });
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('omits an empty description from the body', async () => {
    apiSend.mockResolvedValue({ id: 'SR' });
    wrap();
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Signal relay' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/projects', {
        key: 'SR',
        name: 'Signal relay',
      });
    });
  });

  it('a server rejection toasts and keeps the sheet open with its values', async () => {
    apiSend.mockRejectedValue(new Error('project SR already exists'));
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

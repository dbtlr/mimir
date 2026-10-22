import { render, screen } from '@testing-library/react';
import { describe, expect, vi } from 'vitest';

import { lazySheet } from '../components/lazy-sheet';

function Sheet({ open }: { open: boolean }) {
  return <p>{open ? 'sheet open' : 'sheet closed'}</p>;
}

describe('lazySheet (MMR-583)', () => {
  it('does not load the sheet while it has never opened', () => {
    const load = vi.fn(async () => Sheet);
    const LazySheet = lazySheet(load);
    render(<LazySheet open={false} />);
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByText(/sheet/)).not.toBeInTheDocument();
  });

  it('loads and renders the sheet when it opens', async () => {
    const LazySheet = lazySheet(async () => Sheet);
    const { rerender } = render(<LazySheet open={false} />);
    rerender(<LazySheet open />);
    await expect(screen.findByText('sheet open')).resolves.toBeInTheDocument();
  });

  it('keeps the sheet mounted after it closes, so the close can animate', async () => {
    const load = vi.fn(async () => Sheet);
    const LazySheet = lazySheet(load);
    const { rerender } = render(<LazySheet open />);
    await screen.findByText('sheet open');
    rerender(<LazySheet open={false} />);
    expect(screen.getByText('sheet closed')).toBeInTheDocument();
    rerender(<LazySheet open />);
    expect(screen.getByText('sheet open')).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });
});

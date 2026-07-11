import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { archivedUndoToast } from '../components/archive-undo-toast';

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

describe('archivedUndoToast (MMR-125)', () => {
  it('toasts `Archived <title>` with an Unarchive action wired to the callback', () => {
    const onUnarchive = vi.fn();
    archivedUndoToast('Meridian console', onUnarchive);

    expect(toast).toHaveBeenCalledOnce();
    const [message, opts] = toast.mock.calls[0] as [
      ReactNode,
      { action: { label: string; onClick: () => void } },
    ];
    render(<>{message}</>);
    expect(screen.getByText(/Archived/)).toBeDefined();
    expect(screen.getByText('Meridian console')).toBeDefined();

    expect(opts.action.label).toBe('Unarchive');
    opts.action.onClick();
    expect(onUnarchive).toHaveBeenCalledOnce();
  });
});

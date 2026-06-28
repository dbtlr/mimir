import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';

import { TransitionMenu } from '../components/transition-menu';

const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock('../api/mutations', () => ({
  useTransition: () => ({ mutate }),
}));

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

describe('transitionMenu', () => {
  it('a terminal status offers reopen (MMR-104)', async () => {
    render(<TransitionMenu node={{ id: 'MMR-9', status: 'done' }} />, { wrapper });
    await userEvent.click(screen.getByLabelText('Actions'));
    await expect(screen.findByRole('menuitem', { name: 'Reopen' })).resolves.toBeDefined();
  });

  it('immediate verb fires the mutation directly', async () => {
    render(<TransitionMenu node={{ id: 'MMR-9', status: 'ready' }} />, { wrapper });
    await userEvent.click(screen.getByLabelText('Actions'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Start' }));
    expect(mutate).toHaveBeenCalledWith({ verb: 'start' });
  });

  it('reason verb opens the dialog, then mutates with the reason', async () => {
    render(<TransitionMenu node={{ id: 'MMR-9', status: 'ready' }} />, { wrapper });
    await userEvent.click(screen.getByLabelText('Actions'));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Park' }));
    await userEvent.type(await screen.findByRole('textbox'), 'later');
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(mutate).toHaveBeenCalledWith({ verb: 'park', reason: 'later' });
  });

  it('disabled hides the trigger action', () => {
    render(<TransitionMenu node={{ id: 'MMR-9', status: 'ready' }} disabled />, { wrapper });
    expect(screen.getByLabelText('Actions')).toHaveProperty('disabled', true);
  });
});

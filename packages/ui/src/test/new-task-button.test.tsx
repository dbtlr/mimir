import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, vi } from 'vitest';

import { NewTaskButton } from '../components/new-task-button';
import { project } from './fixtures';

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

function wrap(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { refetchInterval: false, retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('newTaskButton', () => {
  it('is disabled when offline', () => {
    wrap(<NewTaskButton projectKey="MMR" offline />);
    expect(screen.getByRole('button', { name: /new task/i })).toBeDisabled();
  });

  it('is enabled when online', () => {
    wrap(<NewTaskButton projectKey="MMR" offline={false} />);
    expect(screen.getByRole('button', { name: /new task/i })).toBeEnabled();
  });

  it('opens the authoring sheet (MMR-227), replacing the retired TaskForm create path', async () => {
    apiGet.mockImplementation((path: string) =>
      path === '/api/projects'
        ? Promise.resolve({ items: [project({ id: 'MMR', title: 'Mimir' })], total: 1 })
        : Promise.resolve({ children: [], id: 'MMR', title: 'Mimir', type: 'project' }),
    );
    const user = userEvent.setup();
    wrap(<NewTaskButton projectKey="MMR" offline={false} />);
    await user.click(screen.getByRole('button', { name: /new task/i }));
    await expect(screen.findByRole('radio', { name: 'Task' })).resolves.toBeChecked();
    expect(screen.getByText('Signals · optional')).toBeInTheDocument();
  });
});

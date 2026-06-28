import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, test } from 'vitest';

import { NewTaskButton } from '../components/new-task-button';

function wrap(ui: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
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
});

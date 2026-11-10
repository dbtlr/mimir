import { render, screen } from '@testing-library/react';
import { describe, expect, vi } from 'vitest';

import { TaskForm } from '../components/task-form';

describe('taskForm', () => {
  it('prefills from initial', () => {
    render(
      <TaskForm
        initial={{ priority: 'p1', title: 'existing' }}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByLabelText(/title/i)).toHaveValue('existing');
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
  });

  it('submitting=true disables the save button even with a title present', async () => {
    render(
      <TaskForm
        initial={{ title: 'existing' }}
        submitting
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    // Wait for reactive state to settle
    await vi.waitFor(() => expect(screen.getByRole('button', { name: /save/i })).toBeDisabled());
  });
});

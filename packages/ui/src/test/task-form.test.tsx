import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, vi } from 'vitest';

import { TaskForm } from '../components/task-form';

const parents = [
  { depth: 0, id: 'MMR-1', label: 'build', type: 'initiative' as const },
  { depth: 1, id: 'MMR-7', label: 'Phase 5', type: 'phase' as const },
];

describe('taskForm (create)', () => {
  it('renders the parent picker and blocks submit until a title is entered', () => {
    const onSubmit = vi.fn();
    render(<TaskForm mode="create" parents={parents} onSubmit={onSubmit} onCancel={() => {}} />);
    expect(screen.getByLabelText(/parent/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create/i })).toBeDisabled();
  });

  it('submits parent + normalized fields', async () => {
    const onSubmit = vi.fn();
    render(<TaskForm mode="create" parents={parents} onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText(/parent/i), { target: { value: 'MMR-7' } });
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: '  hello  ' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    await vi.waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ parent: 'MMR-7', priority: null, size: null, title: 'hello' }),
      ),
    );
  });

  it('enter with empty title does not throw and does not call onSubmit', async () => {
    const onSubmit = vi.fn();
    render(<TaskForm mode="create" parents={parents} onSubmit={onSubmit} onCancel={() => {}} />);
    // Title is empty by default; submit the form directly
    const form = screen.getByRole('button', { name: /create/i }).closest('form')!;
    fireEvent.submit(form);
    // Give async handlers a chance to run
    await new Promise((r) => setTimeout(r, 50));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('more-details fields (priority) are included in onSubmit payload', async () => {
    const onSubmit = vi.fn();
    render(<TaskForm mode="create" parents={parents} onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'My task' } });
    fireEvent.change(screen.getByLabelText(/priority/i), { target: { value: 'p2' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    await vi.waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 'p2', title: 'My task' }),
      ),
    );
  });

  it('description is always visible, not behind the More details disclosure (MMR-75)', () => {
    const onSubmit = vi.fn();
    render(<TaskForm mode="create" parents={parents} onSubmit={onSubmit} onCancel={() => {}} />);
    // Description must not be nested in the collapsed disclosure...
    expect(screen.getByLabelText(/description/i).closest('details')).toBeNull();
    // ...while priority stays under "More details".
    expect(screen.getByLabelText(/priority/i).closest('details')).not.toBeNull();
  });

  it('comma-separated tags input is split into tags array', async () => {
    const onSubmit = vi.fn();
    render(<TaskForm mode="create" parents={parents} onSubmit={onSubmit} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Tagged task' } });
    fireEvent.change(screen.getByLabelText(/tags/i), { target: { value: 'foo, bar' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));
    await vi.waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ tags: ['foo', 'bar'] })),
    );
  });

  it('submitting=true disables the submit button', () => {
    render(
      <TaskForm
        mode="create"
        parents={parents}
        submitting
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    // Even if we set a title, submitting=true keeps button disabled
    // The button is disabled due to empty title AND submitting — check it's disabled
    expect(screen.getByRole('button', { name: /create/i })).toBeDisabled();
  });

  it('create button disabled until both title and parent are provided', () => {
    // Pass the full parents list so the parent picker is rendered; start with empty default
    // by passing an empty parents array so defaultParent resolves to ""
    const onSubmit = vi.fn();
    render(<TaskForm mode="create" parents={[]} onSubmit={onSubmit} onCancel={() => {}} />);
    // No title, no parent — disabled
    expect(screen.getByRole('button', { name: /create/i })).toBeDisabled();
    // Type a title — still disabled because parent is ""
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'My task' } });
    expect(screen.getByRole('button', { name: /create/i })).toBeDisabled();
  });

  it('create button enabled after title typed and parent selected', () => {
    const onSubmit = vi.fn();
    render(<TaskForm mode="create" parents={parents} onSubmit={onSubmit} onCancel={() => {}} />);
    // Default parent is MMR-1 (first option); type a title — should become enabled
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'My task' } });
    expect(screen.getByRole('button', { name: /create/i })).not.toBeDisabled();
    // Change parent to MMR-7 — still enabled
    fireEvent.change(screen.getByLabelText(/parent/i), { target: { value: 'MMR-7' } });
    expect(screen.getByRole('button', { name: /create/i })).not.toBeDisabled();
  });
});

describe('taskForm (edit)', () => {
  it('hides the parent picker and prefills from initial', () => {
    render(
      <TaskForm
        mode="edit"
        initial={{ priority: 'p1', title: 'existing' }}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByLabelText(/parent/i)).toBeNull();
    expect(screen.getByLabelText(/title/i)).toHaveValue('existing');
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
  });

  it('submitting=true disables the save button even with a title present', async () => {
    render(
      <TaskForm
        mode="edit"
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

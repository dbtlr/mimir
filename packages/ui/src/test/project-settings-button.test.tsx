import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, vi } from 'vitest';

import type { WireNode } from '../api/types';
import { ProjectSettingsButton } from '../components/project-settings-button';

const { apiSend } = vi.hoisted(() => ({ apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiSend }));
// The undo toast is the bare callable; `error` covers the mutation failures.
const { toast } = vi.hoisted(() => {
  const fn =
    vi.fn<
      (
        message: string,
        opts?: { action?: { label: string; onClick: () => void }; duration?: number },
      ) => void
    >();
  return { toast: Object.assign(fn, { error: vi.fn() }) };
});
vi.mock('sonner', () => ({ toast }));
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

afterEach(() => {
  vi.clearAllMocks();
});

function wrap(ui: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

const baseProject: WireNode = {
  created_at: '2024-01-01T00:00:00Z',
  description: 'A handy description',
  id: 'MMR',
  parent: null,
  status: 'in_progress',
  title: 'My Project',
  type: 'project',
  updated_at: '2024-01-01T00:00:00Z',
};

describe('projectSettingsButton', () => {
  it('renders a settings button', () => {
    wrap(<ProjectSettingsButton project={baseProject} />);
    expect(screen.getByRole('button', { name: /project settings/i })).toBeInTheDocument();
  });

  it('is disabled when offline', () => {
    wrap(<ProjectSettingsButton project={baseProject} offline />);
    expect(screen.getByRole('button', { name: /project settings/i })).toBeDisabled();
  });

  it('clicking opens the sheet with name and description fields prefilled', () => {
    wrap(<ProjectSettingsButton project={baseProject} />);
    fireEvent.click(screen.getByRole('button', { name: /project settings/i }));
    expect(screen.getByLabelText(/name/i)).toHaveValue('My Project');
    expect(screen.getByLabelText(/description/i)).toHaveValue('A handy description');
  });

  it('description field is empty when project has no description', () => {
    const project = { ...baseProject, description: null };
    wrap(<ProjectSettingsButton project={project} />);
    fireEvent.click(screen.getByRole('button', { name: /project settings/i }));
    expect(screen.getByLabelText(/description/i)).toHaveValue('');
  });

  it('save button disabled when name is cleared', () => {
    wrap(<ProjectSettingsButton project={baseProject} />);
    fireEvent.click(screen.getByRole('button', { name: /project settings/i }));
    const nameInput = screen.getByLabelText(/name/i);
    fireEvent.change(nameInput, { target: { value: '' } });
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });

  it('submitting calls PATCH /api/projects/:key with title and description', async () => {
    apiSend.mockResolvedValue({ description: 'New desc', id: 'MMR', title: 'Renamed' });
    wrap(<ProjectSettingsButton project={baseProject} />);
    fireEvent.click(screen.getByRole('button', { name: /project settings/i }));

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Renamed' } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'New desc' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await vi.waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('PATCH', '/api/projects/MMR', {
        description: 'New desc',
        title: 'Renamed',
      });
    });
  });
});

function openSheet() {
  fireEvent.click(screen.getByRole('button', { name: /project settings/i }));
}

const follows = (a: Element, b: Element) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe('projectSettings lifecycle (MMR-230)', () => {
  it('shows the LIFECYCLE section with the archive contract copy', () => {
    wrap(<ProjectSettingsButton project={baseProject} />);
    openSheet();
    expect(screen.getByText('Lifecycle')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Archiving freezes the project and hides it everywhere by default — board, picker, tasks, attention. Everything stays readable from the Archived shelf. Reversible any time; nothing is deleted.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive project' })).toBeEnabled();
  });

  it('archiving POSTs the archive route with no confirm, closes, toasts undo, and returns to the Overview', async () => {
    apiSend.mockResolvedValue({ id: 'MMR' });
    wrap(<ProjectSettingsButton project={baseProject} />);
    openSheet();
    fireEvent.click(screen.getByRole('button', { name: 'Archive project' }));

    await vi.waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/projects/MMR/archive', undefined);
    });
    await vi.waitFor(() => {
      expect(toast).toHaveBeenCalledWith('Archived My Project', {
        action: expect.objectContaining({ label: 'Unarchive' }),
        // The undo toast is the only console unarchive path (the archived
        // shelf is MMR-125) — it must outlive sonner's ~4s default.
        duration: 10_000,
      });
    });
    expect(navigate).toHaveBeenCalledWith({ to: '/' });
    // The sheet closed — its fields are gone.
    expect(screen.queryByLabelText(/name/i)).not.toBeInTheDocument();
  });

  it('the undo toast Unarchive POSTs the unarchive route', async () => {
    apiSend.mockResolvedValue({ id: 'MMR' });
    wrap(<ProjectSettingsButton project={baseProject} />);
    openSheet();
    fireEvent.click(screen.getByRole('button', { name: 'Archive project' }));
    await vi.waitFor(() => {
      expect(toast).toHaveBeenCalled();
    });

    toast.mock.calls.at(0)?.[1]?.action?.onClick();
    await vi.waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/projects/MMR/unarchive', undefined);
    });
  });

  it('describes the archive consequences to assistive tech (aria-describedby)', () => {
    wrap(<ProjectSettingsButton project={baseProject} />);
    openSheet();
    expect(screen.getByRole('button', { name: 'Archive project' })).toHaveAccessibleDescription(
      /Archiving freezes the project and hides it everywhere by default/,
    );
  });

  it('keeps Cancel between Save and the no-confirm Archive in tab order', () => {
    wrap(<ProjectSettingsButton project={baseProject} />);
    openSheet();
    const save = screen.getByRole('button', { name: /save/i });
    const cancel = screen.getByRole('button', { name: /cancel/i });
    const archiveButton = screen.getByRole('button', { name: 'Archive project' });
    // DOM order IS tab order here (no tabindex overrides): Save → Cancel →
    // Archive, so overshooting Save by one Tab lands on Cancel, never Archive.
    expect(follows(save, cancel)).toBe(true);
    expect(follows(cancel, archiveButton)).toBe(true);
  });

  it('the archive button disables at 40% when offline', () => {
    const { rerender } = wrap(<ProjectSettingsButton project={baseProject} />);
    openSheet();
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ProjectSettingsButton project={baseProject} offline />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('button', { name: 'Archive project' })).toBeDisabled();
  });
});

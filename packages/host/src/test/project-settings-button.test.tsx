import type { EngineNode } from '@mimir/contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { archive, unarchive, updateProject } from '../api/fns/shell';
import { ProjectSettingsButton } from '../components/project-settings-button';
import { serveShell } from './shell-fns';

vi.mock('../api/fns/shell');
// The undo toast is the bare callable; `error` covers the mutation failures.
// Since the archive flow delegates to `archivedUndoToast` (MMR-125), the
// message arg is a ReactNode, not a bare string.
const { toast } = vi.hoisted(() => {
  const fn = vi.fn<
    (
      message: ReactNode,
      opts?: {
        action?: { label: string; onClick: () => void };
        duration?: number;
        actionButtonStyle?: Record<string, unknown>;
      },
    ) => void
  >();
  return { toast: Object.assign(fn, { error: vi.fn() }) };
});
vi.mock('sonner', () => ({ toast }));
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

beforeEach(() => {
  serveShell();
});

afterEach(() => {
  vi.clearAllMocks();
});

function wrap(ui: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

const baseProject: Pick<EngineNode, 'id' | 'title' | 'description'> = {
  description: 'A handy description',
  id: 'MMR',
  title: 'My Project',
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

  it('submitting updates the project with its name and description', async () => {
    wrap(<ProjectSettingsButton project={baseProject} />);
    fireEvent.click(screen.getByRole('button', { name: /project settings/i }));

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Renamed' } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'New desc' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await vi.waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith({
        data: { description: 'New desc', id: 'MMR', name: 'Renamed' },
      });
    });
  });

  it('a description that was blank and still is leaves it alone', async () => {
    wrap(<ProjectSettingsButton project={{ ...baseProject, description: null }} />);
    fireEvent.click(screen.getByRole('button', { name: /project settings/i }));

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Renamed' } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await vi.waitFor(() => {
      expect(updateProject).toHaveBeenCalled();
    });
    const { data } = vi.mocked(updateProject).mock.calls[0]![0];
    expect(data.name).toBe('Renamed');
    expect(data.description).toBeUndefined();
  });

  it.each(['', '   '])('an emptied description %j clears it with null', async (blank) => {
    wrap(<ProjectSettingsButton project={baseProject} />);
    fireEvent.click(screen.getByRole('button', { name: /project settings/i }));

    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: blank } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await vi.waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith({
        data: { description: null, id: 'MMR', name: 'My Project' },
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
        'Archiving freezes the project and hides it everywhere by default — board, picker, tasks, attention. Unarchive it from its page, which the project switcher lists under Archived. Reversible any time; nothing is deleted.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive project' })).toBeEnabled();
  });

  it('archiving archives the project with no confirm, closes, toasts undo, and returns to the review page', async () => {
    wrap(<ProjectSettingsButton project={baseProject} />);
    openSheet();
    fireEvent.click(screen.getByRole('button', { name: 'Archive project' }));

    await vi.waitFor(() => {
      expect(archive).toHaveBeenCalledWith({ data: { id: 'MMR' } });
    });
    await vi.waitFor(() => {
      expect(toast).toHaveBeenCalledOnce();
    });
    const [message, opts] = toast.mock.calls[0] as [
      ReactNode,
      { action: { label: string; onClick: () => void }; duration?: number },
    ];
    render(<>{message}</>);
    expect(screen.getByText(/Archived/)).toBeInTheDocument();
    expect(screen.getByText('My Project')).toBeInTheDocument();
    expect(opts.action.label).toBe('Unarchive');
    // The undo toast may be the nearest unarchive affordance at archive time
    // (the durable path is the archived project's page) — it must outlive
    // sonner's ~4s default.
    expect(opts.duration).toBe(10_000);
    expect(navigate).toHaveBeenCalledWith({ to: '/' });
    // The sheet closed — its fields are gone.
    expect(screen.queryByLabelText(/name/i)).not.toBeInTheDocument();
  });

  it('the undo toast Unarchive unarchives the project', async () => {
    wrap(<ProjectSettingsButton project={baseProject} />);
    openSheet();
    fireEvent.click(screen.getByRole('button', { name: 'Archive project' }));
    await vi.waitFor(() => {
      expect(toast).toHaveBeenCalled();
    });

    toast.mock.calls.at(0)?.[1]?.action?.onClick();
    await vi.waitFor(() => {
      expect(unarchive).toHaveBeenCalledWith({ data: { id: 'MMR' } });
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

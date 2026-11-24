import type { EngineNode } from '@mimir/contract';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { archive, unarchive, updateProject } from '../api/fns/shell';
import type { NoticeHost, toast as realToast } from '../components/patterns/notice';
import { ProjectSettings } from '../components/project-settings';
import { engineProject } from './engine-fixtures';
import { serveShell } from './shell-fns';
import { stubViewport } from './viewport';

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
vi.mock('../components/patterns/notice', () => ({ toast }));
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

beforeEach(() => {
  serveShell();
});

afterEach(() => {
  onlineManager.setOnline(true);
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** What opens the settings on a page: here a plain button, on a project page More's Edit. */
function ProjectSettingsButton({
  project,
  offline,
}: {
  project: Pick<EngineNode, 'id' | 'title' | 'description'>;
  offline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Project settings
      </button>
      <ProjectSettings
        project={project}
        offline={offline}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

function wrap(ui: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

const baseProject: Pick<EngineNode, 'id' | 'title' | 'description'> = {
  description: 'A handy description',
  id: 'MMR',
  title: 'My Project',
};

describe('projectSettings', () => {
  it('clicking opens the form with title and description fields prefilled', () => {
    wrap(<ProjectSettingsButton project={baseProject} />);
    fireEvent.click(screen.getByRole('button', { name: /project settings/i }));
    expect(screen.getByLabelText(/title/i)).toHaveValue('My Project');
    expect(screen.getByLabelText(/description/i)).toHaveValue('A handy description');
  });

  it('description field is empty when project has no description', () => {
    const project = { ...baseProject, description: null };
    wrap(<ProjectSettingsButton project={project} />);
    fireEvent.click(screen.getByRole('button', { name: /project settings/i }));
    expect(screen.getByLabelText(/description/i)).toHaveValue('');
  });

  it('a cancelled edit is gone when the form opens again', async () => {
    stubViewport('desktop');
    wrap(<ProjectSettingsButton project={baseProject} />);
    fireEvent.click(screen.getByRole('button', { name: /project settings/i }));
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Renamed' } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'Edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await vi.waitFor(() => {
      expect(screen.queryByLabelText(/title/i)).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /project settings/i }));
    expect(screen.getByLabelText(/title/i)).toHaveValue('My Project');
    expect(screen.getByLabelText(/description/i)).toHaveValue('A handy description');
  });

  it('save button disabled when the title is cleared', () => {
    wrap(<ProjectSettingsButton project={baseProject} />);
    fireEvent.click(screen.getByRole('button', { name: /project settings/i }));
    const nameInput = screen.getByLabelText(/title/i);
    fireEvent.change(nameInput, { target: { value: '' } });
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
  });

  it('submitting updates the project with its name and description', async () => {
    wrap(<ProjectSettingsButton project={baseProject} />);
    fireEvent.click(screen.getByRole('button', { name: /project settings/i }));

    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Renamed' } });
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

    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Renamed' } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await vi.waitFor(() => {
      expect(updateProject).toHaveBeenCalled();
    });
    const { data } = vi.mocked(updateProject).mock.calls[0]![0];
    expect(data.name).toBe('Renamed');
    expect(data.description).toBeUndefined();
  });

  it('a description-only save leaves a title received during the edit alone', async () => {
    const client = new QueryClient();
    const settings = (project: typeof baseProject) => (
      <QueryClientProvider client={client}>
        <ProjectSettingsButton project={project} />
      </QueryClientProvider>
    );
    const { rerender } = render(settings(baseProject));
    openSheet();
    rerender(settings({ ...baseProject, title: 'Name from refresh' }));
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'New desc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await vi.waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith({ data: { description: 'New desc', id: 'MMR' } });
    });
    expect(vi.mocked(updateProject).mock.lastCall?.[0].data.name).toBeUndefined();
  });

  it('keeps project fields read-only while saving and restores editing after refusal', async () => {
    const held = Promise.withResolvers<Awaited<ReturnType<typeof updateProject>>>();
    vi.mocked(updateProject).mockReturnValueOnce(held.promise);
    wrap(<ProjectSettingsButton project={baseProject} />);
    openSheet();
    const title = screen.getByLabelText('Title');
    const description = screen.getByLabelText(/description/i);
    fireEvent.change(title, { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(title).toHaveAttribute('readonly');
    expect(description).toHaveAttribute('readonly');
    await userEvent.type(title, ' lost edit');
    expect(title).toHaveValue('Renamed');
    expect(description).toHaveValue(baseProject.description);

    await act(async () => {
      held.reject(new Error('Write refused'));
    });
    expect(title).not.toHaveAttribute('readonly');
    expect(description).not.toHaveAttribute('readonly');
    await userEvent.type(title, ' again');
    expect(title).toHaveValue('Renamed again');
  });

  it.each(['Escape', 'Cancel'])(
    'an offline submit leaves the sheet dismissible by %s',
    async (dismiss) => {
      stubViewport('desktop');
      wrap(<ProjectSettingsButton project={baseProject} />);
      openSheet();
      const dialog = screen.getByRole('dialog', { name: 'Project settings' });
      const save = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Save' });
      const title = within(dialog).getByLabelText('Title');
      fireEvent.change(title, { target: { value: 'Offline draft' } });
      expect(save).toBeEnabled();

      act(() => onlineManager.setOnline(false));
      // An Enter or requestSubmit can reach the form even when its button is disabled.
      expect(save.form).not.toBeNull();
      if (save.form !== null) {
        fireEvent.submit(save.form);
      }
      expect(title).toHaveValue('Offline draft');
      if (dismiss === 'Escape') {
        await userEvent.keyboard('{Escape}');
      } else {
        await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      }
      expect(screen.queryByRole('dialog', { name: 'Project settings' })).toBeNull();
      expect(save).toBeDisabled();
      expect(updateProject).not.toHaveBeenCalled();
    },
  );

  it.each([
    { before: null, reverted: false },
    { before: null, reverted: true },
    { before: 'Old description', reverted: false },
  ])(
    'a title-only save leaves a description received during the edit alone (opened with %j)',
    async ({ before, reverted }) => {
      const client = new QueryClient();
      const settings = (project: typeof baseProject) => (
        <QueryClientProvider client={client}>
          <ProjectSettingsButton project={project} />
        </QueryClientProvider>
      );
      const { rerender } = render(settings({ ...baseProject, description: before }));
      openSheet();
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Renamed' } });
      rerender(settings({ ...baseProject, description: 'Description from refresh' }));
      if (reverted) {
        const field = screen.getByLabelText(/description/i);
        fireEvent.change(field, { target: { value: 'Temporary draft' } });
        fireEvent.change(field, { target: { value: '' } });
      }
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await vi.waitFor(() => {
        expect(updateProject).toHaveBeenCalledOnce();
      });
      const data = vi.mocked(updateProject).mock.lastCall?.[0].data;
      expect(data).toEqual({ id: 'MMR', name: 'Renamed' });
      expect(data).not.toHaveProperty('description');
    },
  );

  it('opens the new project with its own fields when the project changes', async () => {
    const client = new QueryClient();
    const settings = (project: typeof baseProject) => (
      <QueryClientProvider client={client}>
        <ProjectSettingsButton project={project} />
      </QueryClientProvider>
    );
    const { rerender } = render(settings(baseProject));
    openSheet();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Mimir draft' } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'Old draft' } });
    rerender(settings({ description: 'Norn description', id: 'NRN', title: 'Norn' }));

    expect(screen.getByLabelText('Title')).toHaveValue('Norn');
    expect(screen.getByLabelText(/description/i)).toHaveValue('Norn description');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Renamed Norn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith({ data: { id: 'NRN', name: 'Renamed Norn' } });
    });
  });

  it('a save still in flight from the last project leaves the next project’s sheet open when it settles', async () => {
    const held = Promise.withResolvers<Awaited<ReturnType<typeof updateProject>>>();
    vi.mocked(updateProject).mockReturnValueOnce(held.promise);
    const client = new QueryClient();
    const settings = (project: typeof baseProject) => (
      <QueryClientProvider client={client}>
        <ProjectSettingsButton project={project} />
      </QueryClientProvider>
    );
    const { rerender } = render(settings(baseProject));
    openSheet();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    rerender(settings({ description: 'Norn description', id: 'NRN', title: 'Norn' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Norn draft' } });

    await act(async () => {
      held.resolve(engineProject({ id: 'MMR', title: 'Renamed' }));
    });
    expect(screen.getByRole('dialog', { name: 'Project settings' })).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('Norn draft');
  });

  it.each(['', '   '])('an emptied description %j clears it with null', async (blank) => {
    wrap(<ProjectSettingsButton project={baseProject} />);
    fireEvent.click(screen.getByRole('button', { name: /project settings/i }));

    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: blank } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await vi.waitFor(() => {
      expect(updateProject).toHaveBeenCalledWith({
        data: { description: null, id: 'MMR' },
      });
    });
  });
});

function openSheet() {
  fireEvent.click(screen.getByRole('button', { name: /project settings/i }));
}

const follows = (a: Element, b: Element) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

/** Whether a toast titled `text` is on screen, not only in the live region's copy of it. */
const toastShown = (text: string) =>
  [...document.querySelectorAll('[data-slot="toast-title"]')].some(
    (title) => title.textContent === text,
  );

describe('projectSettings lifecycle (MMR-230)', () => {
  it('archiving archives the project with no confirm, closes, toasts undo, and returns to Home', async () => {
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
    // The Notice sets the project's name in bold (MMR-743), so the message is markup.
    expect(render(<p>{message}</p>).container).toHaveTextContent('Archived My Project');
    expect(opts.action.label).toBe('Undo');
    // The undo toast may be the nearest unarchive affordance at archive time
    // (the durable path is the archived project's page) — it must outlive
    // the toast's five-second default.
    expect(opts.duration).toBe(10_000);
    expect(navigate).toHaveBeenCalledWith({ to: '/' });
    // The sheet closed — its fields are gone.
    expect(screen.queryByLabelText(/title/i)).not.toBeInTheDocument();
  });

  // The option alone is not enough: the Notice must keep the toast up for it.
  it('the undo toast stays on screen for ten seconds, past the five-second default', async () => {
    const notice = await vi.importActual<{
      NoticeHost: typeof NoticeHost;
      toast: typeof realToast;
    }>('../components/patterns/notice');
    toast.mockImplementation((message, opts) => {
      notice.toast(message, opts);
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<notice.NoticeHost />);
    wrap(<ProjectSettingsButton project={baseProject} />);
    openSheet();
    fireEvent.click(screen.getByRole('button', { name: 'Archive project' }));
    await vi.waitFor(() => {
      expect(toastShown('Archived My Project')).toBe(true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_000);
    });
    expect(toastShown('Archived My Project')).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(toastShown('Archived My Project')).toBe(false);
    act(() => {
      notice.toast.dismiss();
    });
  });

  it('the undo toast Undo unarchives the project', async () => {
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

  it('shows the Lifecycle section, with the archive contract copy that describes the Archive button', () => {
    wrap(<ProjectSettingsButton project={baseProject} />);
    openSheet();
    expect(screen.getByText('Lifecycle')).toBeInTheDocument();
    expect(
      screen.getByText(/Archiving freezes the project and hides it everywhere by default/),
    ).toBeInTheDocument();
    const archiveButton = screen.getByRole('button', { name: 'Archive project' });
    expect(archiveButton).toBeEnabled();
    expect(archiveButton).toHaveAccessibleDescription(
      /Archiving freezes the project and hides it everywhere by default/,
    );
  });

  // MMR-743 ruling: Lifecycle comes at the end of the body, with DOM order matching visual
  // order. Archive is the body's last control; the footer's Cancel and Save follow it, so
  // tabbing past Archive reaches Cancel before the commit, and no Tab from Save lands on it.
  it('puts the no-confirm Archive last in the body, before the footer’s Cancel then Save', () => {
    stubViewport('desktop');
    wrap(<ProjectSettingsButton project={baseProject} />);
    openSheet();
    const sheet = screen.getByRole('dialog', { name: 'Project settings' });
    const save = within(sheet).getByRole('button', { name: /save/i });
    const cancel = within(sheet).getByRole('button', { name: /cancel/i });
    const archiveButton = within(sheet).getByRole('button', { name: 'Archive project' });
    const description = within(sheet).getByLabelText(/description/i);
    expect(follows(description, archiveButton)).toBe(true);
    expect(follows(archiveButton, cancel)).toBe(true);
    expect(follows(cancel, save)).toBe(true);
  });

  it('holds Archive while a Save is in flight, so the two never race', async () => {
    // A Save that never settles.
    vi.mocked(updateProject).mockReturnValue(Promise.withResolvers<never>().promise);
    wrap(<ProjectSettingsButton project={baseProject} />);
    openSheet();
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await vi.waitFor(() => {
      expect(updateProject).toHaveBeenCalledOnce();
    });
    const archiveButton = screen.getByRole('button', { name: 'Archive project' });
    expect(archiveButton).toBeDisabled();
    fireEvent.click(archiveButton);
    expect(archive).not.toHaveBeenCalled();
  });

  it.each(['Archive project', 'Save'])(
    'holds the other action when %s dispatches first in the same task',
    async (first) => {
      const archiveFirst = first === 'Archive project';
      const calls = archiveFirst
        ? { held: updateProject, started: archive }
        : { held: archive, started: updateProject };
      vi.mocked(archive).mockReturnValue(Promise.withResolvers<never>().promise);
      vi.mocked(updateProject).mockReturnValue(Promise.withResolvers<never>().promise);
      wrap(<ProjectSettingsButton project={baseProject} />);
      openSheet();
      const firstButton = screen.getByRole('button', { name: first });
      const secondButton = screen.getByRole('button', {
        name: archiveFirst ? 'Save' : 'Archive project',
      });

      await act(async () => {
        firstButton.click();
        secondButton.click();
      });

      expect(calls.started).toHaveBeenCalledOnce();
      expect(calls.held).not.toHaveBeenCalled();
    },
  );

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

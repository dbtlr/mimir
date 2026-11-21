import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { seedCreate } from '../api/fns/browse';
import { engineSeed } from './browse-fixtures';
import { serveBrowse } from './browse-fns';
import { engineProject } from './engine-fixtures';
import { serveBareRecords } from './node-fns';
import { renderShell } from './router';
import { serveShell } from './shell-fns';
import { serveViews } from './views-fns';

vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/views');

// The project gate and the task pages these cases open read the record by server function.
beforeEach(() => {
  serveViews();
  serveBareRecords();
});
const { toast } = vi.hoisted(() => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('../components/patterns/notice', () => ({ NoticeHost: () => null, toast }));

afterEach(() => {
  vi.clearAllMocks();
});

function mockApi() {
  serveShell({
    projects: [
      engineProject({ id: 'MMR', title: 'Mimir' }),
      engineProject({ id: 'NRN', status: 'ready', title: 'Norn' }),
    ],
  });
  serveBrowse();
}

const renderApp = async (initial = '/p/MMR/seeds') =>
  (
    await renderShell(
      initial,
      new QueryClient({ defaultOptions: { queries: { refetchInterval: false, retry: false } } }),
    )
  ).router;

describe('seed form (12c, MMR-247; the Form sheet, MMR-743)', () => {
  it('files the right body (project/title/kind, no requester) and resets on success', async () => {
    mockApi();
    vi.mocked(seedCreate).mockResolvedValue(engineSeed({ id: 'MMR-s7' }));
    await renderApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: '+ File a seed' }));
    // the form is up
    await screen.findByLabelText('Seed');

    await user.click(screen.getByRole('radio', { name: 'Bug' }));
    await user.type(screen.getByLabelText('Seed'), 'Tree lens loses scroll');
    await user.click(screen.getByRole('button', { name: 'File seed' }));

    await waitFor(() => {
      expect(seedCreate).toHaveBeenCalledWith({
        data: { kind: 'bug', project: 'MMR', title: 'Tree lens loses scroll' },
      });
    });
    // never carries requester — a console-filed seed is self-filed
    expect(vi.mocked(seedCreate).mock.calls[0]?.[0].data).not.toHaveProperty('requester');
    // success toasts and the form closes (fields reset behind it)
    expect(toast.success).toHaveBeenCalledWith('Filed MMR-s7');
    await waitFor(() => {
      expect(screen.queryByLabelText('Seed')).toBeNull();
    });
  });

  // ADR 0019 §1 (MMR-626): seed kind is a category, so the picked kind never wears a status hue.
  // The Form sheet (MMR-743) draws Kind as a Segmented Control, whose pick is the accent
  // selection wash every Choice shares, where the pills drew it in ink.
  it('a picked kind takes the selection wash, never a status hue', async () => {
    mockApi();
    await renderApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: '+ File a seed' }));
    await screen.findByLabelText('Seed');
    for (const kind of ['Bug', 'Idea', 'Feature']) {
      const segment = screen.getByRole('radio', { name: kind });
      await user.click(segment);
      expect(segment).toBeChecked();
      expect(segment.className).not.toMatch(/status-/);
      expect(segment.className.split(/\s+/)).toEqual(
        expect.arrayContaining(['bg-accent/12', 'text-accent-foreground']),
      );
    }
  });

  it('enter files; Shift+Enter adds a body line — the whole blob rides `title` (MMR-263)', async () => {
    mockApi();
    await renderApp();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: '+ File a seed' }));
    const field = await screen.findByLabelText('Seed');
    await user.click(screen.getByRole('radio', { name: 'Bug' }));

    await user.type(field, 'title line');
    // Shift+Enter inserts a newline — it must NOT file.
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.type(field, 'body line');
    expect(seedCreate).not.toHaveBeenCalled();

    // A bare Enter files the whole capture blob as `title` (the Engine splits it).
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(seedCreate).toHaveBeenCalledWith({
        data: { kind: 'bug', project: 'MMR', title: 'title line\nbody line' },
      });
    });
  });

  it('enter on an empty seed field files nothing', async () => {
    mockApi();
    await renderApp();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '+ File a seed' }));
    const field = await screen.findByLabelText('Seed');
    await user.click(field);
    await user.keyboard('{Enter}');
    expect(seedCreate).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Seed')).toBeInTheDocument();
  });

  it('on a project the picker does not offer (archived), chooses none and holds File seed', async () => {
    serveShell({
      archived: [engineProject({ id: 'OLD', status: 'done', title: 'Old project' })],
      projects: [
        engineProject({ id: 'MMR', title: 'Mimir' }),
        engineProject({ id: 'NRN', status: 'ready', title: 'Norn' }),
      ],
    });
    serveBrowse();
    await renderApp('/p/OLD');
    const user = userEvent.setup();
    await screen.findByText(/Old project/);
    await user.keyboard('s');
    const field = await screen.findByLabelText('Seed');
    await user.type(field, 'Filed where it shows');
    // The picker shows no project, so the form files to none rather than one it hides.
    expect(screen.getByRole('button', { name: 'Project Choose a project…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'File seed' })).toBeDisabled();
    await user.keyboard('{Enter}');
    expect(seedCreate).not.toHaveBeenCalled();
  });

  it('reopens fresh after Escape abandons its edits: Idea and an empty seed', async () => {
    mockApi();
    await renderApp();
    const user = userEvent.setup();
    const opener = await screen.findByRole('button', { name: '+ File a seed' });

    await user.click(opener);
    await user.click(await screen.findByRole('radio', { name: 'Bug' }));
    await user.type(screen.getByLabelText('Seed'), 'Abandoned thought');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByLabelText('Seed')).toBeNull();
    });

    await user.click(opener);
    expect(await screen.findByLabelText('Seed')).toHaveValue('');
    expect(screen.getByRole('radio', { name: 'Idea' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Bug' })).not.toBeChecked();
  });

  it('opens on the global `s` hotkey', async () => {
    mockApi();
    await renderApp();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Seeds' });

    await user.keyboard('s');
    await expect(screen.findByLabelText('Seed')).resolves.toBeDefined();
  });
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, vi } from 'vitest';

import type { WireTreeNode } from '../api/types';
import { AuthoringSheet } from '../components/authoring-sheet';
import type { AuthoringSheetProps } from '../components/authoring-sheet';
import { project, task } from './fixtures';

const { apiGet, apiSend } = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }));
vi.mock('../api/client', () => ({ apiGet, apiSend }));
const { toast } = vi.hoisted(() => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('sonner', () => ({ toast }));

afterEach(() => {
  vi.clearAllMocks();
});

/** A minimal WireTreeNode (homeOptions reads id/title/type/open_ended/children). */
function treeNode(
  id: string,
  title: string,
  type: 'initiative' | 'phase' | 'project',
  children: unknown[] = [],
  openEnded = false,
): WireTreeNode {
  return {
    ...task({ id, status: 'in_progress', title, type }),
    children,
    open_ended: openEnded,
  } as unknown as WireTreeNode;
}

const mmrTree = treeNode('MMR', 'Mimir', 'project', [
  treeNode('MMR-1', 'build', 'initiative', [
    treeNode('MMR-7', 'Phase 5 — UI', 'phase'),
    treeNode('MMR-2', 'Phase 0', 'phase'),
  ]),
  treeNode('MMR-9', 'Polish', 'initiative', [], true),
]);
const webTree = treeNode('WEB', 'Website', 'project', [treeNode('WEB-1', 'launch', 'initiative')]);

const depRows = [
  task({ id: 'MMR-40', status: 'ready', title: 'auth tokens' }),
  task({ id: 'MMR-41', status: 'in_progress', title: 'auth UI' }),
];

function mockReads() {
  apiGet.mockImplementation((path: string) => {
    if (path === '/api/projects') {
      return Promise.resolve({
        items: [project({ id: 'MMR', title: 'Mimir' }), project({ id: 'WEB', title: 'Website' })],
        total: 2,
      });
    }
    if (path === '/api/projects/MMR/tree') {
      return Promise.resolve(mmrTree);
    }
    if (path === '/api/projects/WEB/tree') {
      return Promise.resolve(webTree);
    }
    if (path.startsWith('/api/nodes?type=task&q=')) {
      return Promise.resolve({ items: depRows, total: depRows.length });
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

function renderSheet(props: Partial<AuthoringSheetProps> = {}) {
  mockReads();
  const onOpenChange = vi.fn();
  const onOpenNode = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { refetchInterval: false, retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AuthoringSheet
        open
        onOpenChange={onOpenChange}
        projectKey="MMR"
        onOpenNode={onOpenNode}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onOpenChange, onOpenNode };
}

/** The sheet is interactable once the tree resolved into the HOME row. */
async function sheetReady() {
  await screen.findByText('build');
}

/** Promote submit is enabled once the tree resolved a legal (effective) home. */
async function promoteReady() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Promote ↵' })).toBeEnabled());
}

describe('authoringSheet', () => {
  it('renders the 19a sheet: type selector, autofocused title, HOME, description, deps, signals, footer', async () => {
    renderSheet();
    await sheetReady();

    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Task' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Phase' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Initiative' })).toBeInTheDocument();
    expect(screen.getByText('esc')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveFocus());
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toBeInTheDocument();
    expect(screen.getByText('markdown ok')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('search tasks…')).toBeInTheDocument();
    expect(
      screen.getByText(
        "this task won't read ready until its prerequisites are done — inherited by any children",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Signals · optional')).toBeInTheDocument();
    expect(screen.getByLabelText('create another')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create ↵' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create & open' })).toBeInTheDocument();
    // Invariant 1 / ADR 0019 §5: nodes are born `new`; no status field, ever.
    expect(screen.queryByText(/status/i)).not.toBeInTheDocument();
  });

  it('type governs legal homes: task → initiative+phase, phase → initiative, initiative → project', async () => {
    const user = userEvent.setup();
    renderSheet();
    await sheetReady();

    // task: initiatives and phases
    await user.click(screen.getByRole('button', { expanded: false, name: /home/i }));
    expect(screen.getByRole('option', { name: /Phase 0/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Polish/ })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /Phase 0/ }));

    // phase: initiatives only
    await user.click(screen.getByRole('radio', { name: 'Phase' }));
    await user.click(screen.getByRole('button', { expanded: false, name: /home/i }));
    await expect(screen.findByRole('option', { name: /build/ })).resolves.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Polish/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Phase 0/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /build/ }));

    // initiative: the picker collapses to bare projects
    await user.click(screen.getByRole('radio', { name: 'Initiative' }));
    await user.click(screen.getByRole('button', { expanded: false, name: /home/i }));
    expect(screen.getByRole('option', { name: /Mimir/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Website/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /build/ })).not.toBeInTheDocument();
  });

  it('creates a task, then applies DEPENDS-ON via /depend, and closes', async () => {
    const user = userEvent.setup();
    apiSend.mockResolvedValue({ id: 'MMR-99' });
    const { onOpenChange } = renderSheet();
    await sheetReady();

    await user.type(screen.getByLabelText('Title'), 'Wire auth');
    await user.type(screen.getByRole('combobox'), 'auth');
    await user.click(await screen.findByRole('option', { name: /MMR-40/ }));
    // picking appends a chip; the remove control is a real button
    expect(screen.getByLabelText('Remove dependency MMR-40')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create ↵' }));
    await waitFor(() => {
      expect(apiSend).toHaveBeenNthCalledWith(1, 'POST', '/api/nodes', {
        parent: 'MMR-1',
        title: 'Wire auth',
        type: 'task',
      });
      expect(apiSend).toHaveBeenNthCalledWith(2, 'POST', '/api/nodes/MMR-99/depend', {
        on: ['MMR-40'],
      });
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('a removed dep chip is not applied', async () => {
    const user = userEvent.setup();
    apiSend.mockResolvedValue({ id: 'MMR-99' });
    renderSheet();
    await sheetReady();

    await user.type(screen.getByLabelText('Title'), 'Solo');
    await user.type(screen.getByRole('combobox'), 'auth');
    await user.click(await screen.findByRole('option', { name: /MMR-40/ }));
    await user.click(screen.getByLabelText('Remove dependency MMR-40'));

    await user.click(screen.getByRole('button', { name: 'Create ↵' }));
    await waitFor(() => expect(apiSend).toHaveBeenCalledOnce());
    expect(apiSend).toHaveBeenCalledWith(
      'POST',
      '/api/nodes',
      expect.objectContaining({ title: 'Solo' }),
    );
  });

  it('keeps the sheet open and toasts when depend fails after a successful create', async () => {
    const user = userEvent.setup();
    apiSend.mockImplementation((_method: string, path: string) =>
      path === '/api/nodes'
        ? Promise.resolve({ id: 'MMR-99' })
        : Promise.reject(new Error('would create a cycle')),
    );
    const { onOpenChange } = renderSheet();
    await sheetReady();

    await user.type(screen.getByLabelText('Title'), 'Wire auth');
    await user.type(screen.getByRole('combobox'), 'auth');
    await user.click(await screen.findByRole('option', { name: /MMR-40/ }));
    await user.click(screen.getByRole('button', { name: 'Create ↵' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('would create a cycle'));
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('a depend failure pins a retry posture: the created node surfaces, fields freeze', async () => {
    const user = userEvent.setup();
    apiSend.mockImplementation((_method: string, path: string) =>
      path === '/api/nodes'
        ? Promise.resolve({ id: 'MMR-99' })
        : Promise.reject(new Error('would create a cycle')),
    );
    const { onOpenChange, onOpenNode } = renderSheet();
    await sheetReady();

    await user.type(screen.getByLabelText('Title'), 'Wire auth');
    await user.type(screen.getByRole('combobox'), 'auth');
    await user.click(await screen.findByRole('option', { name: /MMR-40/ }));
    await user.click(screen.getByRole('button', { name: 'Create ↵' }));

    // The created node stays visible + linked so the user can retry the dep.
    await screen.findByRole('button', { name: 'Retry deps ↵' });
    expect(screen.getByRole('status')).toHaveTextContent(
      'MMR-99 created — dependencies not yet attached.',
    );
    // Fields the created node can no longer absorb are frozen…
    expect(screen.getByLabelText('Title')).toBeDisabled();
    expect(screen.getByLabelText('Description')).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Phase' })).toBeDisabled();
    // …while the dep chips stay editable for the retry.
    expect(screen.getByLabelText('Remove dependency MMR-40')).toBeEnabled();

    // "open it" routes to the created node without any further write.
    await user.click(screen.getByRole('button', { name: 'open it' }));
    expect(onOpenNode).toHaveBeenCalledWith('MMR-99');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('retrying after a depend failure re-attaches to the created node — never a duplicate create', async () => {
    const user = userEvent.setup();
    let dependCalls = 0;
    apiSend.mockImplementation((_method: string, path: string) => {
      if (path === '/api/nodes') {
        return Promise.resolve({ id: 'MMR-99' });
      }
      dependCalls += 1;
      return dependCalls === 1
        ? Promise.reject(new Error('would create a cycle'))
        : Promise.resolve({ id: 'MMR-99' });
    });
    const { onOpenChange } = renderSheet();
    await sheetReady();

    await user.type(screen.getByLabelText('Title'), 'Wire auth');
    await user.type(screen.getByRole('combobox'), 'auth');
    await user.click(await screen.findByRole('option', { name: /MMR-40/ }));
    await user.click(screen.getByRole('button', { name: 'Create ↵' }));

    await user.click(await screen.findByRole('button', { name: 'Retry deps ↵' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));

    // Exactly one node was ever created; the depend was attempted twice.
    const posts = apiSend.mock.calls.filter((c: unknown[]) => c[1] === '/api/nodes');
    expect(posts).toHaveLength(1);
    const depends = apiSend.mock.calls.filter(
      (c: unknown[]) => c[1] === '/api/nodes/MMR-99/depend',
    );
    expect(depends).toHaveLength(2);
  });

  it('esc closes the innermost popup first — the HOME dropdown — not the sheet', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderSheet();
    await sheetReady();

    await user.type(screen.getByLabelText('Title'), 'Precious typing');
    await user.click(screen.getByRole('button', { expanded: false, name: /home/i }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Title')).toHaveValue('Precious typing');

    // With no popup open, esc dismisses the sheet itself.
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('links the HOME trigger to its listbox via aria-controls', async () => {
    const user = userEvent.setup();
    renderSheet();
    await sheetReady();

    const trigger = screen.getByRole('button', { expanded: false, name: /home/i });
    expect(trigger).toHaveAttribute('aria-controls', 'authoring-home-options');

    await user.click(trigger);
    expect(screen.getByRole('listbox')).toHaveAttribute('id', 'authoring-home-options');
  });

  it('esc closes the open DEPENDS-ON results list before the sheet', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderSheet();
    await sheetReady();

    await user.type(screen.getByRole('combobox'), 'auth');
    await screen.findByRole('option', { name: /MMR-40/ });

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('option', { name: /MMR-40/ })).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('type segments follow the radiogroup pattern: arrows move selection, one tab stop', async () => {
    const user = userEvent.setup();
    renderSheet();
    await sheetReady();

    const taskSegment = screen.getByRole('radio', { name: 'Task' });
    expect(taskSegment).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Phase' })).toHaveAttribute('tabindex', '-1');

    taskSegment.focus();
    await user.keyboard('{ArrowRight}');
    const phase = screen.getByRole('radio', { name: 'Phase' });
    expect(phase).toBeChecked();
    expect(phase).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'Task' })).toHaveAttribute('tabindex', '-1');

    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('radio', { name: 'Task' })).toBeChecked();
  });

  it('exposes the arrow-highlighted dep option to AT via aria-activedescendant', async () => {
    const user = userEvent.setup();
    renderSheet();
    await sheetReady();

    const box = screen.getByRole('combobox');
    expect(box).not.toHaveAttribute('aria-activedescendant');
    await user.type(box, 'auth');
    await screen.findByRole('option', { name: /MMR-40/ });
    expect(box).toHaveAttribute('aria-activedescendant', 'authoring-dep-option-MMR-40');

    await user.keyboard('{ArrowDown}');
    expect(box).toHaveAttribute('aria-activedescendant', 'authoring-dep-option-MMR-41');
    expect(screen.getByRole('option', { name: /MMR-41/ })).toHaveAttribute(
      'id',
      'authoring-dep-option-MMR-41',
    );
  });

  it('create another resets the form, refocuses the title, and stays open', async () => {
    const user = userEvent.setup();
    apiSend.mockResolvedValue({ id: 'MMR-99' });
    const { onOpenChange } = renderSheet();
    await sheetReady();

    await user.click(screen.getByLabelText('create another'));
    await user.type(screen.getByLabelText('Title'), 'First of many');
    await user.click(screen.getByRole('button', { name: 'Create ↵' }));

    await waitFor(() => expect(screen.getByLabelText('Title')).toHaveValue(''));
    expect(screen.getByLabelText('Title')).toHaveFocus();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('create & open routes to the fresh node and closes', async () => {
    const user = userEvent.setup();
    apiSend.mockResolvedValue({ id: 'MMR-99' });
    const { onOpenChange, onOpenNode } = renderSheet();
    await sheetReady();

    await user.type(screen.getByLabelText('Title'), 'Open me');
    await user.click(screen.getByRole('button', { name: 'Create & open' }));

    await waitFor(() => expect(onOpenNode).toHaveBeenCalledWith('MMR-99'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('creates a phase with type=phase and no task-only signal fields', async () => {
    const user = userEvent.setup();
    apiSend.mockResolvedValue({ id: 'MMR-50' });
    renderSheet();
    await sheetReady();

    await user.click(screen.getByRole('radio', { name: 'Phase' }));
    // DEPENDS ON is task-level — hidden for containers
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Title'), 'Hardening');
    await user.click(screen.getByRole('button', { name: 'Create ↵' }));

    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes', {
        parent: 'MMR-1',
        title: 'Hardening',
        type: 'phase',
      });
    });
  });

  it('creates an initiative homed on the bare project KEY', async () => {
    const user = userEvent.setup();
    apiSend.mockResolvedValue({ id: 'MMR-51' });
    renderSheet();
    await sheetReady();

    await user.click(screen.getByRole('radio', { name: 'Initiative' }));
    await user.type(screen.getByLabelText('Title'), 'Meridian');
    await user.click(screen.getByRole('button', { name: 'Create ↵' }));

    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes', {
        parent: 'MMR',
        title: 'Meridian',
        type: 'initiative',
      });
    });
  });

  it('signals expand to priority/size pills and tags; the picks ride the POST', async () => {
    const user = userEvent.setup();
    apiSend.mockResolvedValue({ id: 'MMR-99' });
    renderSheet();
    await sheetReady();

    await user.type(screen.getByLabelText('Title'), 'Signal-rich');
    await user.click(screen.getByRole('button', { name: /signals · optional/i }));
    await user.click(screen.getByRole('button', { name: 'p1' }));
    await user.click(screen.getByRole('button', { name: 's' }));
    await user.click(screen.getByRole('button', { name: '+ tag' }));
    await user.type(screen.getByLabelText('Tags'), 'ui, meridian');
    await user.keyboard('{Enter}');

    await user.click(screen.getByRole('button', { name: 'Create ↵' }));
    await waitFor(() => {
      expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes', {
        parent: 'MMR-1',
        priority: 'p1',
        size: 'small',
        tags: ['ui', 'meridian'],
        title: 'Signal-rich',
        type: 'task',
      });
    });
  });

  it('offline disables both create buttons', async () => {
    renderSheet({ offline: true });
    await sheetReady();
    expect(screen.getByRole('button', { name: 'Create ↵' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create & open' })).toBeDisabled();
  });

  it('blocks create while the title is empty', async () => {
    renderSheet();
    await sheetReady();
    expect(screen.getByRole('button', { name: 'Create ↵' })).toBeDisabled();
  });

  it('pre-fills title, description, and home for the promote seam (MMR-248)', async () => {
    renderSheet({
      headerSlot: <span>Promote seed</span>,
      prefill: { description: 'From a seed.', home: 'MMR-7', title: 'Promoted' },
    });
    await screen.findByText('Phase 5 — UI');
    expect(screen.getByLabelText('Title')).toHaveValue('Promoted');
    expect(screen.getByLabelText('Description')).toHaveValue('From a seed.');
    expect(screen.getByText('Promote seed')).toBeInTheDocument();
    expect(screen.queryByText('New')).not.toBeInTheDocument();
  });

  describe('promote mode (24a, MMR-248)', () => {
    it('locks the type, shows the provenance strip, and swaps the footer', async () => {
      renderSheet({
        headerSlot: <span>Promote seed</span>,
        prefill: { title: 'Tree lens scroll' },
        promote: { kind: 'bug', seedId: 'MMR-s1' },
      });
      await promoteReady();

      // a seed germinates into a task — the type selector is gone, not just hidden
      expect(screen.queryByRole('radio', { name: 'Task' })).not.toBeInTheDocument();
      // DEPENDS ON is present but collapsed by default — the field stays hidden
      // until the disclosure is opened (deps are chained onto the spawned task)
      expect(screen.getByRole('button', { name: /depends on · optional/i })).toBeInTheDocument();
      expect(screen.queryByPlaceholderText('search tasks…')).not.toBeInTheDocument();
      // provenance contract, verbatim — and the word "dispose" appears nowhere
      expect(document.body.textContent).toContain(
        'The task links back to MMR-s1; when it settles, the seed surfaces as ready to resolve — your verdict, never auto-closed.',
      );
      expect(document.body.textContent?.toLowerCase()).not.toContain('dispose');
      // footer: promote microcopy + actions replace create-another / Create
      expect(screen.getByText(/seed stays in the queue as/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Promote & open' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Create ↵' })).not.toBeInTheDocument();
      expect(screen.queryByLabelText('create another')).not.toBeInTheDocument();
    });

    it('submits to the promote endpoint with the edited body, never the create route', async () => {
      const user = userEvent.setup();
      apiSend.mockResolvedValue({ created: 'MMR-42', id: 'MMR-s1', lifecycle: 'promoted' });
      const { onOpenChange } = renderSheet({
        headerSlot: <span>Promote seed</span>,
        prefill: { description: 'Repro steps.', title: 'Tree lens scroll' },
        promote: { kind: 'bug', seedId: 'MMR-s1' },
      });
      await promoteReady();

      await user.click(screen.getByRole('button', { name: 'Promote ↵' }));
      await waitFor(() => {
        // parent is the suggested standing home (MMR-9 'Polish'), the lone ∞ container
        expect(apiSend).toHaveBeenCalledWith('POST', '/api/seeds/MMR-s1/promote', {
          description: 'Repro steps.',
          parent: 'MMR-9',
          title: 'Tree lens scroll',
        });
      });
      expect(apiSend).not.toHaveBeenCalledWith('POST', '/api/nodes', expect.anything());
      expect(toast.success).toHaveBeenCalledWith('Promoted MMR-s1 → MMR-42');
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });

    it('promote & open routes to the spawned task and closes', async () => {
      const user = userEvent.setup();
      apiSend.mockResolvedValue({ created: 'MMR-42', id: 'MMR-s1', lifecycle: 'promoted' });
      const { onOpenChange, onOpenNode } = renderSheet({
        headerSlot: <span>Promote seed</span>,
        prefill: { title: 'Tree lens scroll' },
        promote: { kind: 'bug', seedId: 'MMR-s1' },
      });
      await promoteReady();

      await user.click(screen.getByRole('button', { name: 'Promote & open' }));
      await waitFor(() => expect(onOpenNode).toHaveBeenCalledWith('MMR-42'));
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('suggests the lone standing home for a bug and labels it', async () => {
      renderSheet({
        headerSlot: <span>Promote seed</span>,
        prefill: { title: 'x' },
        promote: { kind: 'bug', seedId: 'MMR-s1' },
      });
      await promoteReady();
      // MMR-9 'Polish' is the only open-ended container → the suggested home
      expect(screen.getByText('suggested — bug → standing home')).toBeInTheDocument();
      expect(screen.getByText('Polish')).toBeInTheDocument();
    });

    it('offers no suggestion for a non-bug kind — silent first-home fallback', async () => {
      renderSheet({
        headerSlot: <span>Promote seed</span>,
        prefill: { title: 'x' },
        promote: { kind: 'idea', seedId: 'MMR-s2' },
      });
      await promoteReady();
      expect(screen.queryByText('suggested — bug → standing home')).not.toBeInTheDocument();
      // the picker falls back to the first legal home, silently
      expect(screen.getByText('build')).toBeInTheDocument();
    });

    it('offers no suggestion when the project has no standing home, even for a bug', async () => {
      renderSheet({
        headerSlot: <span>Promote seed</span>,
        prefill: { title: 'x' },
        projectKey: 'WEB',
        promote: { kind: 'bug', seedId: 'WEB-s1' },
      });
      await promoteReady();
      expect(screen.queryByText('suggested — bug → standing home')).not.toBeInTheDocument();
      expect(screen.getByText('launch')).toBeInTheDocument();
    });

    it('expands DEPENDS ON and chains /depend onto the spawned task after promote', async () => {
      const user = userEvent.setup();
      apiSend.mockImplementation((_method: string, path: string) =>
        path.endsWith('/promote')
          ? Promise.resolve({ created: 'MMR-42', id: 'MMR-s1', lifecycle: 'promoted' })
          : Promise.resolve({ id: 'MMR-42' }),
      );
      const { onOpenChange } = renderSheet({
        headerSlot: <span>Promote seed</span>,
        prefill: { title: 'Tree lens scroll' },
        promote: { kind: 'bug', seedId: 'MMR-s1' },
      });
      await promoteReady();

      // the field is collapsed by default — open the disclosure, then pick a dep
      await user.click(screen.getByRole('button', { name: /depends on · optional/i }));
      await user.type(screen.getByRole('combobox'), 'auth');
      await user.click(await screen.findByRole('option', { name: /MMR-40/ }));

      await user.click(screen.getByRole('button', { name: 'Promote ↵' }));
      await waitFor(() => {
        // the promote POST carries no deps…
        expect(apiSend).toHaveBeenCalledWith('POST', '/api/seeds/MMR-s1/promote', {
          parent: 'MMR-9',
          title: 'Tree lens scroll',
        });
        // …they are chained onto the echoed spawned id
        expect(apiSend).toHaveBeenCalledWith('POST', '/api/nodes/MMR-42/depend', {
          on: ['MMR-40'],
        });
      });
      expect(toast.success).toHaveBeenCalledWith('Promoted MMR-s1 → MMR-42');
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });

    it('surfaces a partial failure honestly when the deps chain fails after promote', async () => {
      const user = userEvent.setup();
      apiSend.mockImplementation((_method: string, path: string) =>
        path.endsWith('/promote')
          ? Promise.resolve({ created: 'MMR-42', id: 'MMR-s1', lifecycle: 'promoted' })
          : Promise.reject(new Error('would create a cycle')),
      );
      const { onOpenChange } = renderSheet({
        headerSlot: <span>Promote seed</span>,
        prefill: { title: 'Tree lens scroll' },
        promote: { kind: 'bug', seedId: 'MMR-s1' },
      });
      await promoteReady();

      await user.click(screen.getByRole('button', { name: /depends on · optional/i }));
      await user.type(screen.getByRole('combobox'), 'auth');
      await user.click(await screen.findByRole('option', { name: /MMR-40/ }));
      await user.click(screen.getByRole('button', { name: 'Promote ↵' }));

      // the task exists — the honest recap names the spawned id, not a success
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('MMR-42')),
      );
      expect(toast.success).not.toHaveBeenCalled();
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });
  });
});

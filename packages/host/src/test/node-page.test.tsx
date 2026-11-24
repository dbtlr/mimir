import type { EngineNode } from '@mimir/contract';
import { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  annotate,
  done,
  getNode,
  groom,
  move,
  park,
  returnTask,
  stage,
  scratchList,
  start,
  tag,
  unqueue,
  untag,
  update,
} from '../api/fns/nodes';
import { nodeWork } from '../api/fns/views';
import { POLL_MS } from '../api/queries';
import { createQueryClient } from '../api/query-client';
import { toast } from '../components/patterns/notice';
import { consoleRoutes } from '../router';
import { serveBrowse } from './browse-fns';
import { engineTree } from './engine-fixtures';
import { engineContainer, engineNote, engineTag, engineTask, scratchpadRow } from './node-fixtures';
import type { ScratchpadRow } from './node-fixtures';
import { failNotes, serveNodes } from './node-fns';
import { renderRoute } from './router';
import { serveShell } from './shell-fns';
import { stubViewport } from './viewport';
import { serveViews } from './views-fns';

vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/views');
vi.mock('../components/patterns/notice', async (orig) => ({
  // oxlint-disable-next-line typescript/consistent-type-imports
  ...(await orig<typeof import('../components/patterns/notice')>()),
  toast: { error: vi.fn(), success: vi.fn() },
}));

const TREE = engineTree({ id: 'MMR', status: 'in_progress', title: 'Mimir', type: 'project' }, [
  engineTree(
    { id: 'MMR-1', status: 'ready', title: 'Hosted and external backends', type: 'initiative' },
    [
      engineTree(
        {
          id: 'MMR-2',
          parent: 'MMR-1',
          status: 'ready',
          title: 'SQLite replaces Norn',
          type: 'phase',
        },
        [engineTree({ id: 'MMR-417', parent: 'MMR-2', status: 'ready', type: 'task' })],
      ),
    ],
  ),
]);

/** What a case adds to the world beyond the node itself. */
type Extra = { notes?: ReturnType<typeof engineNote>[]; scratchpads?: ScratchpadRow[] };

/** Serve `node` and its notes, the MMR tree, and the Scratchpads. */
function serve(node: EngineNode, extra: Extra = {}) {
  serveShell({ trees: { MMR: TREE } });
  return serveNodes({
    nodes: [node],
    notes: { [node.id]: extra.notes ?? [] },
    scratchpads: extra.scratchpads ?? [],
  });
}

const quietClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const sqlite = engineTask({
  description: 'SQLite dialect over `bun:sqlite`.',
  id: 'MMR-417',
  parent: 'MMR-2',
  status: 'ready',
  title: 'Add the SQLite dialect',
});

beforeEach(() => {
  serveBrowse();
  serveViews();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The tag and untag writes issued for one node, in order. */
function tagWrites(id: string) {
  return [...vi.mocked(tag).mock.calls, ...vi.mocked(untag).mock.calls].filter(([options]) =>
    options.data.ids.includes(id),
  );
}

/** Open the record header's More, which is a bottom sheet below md, and return it. */
async function openMore() {
  await userEvent.click(await screen.findByRole('button', { name: 'More' }));
  return screen.findByRole('dialog');
}

/** Choose the row named `name` from More. */
async function chooseMore(name: string) {
  const sheet = await openMore();
  await userEvent.click(within(sheet).getByRole('button', { name }));
}

/** More's rows, in order, with its separators as `—` and the sheet's Cancel left off. */
async function moreRows() {
  const sheet = await openMore();
  return [...sheet.querySelectorAll('button, [data-slot="separator"], [role="separator"]')]
    .map((el) => (el.tagName === 'BUTTON' ? (el.textContent ?? '') : '—'))
    .filter((row) => row !== 'Cancel');
}

/** The names of a header's actions, leaving out its trail's "…". */
const actionsOf = (head: HTMLElement) =>
  within(head)
    .getAllByRole('button')
    .filter((button) => button.closest('nav') === null)
    .map((button) => button.textContent);

/** The classes of the open More sheet's row named `name`. */
const rowClasses = (name: string) =>
  within(screen.getByRole('dialog')).getByRole('button', { name }).classList;

/** The page's tab names, in order. */
const tabNames = () => screen.getAllByRole('tab').map((tab) => tab.textContent);

/** The record header of the page. */
async function header() {
  const title = await screen.findByRole('heading', { level: 1 });
  return title.closest('header') as HTMLElement;
}

/** Render the task page for `node` and wait for its desktop rail. */
async function openTask(node: EngineNode, extra: Extra = {}) {
  serve(node, extra);
  await renderRoute(consoleRoutes, `/p/MMR/${node.id.replace('MMR-', '')}`, quietClient());
  return screen.findByRole('complementary', { name: 'Record details' });
}

describe('task page (MMR-449)', () => {
  it('opens a task directly at its URL, and appends a note to it', async () => {
    serve(sqlite);
    await renderRoute(consoleRoutes, '/p/MMR/417', quietClient());

    await expect(
      screen.findByRole('heading', { level: 1, name: 'Add the SQLite dialect' }),
    ).resolves.toBeDefined();
    expect(screen.getByText('bun:sqlite')).toBeDefined();
    expect(screen.getByRole('textbox', { name: /note/i })).toBeDefined();
    // The server function mocks ignore facets, so the request is checked here.
    expect(getNode).toHaveBeenCalledWith({
      data: expect.objectContaining({ facets: expect.arrayContaining(['deps']), id: 'MMR-417' }),
    });
    await waitFor(() => {
      expect(scratchList).toHaveBeenCalledWith({ data: { project: 'MMR' } });
    });

    await userEvent.type(screen.getByRole('textbox', { name: /note/i }), 'next steps');
    await userEvent.click(screen.getByRole('button', { name: 'Append note' }));
    await waitFor(() => {
      expect(annotate).toHaveBeenCalledWith({ data: { content: 'next steps', id: 'MMR-417' } });
    });
  });

  it('heads the page with its trail, title, status line, summary, grooming chip, then its actions', async () => {
    serve({
      ...sqlite,
      grooming: 'groomed',
      lifecycle: 'todo',
      summary: 'One dialect, two stores.',
    });
    await renderRoute(consoleRoutes, '/p/MMR/417', quietClient());

    const head = await header();
    const parts = [
      within(head).getByRole('navigation', { name: 'Ancestors' }),
      within(head).getByRole('heading', { level: 1, name: 'Add the SQLite dialect' }),
      within(head).getByText('Task'),
      within(head).getByText('One dialect, two stores.'),
      within(head).getByText('groomed'),
      within(head).getByRole('button', { name: 'Start' }),
      within(head).getByRole('button', { name: 'More' }),
    ];
    for (const [before, after] of parts.slice(0, -1).map((part, i) => [part, parts[i + 1]!])) {
      // oxlint-disable-next-line no-bitwise -- DOM position flags are a bit mask
      expect(
        before!.compareDocumentPosition(after!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    // The status, a hairline, then the type and the ID, in that order.
    expect(head.textContent?.replaceAll(/\s+/g, ' ')).toContain('Ready Task MMR-417');
  });

  it('trails its project and parent, folding the ancestors between them into "…" on a phone', async () => {
    serve(sqlite);
    await renderRoute(consoleRoutes, '/p/MMR/417', quietClient());

    const trail = await screen.findByRole('navigation', { name: 'Ancestors' });
    await within(trail).findByRole('link', { name: 'SQLite replaces Norn' });
    expect(
      within(trail)
        .getAllByRole('link')
        .map((l) => l.getAttribute('href')),
    ).toStrictEqual(['/p/MMR', '/p/MMR/2']);
    // No arrow of any kind: the trail is the way up.
    expect(trail.textContent).not.toMatch(/[↑←]/);
    await userEvent.click(within(trail).getByRole('button', { name: 'Show 1 more ancestor' }));
    expect(
      within(trail)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toStrictEqual(['Mimir', 'Hosted and external backends', 'SQLite replaces Norn']);
  });

  it('shows every ancestor on desktop, where the trail has room', async () => {
    stubViewport('desktop');
    serve(sqlite);
    await renderRoute(consoleRoutes, '/p/MMR/417', quietClient());

    const trail = await screen.findByRole('navigation', { name: 'Ancestors' });
    await within(trail).findByRole('link', { name: 'SQLite replaces Norn' });
    expect(within(trail).getAllByRole('link')).toHaveLength(3);
    expect(within(trail).queryByRole('button')).toBeNull();
  });

  it('links the project when no container holds the task', async () => {
    const loose = engineTask({
      id: 'MMR-9',
      parent: 'MMR',
      status: 'ready',
      title: 'A loose task',
    });
    serve(loose);
    serveShell({
      trees: {
        MMR: engineTree({ id: 'MMR', status: 'in_progress', title: 'Mimir', type: 'project' }, [
          engineTree({
            id: 'MMR-9',
            parent: 'MMR',
            status: 'ready',
            title: 'A loose task',
            type: 'task',
          }),
        ]),
      },
    });
    await renderRoute(consoleRoutes, '/p/MMR/9', quietClient());

    // The brand is also named Mimir, but it sits in the top bar, outside the page.
    await screen.findByRole('heading', { level: 1 });
    const parent = within(screen.getByRole('main')).getByRole('link', { name: 'Mimir' });
    expect(parent.getAttribute('href')).toBe('/p/MMR');
  });

  it('redirects a bare id, in any case, to the record page', async () => {
    serve(sqlite);
    const { router: testRouter } = await renderRoute(consoleRoutes, '/mmr-417', quietClient());

    await expect(
      screen.findByRole('heading', { level: 1, name: 'Add the SQLite dialect' }),
    ).resolves.toBeDefined();
    expect(testRouter.state.location.pathname).toBe('/p/MMR/417');
  });

  it('redirects a bare project key to the project page', async () => {
    serve(sqlite);
    const { router: testRouter } = await renderRoute(consoleRoutes, '/MMR', quietClient());

    await waitFor(() => {
      expect(testRouter.state.location.pathname).toBe('/p/MMR');
    });
  });

  it('shows its own not-found state when no record has the id', async () => {
    serveShell({ trees: { MMR: TREE } });
    serveNodes({ nodes: [] });
    await renderRoute(consoleRoutes, '/p/MMR/999', quietClient());

    await expect(screen.findByText(/no record MMR-999/i)).resolves.toBeDefined();
    expect(screen.queryByText(/offline — last synced/i)).toBeNull();
  });

  it('names no node for a suffix that is not a node id, without a lookup', async () => {
    serve(sqlite);
    await renderRoute(consoleRoutes, '/p/MMR/x41', quietClient());

    await expect(screen.findByText(/no record at \/p\/MMR\/x41/i)).resolves.toBeDefined();
    expect(getNode).not.toHaveBeenCalled();
  });

  it('labels the verdict block Review, with Approve and Send back… in the header alone', async () => {
    serve({ ...sqlite, externalRef: 'https://github.com/x/pull/360', status: 'under_review' });
    await renderRoute(consoleRoutes, '/p/MMR/417', quietClient());

    await expect(screen.findByText('Review')).resolves.toBeDefined();
    expect(screen.queryByText(/needs your verdict/i)).toBeNull();
    const head = await header();
    expect(actionsOf(head)).toStrictEqual(['Approve', 'Send back…', 'More']);
    expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Send back…' })).toHaveLength(1);
  });

  it.each([
    ['ready', { status: 'ready' as const }, ['Start', 'More']],
    [
      'in progress, an agent at work',
      { lifecycle: 'in_progress' as const, status: 'in_progress' as const },
      ['More'],
    ],
    ['awaiting what it depends on', { status: 'awaiting' as const }, ['More']],
    ['blocked', { hold: 'blocked' as const, status: 'blocked' as const }, ['More']],
    ['done', { lifecycle: 'done' as const, status: 'done' as const }, ['More']],
  ])('offers the main action its state calls for: %s', async (_name, state, buttons) => {
    serve({ ...sqlite, ...state });
    await renderRoute(consoleRoutes, '/p/MMR/417', quietClient());

    const head = await header();
    expect(actionsOf(head)).toStrictEqual(buttons);
  });

  it('groups More as Edit, then status changes, then holds, then Abandon… alone and in red', async () => {
    serve(sqlite);
    await renderRoute(consoleRoutes, '/p/MMR/417', quietClient());

    await expect(moreRows()).resolves.toStrictEqual([
      'Edit',
      'Move…',
      '—',
      'Park for later…',
      'Mark blocked…',
      '—',
      'Abandon…',
    ]);
    // The red label as a class of its own, not inside a state selector every row carries.
    expect(rowClasses('Abandon…')).toContain('text-status-blocked-foreground');
    expect(rowClasses('Park for later…')).not.toContain('text-status-blocked-foreground');
  });

  it('lists the status changes the main action leaves, before the holds', async () => {
    serve({ ...sqlite, lifecycle: 'in_progress', status: 'in_progress' });
    await renderRoute(consoleRoutes, '/p/MMR/417', quietClient());

    await expect(moreRows()).resolves.toStrictEqual([
      'Edit',
      'Move…',
      '—',
      'Submit for review',
      'Mark done',
      '—',
      'Park for later…',
      'Mark blocked…',
      '—',
      'Abandon…',
    ]);
  });

  it('offers a container no verdict and no task actions, whatever its rollup reads', async () => {
    serve({
      ...engineContainer({
        id: 'MMR-2',
        parent: 'MMR-1',
        status: 'under_review',
        title: 'SQLite replaces Norn',
        type: 'phase',
      }),
    });
    await renderRoute(consoleRoutes, '/p/MMR/2', quietClient());

    await expect(
      screen.findByRole('heading', { level: 1, name: 'SQLite replaces Norn' }),
    ).resolves.toBeDefined();
    expect(screen.queryByText(/needs your verdict/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /park/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Actions' })).toBeNull();
  });

  it('links what the task depends on and what it blocks to their pages', async () => {
    serve({
      ...sqlite,
      deps: {
        awaitingOn: [],
        blocking: [{ id: 'MMR-418', status: 'awaiting', title: 'Remove the Norn backend' }],
        dependsOn: [{ id: 'MMR-416', status: 'done', title: 'Extract a dialect seam' }],
      },
    });
    await renderRoute(consoleRoutes, '/p/MMR/417', quietClient());

    const rail = await screen.findByRole('complementary', { name: 'Record details' });
    expect(
      within(rail)
        .getByRole('link', { name: /MMR-416/ })
        .getAttribute('href'),
    ).toBe('/p/MMR/416');
    expect(
      within(rail)
        .getByRole('link', { name: /MMR-418/ })
        .getAttribute('href'),
    ).toBe('/p/MMR/418');
  });

  it('links each of its artifacts to the artifact page (MMR-452)', async () => {
    serve({
      ...sqlite,
      artifacts: [
        {
          createdAt: new Date('2026-06-10T00:00:00.000Z'),
          id: 'MMR-a3',
          tags: [],
          title: 'Dialect spec',
        },
      ],
    });
    await renderRoute(consoleRoutes, '/p/MMR/417', quietClient());

    const rail = await screen.findByRole('complementary', { name: 'Record details' });
    expect(within(rail).getByRole('link', { name: /Dialect spec/ })).toHaveAttribute(
      'href',
      '/p/MMR/a3',
    );
  });

  it('each rail chip opens its part of the rail in a sheet', async () => {
    serve({
      ...sqlite,
      deps: {
        awaitingOn: [],
        blocking: [{ id: 'MMR-418', status: 'awaiting', title: 'Remove the Norn backend' }],
        dependsOn: [{ id: 'MMR-416', status: 'done', title: 'Extract a dialect seam' }],
      },
    });
    await renderRoute(consoleRoutes, '/p/MMR/417', quietClient());

    const chips = await screen.findByRole('group', { name: 'Record details' });
    fireEvent.click(within(chips).getByRole('button', { name: /links/i }));

    const sheet = await screen.findByRole('dialog', { name: /links/i });
    expect(
      within(sheet)
        .getByRole('link', { name: /MMR-416/ })
        .getAttribute('href'),
    ).toBe('/p/MMR/416');
  });

  it('shows where an agent is working on it, with its Scratchpad', async () => {
    serve(
      { ...sqlite, branch: 'feat/mmr-417-sqlite', harness: 'claude-code', status: 'in_progress' },
      {
        scratchpads: [
          scratchpadRow({
            id: 'a',
            linkedWork: ['MMR-417'],
            openAgenda: 1,
            title: 'SQLite cutover episode',
          }),
          scratchpadRow({ id: 'b', linkedWork: ['MMR-12'], title: 'Unrelated episode' }),
        ],
      },
    );
    await renderRoute(consoleRoutes, '/p/MMR/417', quietClient());

    const rail = await screen.findByRole('complementary', { name: 'Record details' });
    await expect(within(rail).findByText('SQLite cutover episode')).resolves.toBeDefined();
    expect(within(rail).getByText('claude-code')).toBeDefined();
    expect(within(rail).getByText('feat/mmr-417-sqlite')).toBeDefined();
    expect(within(rail).queryByText('Unrelated episode')).toBeNull();
  });

  it('shows the main conversation and the distinct whole-task worker', async () => {
    serve({
      ...sqlite,
      harness: 'codex',
      session: 'main-conversation',
      status: 'in_progress',
      workerHarness: 'claude',
      workerSession: 'task-worker',
    });
    await renderRoute(consoleRoutes, '/p/MMR/417', quietClient());
    const rail = await screen.findByRole('complementary', { name: 'Record details' });
    await expect(within(rail).findByText('main-conversation')).resolves.toBeDefined();
    expect(within(rail).getByText('Main session')).toBeDefined();
    expect(within(rail).getByText('Worker session')).toBeDefined();
    expect(within(rail).getByText('task-worker')).toBeDefined();
  });

  it('closes a sheet when a link in it is chosen, not when its text is', async () => {
    serve({
      ...sqlite,
      deps: {
        awaitingOn: [],
        blocking: [],
        dependsOn: [{ id: 'MMR-416', status: 'done', title: 'Extract a dialect seam' }],
      },
    });
    await renderRoute(consoleRoutes, '/p/MMR/417', quietClient());
    const chips = await screen.findByRole('group', { name: 'Record details' });

    fireEvent.click(within(chips).getByRole('button', { name: /details/i }));
    const details = await screen.findByRole('dialog', { name: /details/i });
    fireEvent.click(within(details).getByText('created'));
    expect(screen.getByRole('dialog', { name: /details/i })).toBeDefined();
    fireEvent.click(within(details).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    fireEvent.click(within(chips).getByRole('button', { name: /links/i }));
    const links = await screen.findByRole('dialog', { name: /links/i });
    fireEvent.click(within(links).getByRole('link', { name: /MMR-416/ }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /links/i })).toBeNull();
    });
  });

  it('retires the Actions chip and part of the rail, keeping Links, Agent, and Details', async () => {
    serve({ ...sqlite, harness: 'claude-code', status: 'in_progress' });
    await renderRoute(consoleRoutes, '/p/MMR/417', quietClient());

    const chips = await screen.findByRole('group', { name: 'Record details' });
    expect(
      within(chips)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toStrictEqual(['Links0', 'Agent', 'Details']);
    const rail = screen.getByRole('complementary', { name: 'Record details' });
    expect(within(rail).queryByRole('heading', { name: 'Actions' })).toBeNull();
    expect(within(rail).queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('shows the sessions and links the reason on the transition that settled the task', async () => {
    await openTask({
      ...sqlite,
      history: [
        {
          at: new Date('2026-06-04T09:00:00.000Z'),
          from: 'in_progress',
          handles: {
            harness: 'codex',
            session: 'conversation',
            worker_harness: 'claude',
            worker_session: 'build-session',
          },
          kind: 'lifecycle',
          reason: 'Shipped in https://example.com/pull/9.',
          to: 'done',
        },
      ],
      status: 'done',
    });

    // Each handle is its own part of the line (MMR-718), so match the handles' whole text.
    await expect(
      screen.findByText(
        (_, el) =>
          el?.tagName === 'SPAN' &&
          el.textContent?.replaceAll('\u00a0', ' ').trim() ===
            'Main codex/conversation · Worker claude/build-session',
      ),
    ).resolves.toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'https://example.com/pull/9' });
    expect(link.getAttribute('href')).toBe('https://example.com/pull/9');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.closest('p')?.textContent).toContain(' — Shipped in https://example.com/pull/9.');
  });

  it('sets the actions aside while the edit form is open', async () => {
    serve(sqlite);
    await renderRoute(consoleRoutes, '/p/MMR/417', quietClient());

    await chooseMore('Edit');
    await screen.findByLabelText(/tags/i);
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
  });
});

describe('container page (MMR-450)', () => {
  const phase: EngineNode = engineContainer({
    description: 'Swap the **store** under the board.',
    id: 'MMR-2',
    next: 'Land the dialect first.\n\nThen remove the Norn backend.',
    parent: 'MMR-1',
    status: 'ready',
    title: 'SQLite replaces Norn',
    type: 'phase',
  });

  it('holds its direction in full in Details, rewritten from More rather than in place', async () => {
    serve(phase);
    await renderRoute(consoleRoutes, '/p/MMR/2?tab=details', quietClient());

    const panel = await screen.findByRole('tabpanel');
    await within(panel).findByText('Land the dialect first.');
    expect(within(panel).getByText('Then remove the Norn backend.')).toBeDefined();
    expect(within(panel).getByText('store').tagName).toBe('STRONG');
    expect(within(panel).queryByRole('button', { name: /Edit/ })).toBeNull();
  });

  it('says so in a quiet line at the body size when no direction is set', async () => {
    serve({ ...phase, next: undefined });
    await renderRoute(consoleRoutes, '/p/MMR/2?tab=details', quietClient());

    const quiet = await within(await screen.findByRole('tabpanel')).findByText('No direction set.');
    expect(quiet.classList).toContain('text-body');
    expect(quiet.classList).toContain('text-ink');
  });

  it('opens as the work page, with its path, its sections, and no task actions', async () => {
    serve(phase);
    await renderRoute(consoleRoutes, '/p/MMR/2', quietClient());

    await expect(
      screen.findByRole('heading', { level: 1, name: 'SQLite replaces Norn' }),
    ).resolves.toBeDefined();
    // The status line's ID is mono inside a sans line (MMR-718), so match the line's whole text.
    expect((await header()).textContent?.replaceAll(/\s+/g, ' ')).toContain('Ready Phase MMR-2');
    expect(
      screen.getByRole('link', { name: /Hosted and external backends/ }).getAttribute('href'),
    ).toBe('/p/MMR/1');
    for (const name of ['Now', 'Needs you', 'Frontier', 'Shipped', 'Going cold']) {
      // oxlint-disable-next-line no-await-in-loop -- one section at a time reads clearest
      await expect(screen.findByRole('region', { name })).resolves.toBeDefined();
    }
    expect(screen.queryByRole('region', { name: /contents/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('asks for the work of its own subtree', async () => {
    serve(phase);
    await renderRoute(consoleRoutes, '/p/MMR/2', quietClient());

    await screen.findByRole('region', { name: 'Now' });
    expect(nodeWork).toHaveBeenCalledWith({ data: { id: 'MMR-2', timeZone: 'America/New_York' } });
  });

  it('an initiative opens as the work page too, its parent the project', async () => {
    serve({
      ...phase,
      id: 'MMR-1',
      parent: null,
      title: 'Hosted and external backends',
      type: 'initiative',
    });
    await renderRoute(consoleRoutes, '/p/MMR/1', quietClient());

    await screen.findByRole('heading', { level: 1 });
    const parent = within(screen.getByRole('main')).getByRole('link', { name: 'Mimir' });
    expect(parent.getAttribute('href')).toBe('/p/MMR');
    await expect(screen.findByRole('region', { name: 'Frontier' })).resolves.toBeDefined();
  });

  it('retires the rail and its Direction, About, and Artifacts chips', async () => {
    serve(phase);
    await renderRoute(consoleRoutes, '/p/MMR/2', quietClient());

    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('complementary', { name: 'Record details' })).toBeNull();
    for (const chip of ['Direction', 'About', 'Artifacts']) {
      expect(screen.queryByRole('button', { name: chip })).toBeNull();
    }
  });

  it('makes New task its main action, filing into itself, with Edit direction… in More', async () => {
    serve(phase);
    await renderRoute(consoleRoutes, '/p/MMR/2', quietClient());

    const head = await header();
    expect(actionsOf(head)).toStrictEqual(['New task', 'More']);
    await expect(moreRows()).resolves.toStrictEqual(['Edit direction…']);
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Edit direction…' }),
    );
    await expect(screen.findByRole('textbox', { name: 'Direction text' })).resolves.toHaveValue(
      'Land the dialect first.\n\nThen remove the Norn backend.',
    );
  });

  it('disables New task and Edit direction… while offline', async () => {
    serve(phase);
    failNotes();
    await renderRoute(consoleRoutes, '/p/MMR/2', quietClient());

    await screen.findByText(/Offline/);
    expect(within(await header()).getByRole('button', { name: 'New task' })).toBeDisabled();
    const sheet = await openMore();
    expect(within(sheet).getByRole('button', { name: 'Edit direction…' })).toBeDisabled();
  });

  it('returns focus to More when Edit direction… closes', async () => {
    serve(phase);
    await renderRoute(consoleRoutes, '/p/MMR/2', quietClient());

    await chooseMore('Edit direction…');
    await screen.findByRole('textbox', { name: 'Direction text' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'More' })).toHaveFocus();
    });
  });

  it('lists what it depends on and what it blocks in Details, each status a dot and a bright word', async () => {
    serve({
      ...phase,
      deps: {
        awaitingOn: [],
        blocking: [{ id: 'MMR-758', status: 'awaiting', title: 'Daily briefing' }],
        dependsOn: [{ id: 'MMR-702', status: 'done', title: 'The decisions walkthrough' }],
      },
      target: '2026-11-30',
    });
    await renderRoute(consoleRoutes, '/p/MMR/2?tab=details', quietClient());

    const depends = await screen.findByRole('region', { name: 'Depends on 1' });
    const row = within(depends).getByRole('link', { name: /MMR-702/ });
    expect(row.getAttribute('href')).toBe('/p/MMR/702');
    expect(within(row).getByText('Done').className).toContain('text-ink-bright');
    expect(within(row).getByText('MMR-702').className).toContain('font-mono');
    expect(
      within(screen.getByRole('region', { name: 'Blocking 1' })).getByRole('link', {
        name: /MMR-758/,
      }),
    ).toBeDefined();
    const facts = screen.getByRole('region', { name: 'Facts' });
    expect(within(facts).getByText('Target')).toBeDefined();
    expect(within(facts).getByText('2026-11-30')).toBeDefined();
  });

  describe('tabs', () => {
    const withNote = { notes: [engineNote('Settled the dialect seam')] };

    it('opens on Work, with Details and the Timeline a tab away, and hides an empty Artifacts', async () => {
      serve(phase, withNote);
      await renderRoute(consoleRoutes, '/p/MMR/2', quietClient());

      await expect(
        screen.findByRole('tab', { name: 'Work', selected: true }),
      ).resolves.toBeDefined();
      expect(tabNames()).toStrictEqual(['Work ', 'Details ', 'Timeline 2']);
      await expect(screen.findByRole('region', { name: 'Now' })).resolves.toBeDefined();
      expect(screen.queryByText('Settled the dialect seam')).toBeNull();
    });

    it('shows Artifacts with its count once one is attached, listing them', async () => {
      serve(
        {
          ...phase,
          artifacts: [{ createdAt: new Date(), id: 'MMR-a3', tags: [], title: 'Dialect spec' }],
        },
        withNote,
      );
      await renderRoute(consoleRoutes, '/p/MMR/2?tab=artifacts', quietClient());

      await expect(
        screen.findByRole('tab', { name: 'Artifacts 1', selected: true }),
      ).resolves.toBeDefined();
      expect(screen.getByRole('link', { name: /Dialect spec/ })).toHaveAttribute(
        'href',
        '/p/MMR/a3',
      );
    });

    it('Timeline puts ?tab=timeline in the URL and shows the notes and the composer', async () => {
      serve(phase, withNote);
      const { router: testRouter } = await renderRoute(consoleRoutes, '/p/MMR/2', quietClient());

      fireEvent.click(await screen.findByRole('tab', { name: /Timeline/ }));

      await expect(screen.findByText('Settled the dialect seam')).resolves.toBeDefined();
      expect(testRouter.state.location.searchStr).toBe('?tab=timeline');
      expect(screen.getByRole('textbox', { name: /note/i })).toBeDefined();
      expect(screen.getByRole('tab', { name: /Timeline/ })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(screen.queryByRole('region', { name: 'Now' })).toBeNull();
    });

    it('opens on the tab its URL names, as on a reload, and Work takes the parameter back out', async () => {
      serve(phase, withNote);
      const { router: testRouter } = await renderRoute(
        consoleRoutes,
        '/p/MMR/2?tab=timeline',
        quietClient(),
      );

      await expect(screen.findByText('Settled the dialect seam')).resolves.toBeDefined();
      fireEvent.click(screen.getByRole('tab', { name: 'Work' }));

      await expect(screen.findByRole('region', { name: 'Now' })).resolves.toBeDefined();
      expect(testRouter.state.location.searchStr).toBe('');
    });

    it('drops a tab value it does not know', async () => {
      serve(phase, withNote);
      const { router: testRouter } = await renderRoute(
        consoleRoutes,
        '/p/MMR/2?tab=sections',
        quietClient(),
      );

      await expect(screen.findByRole('region', { name: 'Now' })).resolves.toBeDefined();
      expect(testRouter.state.location.searchStr).toBe('');
    });

    it('opens on the first tab with something in it when the one asked for is empty', async () => {
      serve({ ...phase, distribution: {} }, withNote);
      await renderRoute(consoleRoutes, '/p/MMR/2?tab=artifacts', quietClient());

      await expect(
        screen.findByRole('tab', { name: 'Details', selected: true }),
      ).resolves.toBeDefined();
      // A container with no task under it has no Work tab.
      expect(tabNames()).toStrictEqual(['Details ', 'Timeline 2']);
    });

    it('replaces a URL that names a hidden tab with the tab it shows, so the page stays on it', async () => {
      serve({ ...phase, distribution: {} }, withNote);
      const { router: testRouter } = await renderRoute(
        consoleRoutes,
        '/p/MMR/2?tab=artifacts',
        quietClient(),
      );

      await screen.findByRole('tab', { name: 'Details', selected: true });
      await waitFor(() => {
        expect(testRouter.state.location.searchStr).toBe('?tab=details');
      });
      // Replaced, not pushed: Back leaves the page rather than returning to the hidden tab.
      expect(testRouter.history).toHaveLength(1);
    });

    it('keeps ?tab=artifacts while its cached record predates the artifact, and opens it once read', async () => {
      const attached = {
        ...phase,
        artifacts: [{ createdAt: new Date(), id: 'MMR-a3', tags: [], title: 'Dialect spec' }],
      };
      serve(attached, withNote);
      const served = vi.mocked(getNode).getMockImplementation();
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.mocked(getNode).mockImplementation(async (options) => {
        if (options.data.id === 'MMR-2' && options.data.facets?.length !== 1) {
          await held;
        }
        return served!(options);
      });
      const client = quietClient();
      client.setQueryData(['node', 'MMR-2'], phase, { updatedAt: Date.now() - 60_000 });
      const { router: testRouter } = await renderRoute(
        consoleRoutes,
        '/p/MMR/2?tab=artifacts',
        client,
      );

      // The cached record shows the first tab with something in it at once.
      await screen.findByRole('tab', { name: 'Work', selected: true });
      release();

      await screen.findByRole('tab', { name: 'Artifacts 1', selected: true });
      expect(testRouter.state.location.searchStr).toBe('?tab=artifacts');
    });

    it('arrow keys move between the tabs', async () => {
      serve(phase, withNote);
      await renderRoute(consoleRoutes, '/p/MMR/2', quietClient());

      const work = await screen.findByRole('tab', { name: 'Work' });
      work.focus();
      await userEvent.keyboard('{ArrowRight}{ArrowRight}');

      await expect(screen.findByText('Settled the dialect seam')).resolves.toBeDefined();
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: /Timeline/ }));
    });

    it('a task page has no tabs, and ignores the parameter', async () => {
      serve(sqlite);
      await renderRoute(consoleRoutes, '/p/MMR/417?tab=timeline', quietClient());

      await screen.findByRole('heading', { level: 1, name: 'Add the SQLite dialect' });
      expect(screen.queryByRole('tablist')).toBeNull();
      expect(screen.getByRole('heading', { name: /Timeline/ })).toBeDefined();
    });
  });
});

/** Open the edit form for `node` and return its Tags field. */
async function openEdit(node: EngineNode) {
  await openTask(node);
  await chooseMore('Edit');
  return screen.findByLabelText(/tags/i);
}

/** Open a task page whose only timeline note carries `content`. */
async function openWithNote(content: string) {
  await openTask(engineTask({ id: 'MMR-83', status: 'in_progress' }), {
    notes: [engineNote(content)],
  });
}

describe('task page edit (MMR-453)', () => {
  const stamp = '2026-06-01T00:00:00.000Z';

  it('pre-populates the existing tags in the edit form', async () => {
    const tags = await openEdit(
      engineTask({
        id: 'MMR-90',
        status: 'ready',
        tags: [engineTag('ui', stamp), engineTag('release:v0.5', stamp)],
      }),
    );
    expect(tags).toHaveValue('ui, release:v0.5');
  });

  it('saving with a removed tag removes exactly that tag', async () => {
    await userEvent.clear(
      await openEdit(engineTask({ id: 'MMR-92', status: 'ready', tags: [engineTag('ui', stamp)] })),
    );
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(untag).toHaveBeenCalledWith({ data: { ids: ['MMR-92'], tags: ['ui'] } });
    });
    expect(tagWrites('MMR-92')).toHaveLength(1);
  });

  it('saving with unchanged tags fires no tag request, but the scalars still update', async () => {
    await openEdit(engineTask({ id: 'MMR-93', status: 'ready', tags: [engineTag('ui', stamp)] }));
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith({
        data: expect.objectContaining({ id: 'MMR-93' }),
      });
    });
    expect(tagWrites('MMR-93')).toStrictEqual([]);
  });

  it('appending a tag by typing keeps the existing tag intact', async () => {
    // Keystroke-by-keystroke append: a trailing comma must survive mid-typing,
    // or "ui" and "feat" merge into one tag.
    await userEvent.type(
      await openEdit(engineTask({ id: 'MMR-94', status: 'ready', tags: [engineTag('ui', stamp)] })),
      ', feat',
    );
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(tagWrites('MMR-94')).toStrictEqual([[{ data: { ids: ['MMR-94'], tags: ['feat'] } }]]);
    });
  });

  it('one save adds and removes the changed tags and leaves the kept one alone', async () => {
    const tags = await openEdit(
      engineTask({
        id: 'MMR-95',
        status: 'ready',
        tags: [engineTag('keep', stamp), engineTag('drop', stamp)],
      }),
    );
    await userEvent.clear(tags);
    await userEvent.type(tags, 'keep, fresh');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(tagWrites('MMR-95')).toHaveLength(2);
    });
    expect(tag).toHaveBeenCalledWith({ data: { ids: ['MMR-95'], tags: ['fresh'] } });
    expect(untag).toHaveBeenCalledWith({ data: { ids: ['MMR-95'], tags: ['drop'] } });
  });

  it('a failed tag save keeps the edit form open', async () => {
    const tags = await openEdit(engineTask({ id: 'MMR-96', status: 'ready', tags: [] }));
    vi.mocked(tag).mockRejectedValue(new Error('tag write failed'));
    await userEvent.type(tags, 'feat');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(tag).toHaveBeenCalledWith({ data: { ids: ['MMR-96'], tags: ['feat'] } });
    });
    // The partial failure must not close the form back to the record view.
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/tags/i)).toBeInTheDocument();
  });

  it('sends null when the person empties a description that had text', async () => {
    await openEdit(
      engineTask({ description: 'Old prose.', id: 'MMR-66', status: 'ready', tags: [] }),
    );
    await userEvent.clear(screen.getByLabelText(/description/i));
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith({
        data: expect.objectContaining({ description: null, id: 'MMR-66' }),
      });
    });
  });

  it('omits empty optional fields from the PATCH instead of sending nulls', async () => {
    await openEdit(
      engineTask({ description: null, externalRef: null, id: 'MMR-65', status: 'ready' }),
    );
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith({ data: expect.objectContaining({ id: 'MMR-65' }) });
    });
    // A null would be sent as JSON null; an absent (undefined) field is dropped.
    const { data } = vi.mocked(update).mock.calls[0]![0];
    expect(data.description).toBeUndefined();
    expect(data.externalRef).toBeUndefined();
  });
});

describe('task page verbs (MMR-453)', () => {
  it('a plain verb fires immediately', async () => {
    await openTask(engineTask({ id: 'MMR-51', status: 'ready' }));

    await userEvent.click(within(await header()).getByRole('button', { name: 'Start' }));

    expect(start).toHaveBeenCalledWith({ data: { id: 'MMR-51' } });
  });

  it('a verb that needs a reason asks for it first, then fires with it', async () => {
    await openTask(engineTask({ id: 'MMR-51', status: 'ready' }));

    await chooseMore('Park for later…');
    expect(park).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByRole('textbox'), 'later');
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }));

    expect(park).toHaveBeenCalledWith({ data: { id: 'MMR-51', reason: 'later' } });
  });

  it('cancels a queued task only after a reason is supplied', async () => {
    await openTask(engineTask({ id: 'MMR-417', lifecycle: 'queued', status: 'queued' }));

    await chooseMore('Cancel reservation…');
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByRole('textbox'), 'run cancelled');
    await userEvent.click(confirm);

    await waitFor(() => {
      expect(unqueue).toHaveBeenCalledWith({ data: { id: 'MMR-417', reason: 'run cancelled' } });
    });
  });

  it('Stage on a task under review fires stage, and a staged task offers done and return', async () => {
    await openTask(engineTask({ id: 'MMR-70', lifecycle: 'under_review', status: 'under_review' }));

    await chooseMore('Stage');

    expect(stage).toHaveBeenCalledWith({ data: { id: 'MMR-70' } });
  });

  it('offers a staged task done and return but not stage', async () => {
    await openTask(engineTask({ id: 'MMR-71', lifecycle: 'staged', status: 'staged' }));

    const rows = await moreRows();
    expect(rows).toContain('Mark done');
    expect(rows).toContain('Send back…');
    expect(rows).not.toContain('Stage');
  });

  it('Approve in the header fires done', async () => {
    await openTask(
      engineTask({
        externalRef: 'https://example.test/pr/41',
        id: 'MMR-70',
        status: 'under_review',
      }),
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    expect(done).toHaveBeenCalledWith({ data: { id: 'MMR-70' } });
  });

  it('Send back… in the header fires return with the reason entered', async () => {
    await openTask(
      engineTask({
        externalRef: 'https://example.test/pr/41',
        id: 'MMR-70',
        status: 'under_review',
      }),
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Send back…' }));
    expect(returnTask).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog', { name: 'Send back' });
    await userEvent.type(within(dialog).getByRole('textbox'), 'Cover the empty case');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(returnTask).toHaveBeenCalledWith({
        data: { id: 'MMR-70', reason: 'Cover the empty case' },
      });
    });
  });

  it('Send back… with no reason fires return without a reason field', async () => {
    await openTask(
      engineTask({
        externalRef: 'https://example.test/pr/41',
        id: 'MMR-70',
        status: 'under_review',
      }),
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Send back…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send back' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(returnTask).toHaveBeenCalledTimes(1);
    });
    const [options] = vi.mocked(returnTask).mock.calls[0]!;
    expect(options.data).toEqual({ id: 'MMR-70' });
    expect(options.data).not.toHaveProperty('reason');
  });

  it('keeps the verdict block neutral: no attention hue on the block or anything in it', async () => {
    await openTask(
      engineTask({
        externalRef: 'https://example.test/pr/41',
        id: 'MMR-70',
        status: 'under_review',
      }),
    );

    const block = (await screen.findByText('Review')).parentElement!;
    expect(block).toHaveTextContent('example.test/pr/41');
    expect(block.className).not.toMatch(/attention/);
    expect(block.querySelectorAll('[class*="attention"]')).toHaveLength(0);
  });

  it('offline disables Edit, Move…, Set grooming…, and the verbs', async () => {
    const node = engineTask({ grooming: 'groomed', id: 'MMR-51', status: 'ready' });
    serve(node);
    // An errored read over loaded data is the console's offline signal.
    failNotes();
    await renderRoute(consoleRoutes, '/p/MMR/51', quietClient());

    await waitFor(async () => {
      expect(within(await header()).getByRole('button', { name: 'Start' })).toBeDisabled();
    });
    const sheet = await openMore();
    for (const name of ['Edit', 'Move…', 'Set grooming…', 'Park for later…', 'Abandon…']) {
      expect(within(sheet).getByRole('button', { name })).toBeDisabled();
    }
  });
});

describe('task page move (MMR-453)', () => {
  it('Move… picks a new parent and moves the task there', async () => {
    await openTask(sqlite);

    await chooseMore('Move…');
    // Options render once the tree loads (which also enables the select).
    await screen.findByRole('option', { name: /Hosted and external backends/ });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'New parent' }), 'MMR-1');
    await userEvent.click(screen.getByRole('button', { name: 'Move' }));

    expect(move).toHaveBeenCalledWith({ data: { id: 'MMR-417', to: 'MMR-1' } });
  });
});

describe('task page content (MMR-453)', () => {
  it('renders a dependency in both depends_on and awaiting_on as one row, with the awaiting reading', async () => {
    const rail = await openTask(
      engineTask({
        deps: {
          awaitingOn: [{ id: 'MMR-20', status: 'blocked', title: 'still gating' }],
          blocking: [],
          dependsOn: [{ id: 'MMR-20', status: 'done', title: 'still gating (stale)' }],
        },
        id: 'MMR-21',
        status: 'in_progress',
      }),
    );

    expect(within(rail).getAllByText('MMR-20')).toHaveLength(1);
    expect(within(rail).getByText('still gating')).toBeDefined();
    expect(within(rail).queryByText('still gating (stale)')).toBeNull();
  });

  describe('note clamp toggle', () => {
    const proto = HTMLElement.prototype;
    const original = {
      client: Object.getOwnPropertyDescriptor(proto, 'clientHeight'),
      scroll: Object.getOwnPropertyDescriptor(proto, 'scrollHeight'),
    };

    /** jsdom has no layout; stub the two heights the note measures. */
    function stubHeights(scrollHeight: number, clientHeight: number) {
      Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => scrollHeight });
      Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => clientHeight });
    }

    beforeEach(() => {
      // jsdom has no computed line-height; the clamp reads it off the article.
      const real = globalThis.getComputedStyle.bind(globalThis);
      vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((el, pseudo) =>
        el.tagName === 'ARTICLE'
          ? ({ lineHeight: '20px' } as CSSStyleDeclaration)
          : real(el, pseudo),
      );
    });

    afterEach(() => {
      vi.restoreAllMocks();
      for (const [name, descriptor] of [
        ['clientHeight', original.client],
        ['scrollHeight', original.scroll],
      ] as const) {
        if (descriptor === undefined) {
          Reflect.deleteProperty(proto, name);
        } else {
          Object.defineProperty(proto, name, descriptor);
        }
      }
    });

    it('offers "Show all" with the rendered line count when the note overflows, and toggles the clamp', async () => {
      stubHeights(200, 60);
      await openWithNote('- one\n- two\n- three');

      // 200px of content at a 20px line-height: ten rendered lines.
      const toggle = await screen.findByRole('button', { name: 'Show all · 10 lines ⌄' });
      const article = screen.getByText('three').closest('article');
      expect(article).toHaveAttribute('data-clamped');
      await userEvent.click(toggle);
      expect(screen.getByRole('button', { name: 'Show less ⌃' })).toBeInTheDocument();
      expect(article).not.toHaveAttribute('data-clamped');
      await userEvent.click(screen.getByRole('button', { name: 'Show less ⌃' }));
      expect(screen.getByRole('button', { name: 'Show all · 10 lines ⌄' })).toBeInTheDocument();
      expect(article).toHaveAttribute('data-clamped');
    });

    it('offers no toggle when the note fits its clamp', async () => {
      stubHeights(60, 60);
      await openWithNote('- one\n- two\n- three');

      await screen.findByText('three');
      expect(screen.queryByRole('button', { name: /show (all|less)/i })).toBeNull();
    });
  });
});

describe('live refresh (MMR-458)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a note added outside the console within one poll', async () => {
    // Real time keeps ticking so findBy can still poll under the fake clock.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    serve(sqlite);
    await renderRoute(consoleRoutes, '/p/MMR/417', createQueryClient());
    await screen.findByRole('heading', { level: 1, name: 'Add the SQLite dialect' });

    serve(sqlite, { notes: [engineNote('Annotated from the CLI', '2026-06-02T10:00:00.000Z')] });
    expect(screen.queryByText('Annotated from the CLI')).toBeNull();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    await expect(screen.findByText('Annotated from the CLI')).resolves.toBeDefined();
  });
});

const groomed = () => engineTask({ grooming: 'groomed', id: 'MMR-51', status: 'ready' });

/** The task read requests issued so far for MMR-51. */
const taskReads = () =>
  vi
    .mocked(getNode)
    .mock.calls.filter(
      ([options]) => options.data.id === 'MMR-51' && options.data.facets?.length !== 1,
    );

describe('task page grooming state (MMR-466)', () => {
  it('shows the state in the header and as a Grooming row in Details', async () => {
    const rail = await openTask(groomed());

    const article = screen.getByRole('article');
    expect(within(article).getByText('groomed')).toBeDefined();
    expect(within(rail).getByText('grooming')).toBeDefined();
    expect(within(rail).getByText('groomed')).toBeDefined();
  });

  it('still shows the state on a todo task that is blocked', async () => {
    await openTask(
      engineTask({
        grooming: 'groomed',
        hold: 'blocked',
        holdReason: 'why',
        id: 'MMR-51',
        status: 'blocked',
      }),
    );

    expect(within(screen.getByRole('article')).getByText('groomed')).toBeDefined();
  });

  it('keeps the dialog open and toasts the error when the request fails', async () => {
    await openTask(groomed());
    vi.mocked(groom).mockRejectedValue(new Error('needs_answers requires a note'));

    await chooseMore('Set grooming…');
    const dialog = await screen.findByRole('dialog', { name: 'Grooming state' });
    await userEvent.click(within(dialog).getByRole('radio', { name: /^not groomed/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Set grooming' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('needs_answers requires a note');
    });
    expect(screen.getByRole('dialog', { name: 'Grooming state' })).toBeDefined();
  });

  it('shows no state once the task has started', async () => {
    const rail = await openTask(
      engineTask({
        grooming: 'groomed',
        id: 'MMR-51',
        lifecycle: 'in_progress',
        status: 'in_progress',
      }),
    );

    expect(screen.queryByText('groomed')).toBeNull();
    expect(within(rail).queryByText('grooming')).toBeNull();
    await expect(moreRows()).resolves.not.toContain('Set grooming…');
  });

  it('shows no state on a container', async () => {
    serve({
      ...engineContainer({ id: 'MMR-2', status: 'ready', type: 'phase' }),
      grooming: 'groomed',
    });
    await renderRoute(consoleRoutes, '/p/MMR/2', quietClient());

    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText('groomed')).toBeNull();
    await expect(moreRows()).resolves.not.toContain('Set grooming…');
  });

  it('sets the state without a note unless it needs answers', async () => {
    await openTask(engineTask({ grooming: 'not_groomed', id: 'MMR-51', status: 'ready' }));

    await chooseMore('Set grooming…');
    const dialog = await screen.findByRole('dialog', { name: 'Grooming state' });
    await userEvent.click(within(dialog).getByRole('radio', { name: /^groomed/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Set grooming' }));

    expect(groom).toHaveBeenCalledWith({ data: { ids: ['MMR-51'], state: 'groomed' } });
  });

  it('needs a note before it sets needs answers, and sends it with the state', async () => {
    await openTask(groomed());

    await chooseMore('Set grooming…');
    const dialog = await screen.findByRole('dialog', { name: 'Grooming state' });
    await userEvent.click(within(dialog).getByRole('radio', { name: /^needs answers/ }));
    const submit = within(dialog).getByRole('button', { name: 'Set grooming' });
    expect(submit).toBeDisabled();

    const note = within(dialog).getByRole('textbox', { name: /open questions/i });
    await userEvent.type(note, '   ');
    expect(submit).toBeDisabled();
    await userEvent.type(note, 'Which backend wins?');
    expect(submit).toBeEnabled();
    await userEvent.click(submit);

    expect(groom).toHaveBeenCalledWith({
      data: { ids: ['MMR-51'], note: 'Which backend wins?', state: 'needs_answers' },
    });
  });

  it('refetches the task after the state is set', async () => {
    await openTask(groomed());
    const before = taskReads().length;

    await chooseMore('Set grooming…');
    const dialog = await screen.findByRole('dialog', { name: 'Grooming state' });
    await userEvent.click(within(dialog).getByRole('radio', { name: /^not groomed/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Set grooming' }));

    await waitFor(() => {
      expect(taskReads().length).toBeGreaterThan(before);
    });
  });

  it('is offered beside Edit in More, before the status changes', async () => {
    serve(groomed());
    await renderRoute(consoleRoutes, '/p/MMR/51', quietClient());

    expect((await moreRows()).slice(0, 4)).toStrictEqual(['Edit', 'Move…', 'Set grooming…', '—']);
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Set grooming…' }),
    );

    await expect(screen.findByRole('dialog', { name: 'Grooming state' })).resolves.toBeDefined();
  });
});

describe('task page hold callout (MMR-466)', () => {
  it.each([
    ['you', 'Blocked on you', 'Needs an API token'],
    ['others', 'Blocked on others', null],
  ] as const)(
    'names who can clear a block owned by %s, with or without a reason',
    async (owner, label, reason) => {
      await openTask(
        engineTask({
          blockOwner: owner,
          hold: 'blocked',
          holdReason: reason,
          id: 'MMR-51',
          status: 'blocked',
        }),
      );

      const article = screen.getByRole('article');
      expect(within(article).getByText(label)).toBeDefined();
      expect(article).toHaveTextContent(reason ?? label);
    },
  );

  it('links a URL in the hold reason, opening in a new tab', async () => {
    await openTask(
      engineTask({
        blockOwner: 'you',
        hold: 'blocked',
        holdReason: 'Pick a variant from https://example.com/a/b.',
        id: 'MMR-51',
        status: 'blocked',
      }),
    );

    const link = within(screen.getByRole('article')).getByRole('link', {
      name: 'https://example.com/a/b',
    });
    expect(link.getAttribute('href')).toBe('https://example.com/a/b');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('shows no callout for a parked task with no reason', async () => {
    await openTask(
      engineTask({ hold: 'parked', holdReason: null, id: 'MMR-51', status: 'parked' }),
    );

    expect(within(screen.getByRole('article')).queryByText('parked')).toBeNull();
  });

  it('keeps the plain hold name for a parked task, which has no owner', async () => {
    await openTask(
      engineTask({ hold: 'parked', holdReason: 'later', id: 'MMR-51', status: 'parked' }),
    );

    const article = screen.getByRole('article');
    expect(within(article).getByText('parked')).toBeDefined();
    expect(within(article).queryByText(/Blocked on/)).toBeNull();
  });
});

describe('a record change closes what the container header opened (MMR-726)', () => {
  it('Back from one phase to a cached one closes the Direction editor and writes nothing', async () => {
    const a = engineContainer({
      id: 'MMR-2',
      next: 'A direction.',
      parent: 'MMR',
      status: 'ready',
      title: 'Phase A',
      type: 'phase',
    });
    const b = engineContainer({
      id: 'MMR-3',
      next: 'B direction.',
      parent: 'MMR',
      status: 'ready',
      title: 'Phase B',
      type: 'phase',
    });
    serveShell({ trees: { MMR: engineTree({ id: 'MMR', status: 'ready', type: 'project' }) } });
    serveNodes({ nodes: [a, b], notes: { 'MMR-2': [], 'MMR-3': [] } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { router } = await renderRoute(consoleRoutes, '/p/MMR/2?tab=details', client);
    await screen.findByRole('heading', { level: 1, name: 'Phase A' });
    await act(async () => {
      await router.navigate({
        params: { key: 'MMR', seq: '3' },
        search: { tab: 'details' },
        to: '/p/$key/$seq',
      });
    });
    await screen.findByRole('heading', { level: 1, name: 'Phase B' });
    await userEvent.click(await screen.findByRole('button', { name: 'More' }));
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Edit direction…' }),
    );
    const draft = await screen.findByRole('textbox', { name: 'Direction text' });
    await userEvent.clear(draft);
    await userEvent.type(draft, 'New B direction.');
    act(() => {
      router.history.back();
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/p/MMR/2');
    });
    await screen.findByRole('heading', { hidden: true, level: 1, name: 'Phase A' });
    expect(screen.queryByRole('textbox', { name: 'Direction text' })).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });
});

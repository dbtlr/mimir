import type { EngineNode } from '@mimir/contract';
import { QueryClient } from '@tanstack/react-query';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { groomCard } from '../api/fns/agent';
import {
  annotate,
  done,
  getNode,
  park,
  returnTask,
  stage,
  scratchList,
  start,
  unqueue,
  update,
} from '../api/fns/nodes';
import { t3Origin } from '../api/fns/t3';
import { nodeWork } from '../api/fns/views';
import { POLL_MS } from '../api/queries';
import { createQueryClient } from '../api/query-client';
import { RecordTimeline } from '../components/node-timeline';
import { buildFeed } from '../lib/timeline';
import { consoleRoutes } from '../router';
import { readyCard } from './agent-fixtures';
import { serveBrowse } from './browse-fns';
import { FIXTURE_AT, engineTree } from './engine-fixtures';
import { engineContainer, engineNote, engineTag, engineTask, scratchpadRow } from './node-fixtures';
import type { ScratchpadRow } from './node-fixtures';
import { failNotes, serveNodes } from './node-fns';
import { renderInRouter, renderRoute } from './router';
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

/** Render the task page for `node`, on `tab` when one is given, and return the open tab's panel. */
async function openTask(node: EngineNode, extra: Extra = {}, tab?: string) {
  serve(node, extra);
  const search = tab === undefined ? '' : `?tab=${tab}`;
  const rendered = await renderRoute(
    consoleRoutes,
    `/p/MMR/${node.id.replace('MMR-', '')}${search}`,
    quietClient(),
  );
  await screen.findByRole('heading', { level: 1 });
  return { panel: await screen.findByRole('tabpanel'), router: rendered.router };
}

describe('task page (MMR-449)', () => {
  it('opens a task directly at its URL, and appends a note to it', async () => {
    serve(sqlite);
    await renderRoute(consoleRoutes, '/p/MMR/417', quietClient());

    await expect(
      screen.findByRole('heading', { level: 1, name: 'Add the SQLite dialect' }),
    ).resolves.toBeDefined();
    expect(screen.getByText('bun:sqlite')).toBeDefined();
    // The server function mocks ignore facets, so the request is checked here.
    expect(getNode).toHaveBeenCalledWith({
      data: expect.objectContaining({ facets: expect.arrayContaining(['deps']), id: 'MMR-417' }),
    });
    await waitFor(() => {
      expect(scratchList).toHaveBeenCalledWith({ data: { project: 'MMR' } });
    });

    fireEvent.click(screen.getByRole('tab', { name: /Timeline/ }));
    await userEvent.type(await screen.findByRole('textbox', { name: /note/i }), 'next steps');
    await userEvent.click(screen.getByRole('button', { name: 'Add note' }));
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

  it('heads the review banner Submitted for review, with Approve and Send back… in the header alone', async () => {
    serve({ ...sqlite, externalRef: 'https://github.com/x/pull/360', status: 'under_review' });
    await renderRoute(consoleRoutes, '/p/MMR/417', quietClient());

    await expect(
      screen.findByRole('region', { name: 'Submitted for review' }),
    ).resolves.toBeDefined();
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
    [
      'blocked on others',
      { blockOwner: 'others' as const, hold: 'blocked' as const, status: 'blocked' as const },
      ['More'],
    ],
    [
      'blocked on you',
      { blockOwner: 'you' as const, hold: 'blocked' as const, status: 'blocked' as const },
      ['Unblock', 'More'],
    ],
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

  it('lists what the task depends on and what it blocks on Work, each a link to its page', async () => {
    const { panel } = await openTask({
      ...sqlite,
      deps: {
        awaitingOn: [],
        blocking: [{ id: 'MMR-418', status: 'awaiting', title: 'Remove the Norn backend' }],
        dependsOn: [{ id: 'MMR-416', status: 'done', title: 'Extract a dialect seam' }],
      },
    });

    const depends = within(panel).getByRole('region', { name: 'Depends on 1' });
    const row = within(depends).getByRole('link', { name: /Extract a dialect seam/ });
    expect(row).toHaveAttribute('href', '/p/MMR/416');
    expect(within(row).getByText('MMR-416').className).toContain('font-mono');
    expect(within(row).getByText('Done').className).toContain('text-ink-bright');
    const blocks = within(panel).getByRole('region', { name: 'Blocks 1' });
    expect(within(blocks).getByRole('link', { name: /Remove the Norn backend/ })).toHaveAttribute(
      'href',
      '/p/MMR/418',
    );
  });

  it('holds no rail and no chips: the task page is the one column under its tabs', async () => {
    await openTask({ ...sqlite, harness: 'claude-code', status: 'in_progress' });

    expect(screen.queryByRole('complementary', { name: 'Record details' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Record details' })).toBeNull();
    for (const chip of [/^Links/, /^Agent$/]) {
      expect(screen.queryByRole('button', { name: chip })).toBeNull();
    }
    expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
    expect(screen.getByTestId('record-scroll')).toContainElement(screen.getByRole('tablist'));
  });

  it('shows the sessions and links the reason on the transition that settled the task', async () => {
    await openTask(
      {
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
      },
      {},
      'timeline',
    );

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
      const held = Promise.withResolvers<void>();
      vi.mocked(getNode).mockImplementation(async (options) => {
        if (options.data.id === 'MMR-2' && options.data.facets?.length !== 1) {
          await held.promise;
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
      held.resolve();

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

    it('folds its Timeline by day as a task page does, the composer on top', async () => {
      serve(phase, { notes: THREE_NOTES });
      await renderRoute(consoleRoutes, '/p/MMR/2?tab=timeline', quietClient());

      const panel = await screen.findByRole('tabpanel');
      await within(panel).findByText('Afternoon note');
      expect(foldsOf(panel)).toStrictEqual([
        ['Wednesday, 3 June 2', 'true'],
        ['Monday, 1 June 2', 'false'],
      ]);
      expect(within(panel).getByRole('button', { name: 'Add note' })).toBeDisabled();
    });
  });
});

/** Three notes over two days: one on Monday 1 June, two on Wednesday 3 June (New York). */
const THREE_NOTES = [
  engineNote('Older day note', '2026-06-01T15:00:00.000Z'),
  engineNote('Morning note', '2026-06-03T14:00:00.000Z'),
  engineNote('Afternoon note', '2026-06-03T18:00:00.000Z'),
];

/** Each day fold's trigger in `panel`: its text, and whether it is open. */
const foldsOf = (panel: HTMLElement) =>
  within(panel)
    .getAllByRole('button')
    .filter((button) => button.hasAttribute('aria-expanded'))
    .map((button) => [button.textContent, button.getAttribute('aria-expanded')]);

/** The timeline row that holds `text`. */
const rowOf = (text: string) => screen.getByText(text).closest('li') as HTMLElement;

/** `before` comes before `after` in the document. */
function precedes(before: Element, after: Element): boolean {
  // oxlint-disable-next-line no-bitwise -- DOM position flags are a bit mask
  return (before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe('task page tabs (MMR-728)', () => {
  const withNote = { notes: [engineNote('Settled the dialect seam')] };

  it('opens on Work, with Details and the Timeline a tab away, and hides an empty Artifacts', async () => {
    const { panel } = await openTask(sqlite, withNote);

    await screen.findByRole('tab', { name: 'Timeline 2' });
    expect(screen.getByRole('tab', { name: 'Work', selected: true })).toBeDefined();
    expect(tabNames()).toStrictEqual(['Work ', 'Details ', 'Timeline 2']);
    expect(within(panel).getByText('bun:sqlite')).toBeDefined();
    expect(screen.queryByText('Settled the dialect seam')).toBeNull();
  });

  it('puts the tab it opens in the URL, and Work takes the parameter back out', async () => {
    const { router } = await openTask(sqlite, withNote);

    fireEvent.click(screen.getByRole('tab', { name: /Timeline/ }));
    await expect(screen.findByText('Settled the dialect seam')).resolves.toBeDefined();
    expect(router.state.location.searchStr).toBe('?tab=timeline');
    fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
    await screen.findByRole('heading', { level: 2, name: 'Record' });
    expect(router.state.location.searchStr).toBe('?tab=details');
    fireEvent.click(screen.getByRole('tab', { name: 'Work' }));
    await screen.findByText('bun:sqlite');
    expect(router.state.location.searchStr).toBe('');
  });

  it('keeps an unsent note when another tab opens and the Timeline comes back', async () => {
    await openTask(sqlite, withNote, 'timeline');

    await userEvent.type(await screen.findByRole('textbox', { name: /note/i }), 'half a thought');
    fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
    await screen.findByRole('heading', { level: 2, name: 'Record' });
    fireEvent.click(screen.getByRole('tab', { name: /Timeline/ }));

    const box = await screen.findByRole('textbox', { name: /note/i });
    expect(box).toHaveValue('half a thought');
    // The draft lives for the page load; empty it so no later test opens MMR-417 holding it.
    fireEvent.change(box, { target: { value: '' } });
  });

  it('opens on the tab its URL names, as on a reload', async () => {
    await openTask(sqlite, withNote, 'timeline');

    await expect(screen.findByText('Settled the dialect seam')).resolves.toBeDefined();
    expect(screen.getByRole('tab', { name: /Timeline/, selected: true })).toBeDefined();
  });

  it('drops a tab value it does not know', async () => {
    const { router } = await openTask(sqlite, withNote, 'sections');

    await expect(screen.findByRole('tab', { name: 'Work', selected: true })).resolves.toBeDefined();
    expect(router.state.location.searchStr).toBe('');
  });

  it('replaces ?tab=artifacts with Work while the task has none, so Back leaves the page', async () => {
    const { router } = await openTask(sqlite, withNote, 'artifacts');

    await expect(screen.findByRole('tab', { name: 'Work', selected: true })).resolves.toBeDefined();
    await waitFor(() => {
      expect(router.state.location.searchStr).toBe('');
    });
    expect(router.history).toHaveLength(1);
  });

  it('shows Artifacts with its count once one is attached, each a link to its page', async () => {
    await openTask(
      {
        ...sqlite,
        artifacts: [
          {
            createdAt: new Date('2026-06-10T00:00:00.000Z'),
            id: 'MMR-a3',
            tags: [],
            title: 'Dialect spec',
          },
        ],
      },
      {},
      'artifacts',
    );

    await expect(
      screen.findByRole('tab', { name: 'Artifacts 1', selected: true }),
    ).resolves.toBeDefined();
    expect(screen.getByRole('link', { name: /Dialect spec/ })).toHaveAttribute('href', '/p/MMR/a3');
  });

  it('lists the artifacts as the Artifacts list does: folded by day, each row its title, kind, and time, a 44 target', async () => {
    const { panel } = await openTask(
      {
        ...sqlite,
        artifacts: [
          {
            createdAt: new Date('2026-06-09T09:05:00.000Z'),
            id: 'MMR-a2',
            tags: [],
            title: 'Seam notes',
          },
          {
            createdAt: new Date('2026-06-10T14:52:00.000Z'),
            id: 'MMR-a3',
            tags: ['kind:spec'],
            title: 'Dialect spec',
          },
        ],
      },
      {},
      'artifacts',
    );

    const row = await within(panel).findByRole('link', { name: /Dialect spec/ });
    expect(row).toHaveClass('min-h-11', 'md:min-h-9');
    expect(within(row).getByText('Dialect spec')).toHaveClass('text-title', 'text-ink-bright');
    expect(within(row).getByText('Spec')).toBeDefined();
    expect(within(row).getByText('10:52')).toBeDefined();
    expect(foldsOf(panel)).toStrictEqual([
      ['Wednesday, 10 June 1', 'true'],
      ['Tuesday, 9 June 1', 'false'],
    ]);
  });

  it('keeps ?tab=artifacts while its cached record predates the artifact, and opens it once read', async () => {
    const attached = {
      ...sqlite,
      artifacts: [{ createdAt: new Date(), id: 'MMR-a3', tags: [], title: 'Dialect spec' }],
    };
    serve(attached, withNote);
    const served = vi.mocked(getNode).getMockImplementation();
    const held = Promise.withResolvers<void>();
    vi.mocked(getNode).mockImplementation(async (options) => {
      if (options.data.id === 'MMR-417' && options.data.facets?.length !== 1) {
        await held.promise;
      }
      return served!(options);
    });
    const client = quietClient();
    client.setQueryData(['node', 'MMR-417'], sqlite, { updatedAt: Date.now() - 60_000 });
    const { router: testRouter } = await renderRoute(
      consoleRoutes,
      '/p/MMR/417?tab=artifacts',
      client,
    );

    // The cached record shows Work at once, and leaves the URL alone.
    await screen.findByRole('tab', { name: 'Work', selected: true });
    expect(testRouter.state.location.searchStr).toBe('?tab=artifacts');
    held.resolve();

    await screen.findByRole('tab', { name: 'Artifacts 1', selected: true });
    expect(testRouter.state.location.searchStr).toBe('?tab=artifacts');
  });
});

/** The state banners a Work tab may lead with. */
const BANNER = /^(Agent at work|Submitted for review|Blocked|Parked)/;

/** A task in review since 3 June, carrying `externalRef`. */
const inReview = (externalRef: string | null) =>
  engineTask({
    externalRef,
    history: [
      {
        at: new Date('2026-06-03T10:00:00.000Z'),
        from: 'in_progress',
        kind: 'lifecycle',
        reason: null,
        to: 'under_review',
      },
    ],
    id: 'MMR-70',
    status: 'under_review',
  });

describe('task page state banner (MMR-728)', () => {
  const running = engineTask({
    branch: 'feat/mmr-60-sqlite',
    harness: 'claude-code',
    id: 'MMR-60',
    lifecycle: 'in_progress',
    session: '5c2e9f10',
    status: 'in_progress',
    workerHarness: 'codex',
    workerSession: 'c41e02b9',
  });

  it('shows Agent at work while a run is live: its harness, worker, branch, and latest note', async () => {
    const { panel } = await openTask(running, {
      notes: [
        engineNote('Wired the dialect seam.', '2026-06-02T09:00:00.000Z'),
        engineNote('Next: the migration.', '2026-06-02T10:00:00.000Z'),
      ],
    });

    const banner = within(panel).getByRole('region', { name: 'Agent at work' });
    await within(banner).findByText('Next: the migration.');
    expect(within(banner).queryByText('Wired the dialect seam.')).toBeNull();
    expect(within(banner).getByText('claude-code')).toBeDefined();
    expect(within(banner).getByText('codex')).toBeDefined();
    expect(within(banner).getByText('feat/mmr-60-sqlite')).toBeDefined();
    // The banner comes before the description.
    expect(precedes(banner, within(panel).getByText('No description.'))).toBe(true);
  });

  it('offers Open in T3 on Agent at work when T3 can open the run', async () => {
    vi.mocked(t3Origin).mockResolvedValue({ origin: 'https://t3.example' });
    try {
      const { panel } = await openTask({ ...running, harness: 't3', host: 'asgard' });

      const banner = within(panel).getByRole('region', { name: 'Agent at work' });
      await expect(
        within(banner).findByRole('link', { name: /Open in T3/ }),
      ).resolves.toHaveAttribute('href', 't3code://threads/asgard/5c2e9f10');
    } finally {
      vi.mocked(t3Origin).mockResolvedValue({ origin: null });
    }
  });

  it.each([
    [
      'in progress with no session',
      { harness: 'claude-code', lifecycle: 'in_progress' as const, status: 'in_progress' as const },
    ],
    ['ready, a session left from an earlier run', { session: 'old', status: 'ready' as const }],
    ['done', { lifecycle: 'done' as const, session: 'old', status: 'done' as const }],
  ])('shows no banner while no run is live: %s', async (_name, state) => {
    const { panel } = await openTask(engineTask({ id: 'MMR-61', ...state }));

    expect(within(panel).queryByRole('region', { name: BANNER })).toBeNull();
  });

  const reviewNotes = {
    notes: [
      engineNote('Before the submit.', '2026-06-03T09:00:00.000Z'),
      engineNote('Tests cover all three branches.', '2026-06-03T11:00:00.000Z'),
    ],
  };

  it('shows Submitted for review with what was written since the submit, its PR a link, and no attention hue', async () => {
    const { panel } = await openTask(inReview('https://github.com/x/mimir/pull/653'), reviewNotes);

    const banner = within(panel).getByRole('region', { name: 'Submitted for review' });
    await within(banner).findByText('Tests cover all three branches.');
    expect(within(banner).queryByText('Before the submit.')).toBeNull();
    const pr = within(banner).getByRole('link', { name: /PR #653/ });
    expect(pr).toHaveAttribute('href', 'https://github.com/x/mimir/pull/653');
    expect(pr).toHaveAttribute('target', '_blank');
    expect(banner.className).not.toMatch(/attention/);
    expect(banner.querySelectorAll('[class*="attention"]')).toHaveLength(0);
  });

  it('sizes the external ref as a 44 link fact in the review banner and under Details › Record', async () => {
    const { panel } = await openTask(inReview('https://github.com/x/mimir/pull/653'), reviewNotes);
    const banner = within(panel).getByRole('region', { name: 'Submitted for review' });
    expect(within(banner).getByRole('link', { name: /PR #653/ })).toHaveClass(
      'min-w-11',
      '-my-3',
      'py-3',
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
    const record = await screen.findByRole('region', { name: 'Record' });
    expect(within(record).getByRole('link', { name: /PR #653/ })).toHaveClass(
      'min-w-11',
      '-my-3',
      'py-3',
    );
  });

  it('shows Submitted for review with no PR row when the task has no external ref', async () => {
    const { panel } = await openTask(inReview(null), reviewNotes);

    const banner = within(panel).getByRole('region', { name: 'Submitted for review' });
    await within(banner).findByText('Tests cover all three branches.');
    expect(within(banner).queryByText('Pull request')).toBeNull();
    expect(within(banner).queryByRole('link')).toBeNull();
  });

  it('shows Blocked on you in the attention violet, with its reason', async () => {
    const { panel } = await openTask(
      engineTask({
        blockOwner: 'you',
        hold: 'blocked',
        holdReason: 'Needs an API token',
        id: 'MMR-51',
        status: 'blocked',
      }),
    );

    const banner = within(panel).getByRole('region', { name: 'Blocked on you' });
    expect(banner).toHaveTextContent('Needs an API token');
    expect(banner.className).toMatch(/attention/);
  });

  it('shows Blocked on others in the neutral treatment', async () => {
    const { panel } = await openTask(
      engineTask({
        blockOwner: 'others',
        hold: 'blocked',
        holdReason: 'Waiting on the vendor',
        id: 'MMR-52',
        status: 'blocked',
      }),
    );

    const banner = within(panel).getByRole('region', { name: 'Blocked on others' });
    expect(banner).toHaveTextContent('Waiting on the vendor');
    expect(banner.className).not.toMatch(/attention/);
    expect(banner.querySelectorAll('[class*="attention"]')).toHaveLength(0);
  });

  it('links a URL in the hold reason, opening in a new tab', async () => {
    const { panel } = await openTask(
      engineTask({
        blockOwner: 'you',
        hold: 'blocked',
        holdReason: 'Pick a variant from https://example.com/a/b.',
        id: 'MMR-51',
        status: 'blocked',
      }),
    );

    const link = within(panel).getByRole('link', { name: 'https://example.com/a/b' });
    expect(link.getAttribute('href')).toBe('https://example.com/a/b');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('shows Parked with its reason, and no banner for a park with none', async () => {
    const { panel } = await openTask(
      engineTask({ hold: 'parked', holdReason: 'later', id: 'MMR-53', status: 'parked' }),
    );
    expect(within(panel).getByRole('region', { name: 'Parked' })).toHaveTextContent('later');
    cleanup();

    const quiet = await openTask(
      engineTask({ hold: 'parked', holdReason: null, id: 'MMR-54', status: 'parked' }),
    );
    expect(within(quiet.panel).queryByRole('region', { name: BANNER })).toBeNull();
  });

  it('shows no banner for a park whose reason is only whitespace', async () => {
    const { panel } = await openTask(
      engineTask({ hold: 'parked', holdReason: '  \n ', id: 'MMR-55', status: 'parked' }),
    );

    expect(within(panel).queryByRole('region', { name: BANNER })).toBeNull();
  });

  it('names a block with no owner just Blocked', async () => {
    const { panel } = await openTask(
      engineTask({ blockOwner: null, hold: 'blocked', id: 'MMR-56', status: 'blocked' }),
    );

    expect(within(panel).getByRole('region', { name: 'Blocked' })).toBeDefined();
  });

  it('shows Agent at work for a run that only a worker holds', async () => {
    const { panel } = await openTask(
      engineTask({
        id: 'MMR-63',
        lifecycle: 'in_progress',
        status: 'in_progress',
        workerHarness: 'codex',
        workerSession: 'c41e02b9',
      }),
    );

    expect(within(panel).getByRole('region', { name: 'Agent at work' })).toBeDefined();
  });

  it('labels the worker as Details › Run does: its harness and its session', async () => {
    const { panel } = await openTask({ ...running, harness: null, session: null });

    const banner = within(panel).getByRole('region', { name: 'Agent at work' });
    const worker = within(banner).getByText('Worker').nextElementSibling;
    expect(worker).toHaveTextContent('codex, c41e02b9');
  });

  it('clamps the latest note at three whole lines, with no fade', async () => {
    const { panel } = await openTask(running, { notes: [engineNote('Wired the dialect seam.')] });

    const banner = within(panel).getByRole('region', { name: 'Agent at work' });
    const note = (await within(banner).findByText('Wired the dialect seam.')).closest('article');
    expect(note).toHaveAttribute('data-clamped', '3');
    expect(note?.className).not.toMatch(/mask-image/);
  });

  it('keeps the latest note’s links out of the tab order, so focus never scrolls the clipped preview', async () => {
    const { panel } = await openTask(running, {
      notes: [engineNote('One.\n\nTwo.\n\nThree.\n\nSee [the PR](https://a.test/pr).')],
    });

    const banner = within(panel).getByRole('region', { name: 'Agent at work' });
    const link = await within(banner).findByRole('link', { name: 'the PR' });
    expect(link).toHaveAttribute('tabindex', '-1');
  });

  it('shows the worker on Agent at work when only its session is known', async () => {
    const { panel } = await openTask(
      engineTask({
        id: 'MMR-64',
        lifecycle: 'in_progress',
        status: 'in_progress',
        workerSession: 'c41e02b9',
      }),
    );

    const banner = within(panel).getByRole('region', { name: 'Agent at work' });
    expect(within(banner).getByText('Worker').nextElementSibling).toHaveTextContent(/^c41e02b9$/);
  });

  it('sets the review summary at the body size, 14 / 23', async () => {
    const { panel } = await openTask(inReview(null), reviewNotes);

    const banner = within(panel).getByRole('region', { name: 'Submitted for review' });
    const summary = (await within(banner).findByText('Tests cover all three branches.')).closest(
      'article',
    );
    expect(summary).toHaveClass('text-body', 'leading-[23px]');
  });

  it('sets the banner prose and the description at the body size, 14 / 23', async () => {
    const { panel } = await openTask(
      { ...running, description: 'The dialect seam.' },
      { notes: [engineNote('Wired the dialect seam.')] },
    );

    const banner = within(panel).getByRole('region', { name: 'Agent at work' });
    const note = (await within(banner).findByText('Wired the dialect seam.')).closest('article');
    const description = within(panel).getByText('The dialect seam.').closest('article');
    for (const prose of [note, description]) {
      expect(prose).toHaveClass('text-body', 'leading-[23px]');
    }
  });

  it('labels a review ref that is not a pull request External ref, and leaves a non-URL as text', async () => {
    const { panel } = await openTask(inReview('https://example.com/issues/12'), reviewNotes);

    const banner = within(panel).getByRole('region', { name: 'Submitted for review' });
    expect(within(banner).getByText('External ref')).toBeDefined();
    expect(within(banner).queryByText('Pull request')).toBeNull();
    cleanup();

    const plain = await openTask(inReview('GH-123'), reviewNotes);
    const plainBanner = within(plain.panel).getByRole('region', { name: 'Submitted for review' });
    expect(within(plainBanner).getByText('GH-123')).toBeDefined();
    expect(within(plainBanner).queryByRole('link')).toBeNull();
  });

  it('leaves the Groom with agent card out while a banner shows, and shows it in its place otherwise', async () => {
    vi.mocked(groomCard).mockResolvedValue(readyCard());
    try {
      const ungroomed = {
        grooming: 'not_groomed' as const,
        id: 'MMR-640',
        status: 'ready' as const,
      };
      const free = await openTask(engineTask(ungroomed));
      await expect(
        within(free.panel).findByRole('region', { name: 'Groom with agent' }),
      ).resolves.toBeDefined();
      cleanup();

      const { panel } = await openTask(
        engineTask({
          ...ungroomed,
          blockOwner: 'you',
          hold: 'blocked',
          holdReason: 'Needs an API token',
          status: 'blocked',
        }),
      );
      expect(within(panel).getByRole('region', { name: 'Blocked on you' })).toBeDefined();
      // Long enough for the card's read to answer, had it been asked.
      await expect(
        within(panel).findByRole('region', { name: 'Groom with agent' }, { timeout: 300 }),
      ).rejects.toThrow(/Unable to find role="region"/);
    } finally {
      vi.mocked(groomCard).mockResolvedValue({ state: 'unconfigured' });
    }
  });
});

describe('task page Details (MMR-728)', () => {
  // Submit keeps a run's handles; done, abandon, park, block, and unqueue clear them.
  const ran = engineTask({
    branch: 'feat/mmr-60-sqlite',
    externalRef: 'https://github.com/x/mimir/pull/653',
    harness: 'claude-code',
    host: 'asgard',
    id: 'MMR-60',
    lifecycle: 'under_review',
    session: '5c2e9f10',
    status: 'under_review',
    workerHarness: 'codex',
    workerSession: 'c41e02b9',
  });

  it('heads Details with Status, Record, and Run, and keeps the run facts while the task is in review', async () => {
    const { panel } = await openTask(
      ran,
      {
        scratchpads: [
          scratchpadRow({ id: 'a', linkedWork: ['MMR-60'], title: 'Push click handler' }),
          scratchpadRow({ id: 'b', linkedWork: ['MMR-12'], title: 'Unrelated episode' }),
        ],
      },
      'details',
    );

    expect(
      within(panel)
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent?.trim()),
    ).toStrictEqual(['Status', 'Record', 'Run']);
    const run = within(panel).getByRole('region', { name: 'Run' });
    for (const fact of ['claude-code', '5c2e9f10', 'codex', 'c41e02b9', 'asgard']) {
      expect(within(run).getByText(fact)).toBeDefined();
    }
    expect(within(run).getByText('feat/mmr-60-sqlite')).toBeDefined();
    expect(within(run).getByText('Main session')).toBeDefined();
    expect(within(run).getByText('Worker')).toBeDefined();
    await within(run).findByText('Push click handler');
    expect(within(run).queryByText('Unrelated episode')).toBeNull();
  });

  it('hides Run for a task that never ran', async () => {
    const { panel } = await openTask(sqlite, {}, 'details');

    expect(within(panel).getByRole('region', { name: 'Status' })).toBeDefined();
    expect(within(panel).getByRole('region', { name: 'Record' })).toBeDefined();
    expect(within(panel).queryByRole('region', { name: 'Run' })).toBeNull();
  });

  it('keeps the external ref under Record, so a task that never ran shows no Run', async () => {
    const { panel } = await openTask(
      { ...sqlite, externalRef: 'https://github.com/x/mimir/pull/653' },
      {},
      'details',
    );

    const record = within(panel).getByRole('region', { name: 'Record' });
    expect(within(record).getByText('External ref')).toBeDefined();
    expect(within(record).getByRole('link', { name: /PR #653/ })).toHaveAttribute(
      'href',
      'https://github.com/x/mimir/pull/653',
    );
    expect(within(panel).queryByRole('region', { name: 'Run' })).toBeNull();
  });

  it('shows an external ref that is not a URL as text, not a link', async () => {
    const { panel } = await openTask({ ...sqlite, externalRef: 'GH-123' }, {}, 'details');

    const record = within(panel).getByRole('region', { name: 'Record' });
    expect(within(record).getByText('GH-123')).toBeDefined();
    expect(within(record).queryByRole('link', { name: /GH-123/ })).toBeNull();
  });

  it.each([
    ['a host', { host: 'asgard' }, {}, 'asgard'],
    [
      'an anchored Scratchpad',
      {},
      { scratchpads: [scratchpadRow({ id: 'a', linkedWork: ['MMR-62'], title: 'Episode' })] },
      'Episode',
    ],
  ])('shows Run when the only run fact is %s', async (_name, facts, extra, shown) => {
    const { panel } = await openTask(
      engineTask({ id: 'MMR-62', status: 'ready', ...facts }),
      extra,
      'details',
    );

    const run = await within(panel).findByRole('region', { name: 'Run' });
    expect(within(run).getByText(shown)).toBeDefined();
  });

  it('reads the dates as the timeline does, with the full time in their title', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Wednesday 3 June 2026, noon in the suite's zone (America/New_York).
    vi.setSystemTime(Date.parse('2026-06-03T16:00:00.000Z'));
    try {
      const { panel } = await openTask(
        {
          ...sqlite,
          completedAt: new Date('2026-06-02T20:30:00.000Z'),
          createdAt: new Date('2025-11-23T14:14:00.000Z'),
          updatedAt: new Date('2026-06-03T13:05:00.000Z'),
        },
        {},
        'details',
      );

      const record = within(panel).getByRole('region', { name: 'Record' });
      const created = within(record).getByText('23 November 2025, 09:14');
      expect(created).toHaveAttribute('dateTime', '2025-11-23T14:14:00.000Z');
      expect(created.getAttribute('title')).toMatch(/^11\/23\/2025, 9:14:00\sAM EST$/);
      expect(within(record).getByText('Today, 09:05')).toBeDefined();
      expect(within(record).getByText('Yesterday, 16:30')).toBeDefined();
      cleanup();

      const thisYear = await openTask(
        { ...sqlite, createdAt: new Date('2026-05-23T13:14:00.000Z') },
        {},
        'details',
      );
      expect(within(thisYear.panel).getByText('23 May, 09:14')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes a short link fact at least 44 wide on a phone', async () => {
    const { panel } = await openTask(sqlite, {}, 'details');

    const parent = await within(panel).findByRole('link', { name: 'SQLite replaces Norn' });
    expect(parent).toHaveClass('min-w-11');
  });

  it('shows the status, size, priority, and tags under Status, and the parent and dates under Record', async () => {
    const { panel } = await openTask(
      {
        ...sqlite,
        priority: 'p1',
        size: 'medium',
        tags: [engineTag('web-push')],
      },
      {},
      'details',
    );

    const status = within(panel).getByRole('region', { name: 'Status' });
    expect(within(status).getByText('Ready')).toBeDefined();
    expect(within(status).getByText('Medium')).toBeDefined();
    expect(within(status).getByText('p1')).toBeDefined();
    expect(within(status).getByText('web-push')).toBeDefined();
    const record = within(panel).getByRole('region', { name: 'Record' });
    await expect(
      within(record).findByRole('link', { name: 'SQLite replaces Norn' }),
    ).resolves.toHaveAttribute('href', '/p/MMR/2');
    expect(within(record).getByText('Created')).toBeDefined();
    expect(within(record).getByText('Not yet')).toBeDefined();
  });
});

/** A timeline that holds only the record's creation, its notes' read `pending` or not. */
const createdOnly = (pending: boolean) => (
  <RecordTimeline
    items={buildFeed(FIXTURE_AT, [], [])}
    pending={pending}
    nodeId="MMR-417"
    offline={false}
  />
);

/** The Skeleton primitive's placeholder card. */
const SKELETON = '.bg-well-850.inset-ring';

describe('task page timeline (MMR-728)', () => {
  it('folds the timeline by day, newest first, with only the latest day open', async () => {
    const { panel } = await openTask(sqlite, { notes: THREE_NOTES }, 'timeline');

    await within(panel).findByText('Afternoon note');
    expect(foldsOf(panel)).toStrictEqual([
      ['Wednesday, 3 June 2', 'true'],
      ['Monday, 1 June 2', 'false'],
    ]);
    expect(
      precedes(within(panel).getByText('Afternoon note'), within(panel).getByText('Morning note')),
    ).toBe(true);
    expect(within(panel).queryByText('Older day note')).toBeNull();

    fireEvent.click(within(panel).getByRole('button', { name: 'Monday, 1 June 2' }));
    await within(panel).findByText('Older day note');
    // The day's creation follows its later note.
    expect(
      precedes(within(panel).getByText('Older day note'), within(panel).getByText('Created')),
    ).toBe(true);
  });

  it('puts the composer above the days, its Add note quiet until there is text', async () => {
    const { panel } = await openTask(sqlite, { notes: THREE_NOTES }, 'timeline');

    const box = within(panel).getByRole('textbox', { name: 'Add a note' });
    const add = within(panel).getByRole('button', { name: 'Add note' });
    expect(add).toBeDisabled();
    await within(panel).findByText('Afternoon note');
    expect(precedes(add, within(panel).getByRole('button', { name: 'Wednesday, 3 June 2' }))).toBe(
      true,
    );
    await userEvent.type(box, 'next steps');
    expect(add).toBeEnabled();
    // Never a second solid beside the header's main action.
    expect(add.className).not.toMatch(/\bbg-action\b/);
  });

  it('shows the creation and the transitions while the notes load', async () => {
    const started = {
      ...sqlite,
      history: [
        {
          at: new Date('2026-06-01T12:00:00.000Z'),
          from: 'todo',
          kind: 'lifecycle' as const,
          reason: null,
          to: 'in_progress',
        },
      ],
    };
    serve(started, { notes: [engineNote('Settled the dialect seam', '2026-06-01T13:00:00.000Z')] });
    const served = vi.mocked(getNode).getMockImplementation();
    const held = Promise.withResolvers<void>();
    vi.mocked(getNode).mockImplementation(async (options) => {
      if (options.data.facets?.[0] === 'annotations') {
        await held.promise;
      }
      return served!(options);
    });
    await renderRoute(consoleRoutes, '/p/MMR/417?tab=timeline', quietClient());

    const panel = await screen.findByRole('tabpanel');
    await within(panel).findByText('Started');
    expect(within(panel).getByText('Created')).toBeDefined();
    expect(within(panel).queryByText('Settled the dialect seam')).toBeNull();
    held.resolve();

    await within(panel).findByText('Settled the dialect seam');
  });

  it('stands a skeleton above the known entries only while the notes load', async () => {
    const { rerender } = await renderInRouter(createdOnly(true), quietClient());

    await screen.findByText('Created');
    expect(document.querySelector(SKELETON)).not.toBeNull();
    rerender(createdOnly(false));
    expect(document.querySelector(SKELETON)).toBeNull();
  });

  it('keys every note apart, even same-instant twins beside a note that reads like a repeat', async () => {
    const at = '2026-06-03T14:00:00.000Z';
    const consoleError = vi.spyOn(console, 'error');
    try {
      await openTask(
        sqlite,
        { notes: [engineNote('Twin', at), engineNote('Twin', at), engineNote('Twin-1', at)] },
        'timeline',
      );

      await screen.findByText('Twin-1');
      expect(screen.getAllByText('Twin')).toHaveLength(2);
      expect(
        consoleError.mock.calls.filter((args) => String(args[0]).includes('same key')),
      ).toHaveLength(0);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('shows every entry of a day, with no Show N more', async () => {
    const eight = Array.from({ length: 8 }, (_, index) =>
      engineNote(`Note ${String(index + 1)}`, `2026-06-03T1${String(index)}:00:00.000Z`),
    );
    const { panel } = await openTask(sqlite, { notes: eight }, 'timeline');

    await within(panel).findByText('Note 8');
    for (const note of eight) {
      expect(within(panel).getByText(note.content)).toBeDefined();
    }
    expect(within(panel).queryByRole('button', { name: /^Show \d+ more$/ })).toBeNull();
  });

  it('sets a note at the body size, 14 / 23', async () => {
    const { panel } = await openTask(sqlite, { notes: THREE_NOTES }, 'timeline');

    const note = (await within(panel).findByText('Afternoon note')).closest('article');
    expect(note).toHaveClass('text-body', 'leading-[23px]');
  });
});

/** Open the edit form for `node` and return its Tags field. */
/** Open a task page whose only timeline note carries `content`. */
async function openWithNote(content: string) {
  await openTask(
    engineTask({ id: 'MMR-83', status: 'in_progress' }),
    { notes: [engineNote(content)] },
    'timeline',
  );
}

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

  it('offline disables Edit and the verbs', async () => {
    const node = engineTask({ grooming: 'groomed', id: 'MMR-51', status: 'ready' });
    serve(node);
    // An errored read over loaded data is the console's offline signal.
    failNotes();
    await renderRoute(consoleRoutes, '/p/MMR/51', quietClient());

    await waitFor(async () => {
      expect(within(await header()).getByRole('button', { name: 'Start' })).toBeDisabled();
    });
    const sheet = await openMore();
    for (const name of ['Edit', 'Park for later…', 'Abandon…']) {
      expect(within(sheet).getByRole('button', { name })).toBeDisabled();
    }
  });
});

describe('task page content (MMR-453)', () => {
  it('renders a dependency in both depends_on and awaiting_on as one row, with the awaiting reading', async () => {
    const { panel: rail } = await openTask(
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

    it('clamps a long note at 12 lines, offers "Show all" with its rendered line count, and toggles the clamp', async () => {
      stubHeights(300, 60);
      await openWithNote('- one\n- two\n- three');

      // 300px of content at a 20px line-height: fifteen rendered lines.
      const toggle = await screen.findByRole('button', { name: 'Show all 15 lines' });
      const article = screen.getByText('three').closest('article');
      expect(article).toHaveAttribute('data-clamped', '12');
      await userEvent.click(toggle);
      expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
      expect(article).not.toHaveAttribute('data-clamped');
      await userEvent.click(screen.getByRole('button', { name: 'Show less' }));
      expect(screen.getByRole('button', { name: 'Show all 15 lines' })).toBeInTheDocument();
      expect(article).toHaveAttribute('data-clamped', '12');
    });

    it('names no line count when the note folds with no more than 12 lines of text', async () => {
      // A rule or an image can fold a note of few lines; "Show all 10 lines"
      // would then claim fewer lines than the clamp already shows.
      stubHeights(200, 60);
      await openWithNote('- one\n- two\n- three');

      await expect(screen.findByRole('button', { name: 'Show all' })).resolves.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Show all \d/ })).toBeNull();
    });

    it('offers no toggle when the note fits its clamp', async () => {
      stubHeights(60, 60);
      await openWithNote('- one\n- two\n- three');

      await screen.findByText('three');
      expect(screen.queryByRole('button', { name: /show (all|less)/i })).toBeNull();
    });

    it('lines Show all up with the note text, not 4 left of it', async () => {
      stubHeights(200, 60);
      await openWithNote('- one\n- two\n- three');

      const toggle = await screen.findByRole('button', { name: /Show all/ });
      expect(toggle).toHaveClass('ml-0');
      expect(toggle).not.toHaveClass('-ml-1');
    });

    it('opens a folded note when focus reaches a link below its clamp, and not for one above it', async () => {
      stubHeights(200, 60);
      await openWithNote('[top](https://a.test/top)\n\nmiddle\n\n[bottom](https://a.test/bottom)');

      await screen.findByRole('button', { name: /Show all/ });
      const top = screen.getByRole('link', { name: 'top' });
      const bottom = screen.getByRole('link', { name: 'bottom' });
      // jsdom lays nothing out: the top link sits on the first line, the bottom one 150 down.
      vi.spyOn(bottom, 'getBoundingClientRect').mockReturnValue(
        DOMRect.fromRect({ height: 20, y: 130 }),
      );
      const article = top.closest('article');

      act(() => {
        top.focus();
      });
      expect(article).toHaveAttribute('data-clamped', '12');
      act(() => {
        bottom.focus();
      });
      expect(article).not.toHaveAttribute('data-clamped');
      expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
    });

    it('keeps a note’s Show all state with that note when an older entry arrives', async () => {
      stubHeights(200, 60);
      const notes = [
        engineNote('Morning note', '2026-06-03T14:00:00.000Z'),
        engineNote('Afternoon note', '2026-06-03T18:00:00.000Z'),
      ];
      const timeline = (history: EngineNode['history']) => (
        <RecordTimeline
          items={buildFeed(FIXTURE_AT, history, notes)}
          pending={false}
          nodeId="MMR-417"
          offline={false}
        />
      );
      const { rerender } = await renderInRouter(timeline([]), quietClient());
      await userEvent.click(
        within(rowOf('Afternoon note')).getByRole('button', { name: /Show all/ }),
      );

      rerender(
        timeline([
          {
            at: new Date('2026-06-03T12:00:00.000Z'),
            from: 'todo',
            kind: 'lifecycle',
            reason: null,
            to: 'in_progress',
          },
        ]),
      );

      await screen.findByText('Started');
      expect(
        within(rowOf('Afternoon note')).getByRole('button', { name: 'Show less' }),
      ).toBeDefined();
      expect(within(rowOf('Morning note')).getByRole('button', { name: /Show all/ })).toBeDefined();
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
    await renderRoute(consoleRoutes, '/p/MMR/417?tab=timeline', createQueryClient());
    await screen.findByRole('heading', { level: 1, name: 'Add the SQLite dialect' });

    serve(sqlite, { notes: [engineNote('Annotated from the CLI', '2026-06-02T10:00:00.000Z')] });
    expect(screen.queryByText('Annotated from the CLI')).toBeNull();
    await vi.advanceTimersByTimeAsync(POLL_MS);

    await expect(screen.findByText('Annotated from the CLI')).resolves.toBeDefined();
  });
});

const groomed = () => engineTask({ grooming: 'groomed', id: 'MMR-51', status: 'ready' });

describe('task page grooming state (MMR-466)', () => {
  it('shows the state in the header and as a Grooming row in Details', async () => {
    const { panel } = await openTask(groomed(), {}, 'details');

    expect(within(await header()).getByText('groomed')).toBeDefined();
    const status = within(panel).getByRole('region', { name: 'Status' });
    expect(within(status).getByText('Grooming').nextElementSibling).toHaveTextContent(/^Groomed$/);
  });

  it('sets the grooming in Details as a plain fact value, not the header’s chip', async () => {
    const { panel } = await openTask(
      engineTask({ grooming: 'needs_answers', id: 'MMR-52', status: 'ready' }),
      {},
      'details',
    );

    const status = within(panel).getByRole('region', { name: 'Status' });
    const value = within(status).getByText('Grooming').nextElementSibling as HTMLElement;
    expect(value).toHaveTextContent(/^Needs answers$/);
    expect(value.children).toHaveLength(0);
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

    expect(within(await header()).getByText('groomed')).toBeDefined();
  });

  it('shows no state once the task has started', async () => {
    const { panel } = await openTask(
      engineTask({
        grooming: 'groomed',
        id: 'MMR-51',
        lifecycle: 'in_progress',
        status: 'in_progress',
      }),
      {},
      'details',
    );

    expect(screen.queryByText('groomed')).toBeNull();
    expect(within(panel).queryByText('Grooming')).toBeNull();
  });

  it('shows no state on a container', async () => {
    serve({
      ...engineContainer({ id: 'MMR-2', status: 'ready', type: 'phase' }),
      grooming: 'groomed',
    });
    await renderRoute(consoleRoutes, '/p/MMR/2', quietClient());

    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText('groomed')).toBeNull();
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

import { QueryClient } from '@tanstack/react-query';
import { fireEvent, screen, within, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { confirm } from '../api/fns/deliveries';
import type { NeedsYouMember } from '../api/view-queries';
import { consoleRoutes } from '../router';
import { serveBrowse } from './browse-fns';
import { engineProject } from './engine-fixtures';
import { serveNodes } from './node-fns';
import { renderShell, renderRoute } from './router';
import { serveShell } from './shell-fns';
import { stubViewport } from './viewport';
import { engineReview, engineWork, needsYouRow, stripRow } from './views-fixtures';
import { serveViews } from './views-fns';

vi.mock('../api/fns/deliveries');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/views');
vi.mock('../components/patterns/notice', () => ({
  NoticeHost: () => null,
  toast: { error: vi.fn(), success: vi.fn() },
}));
const stamp = new Date('2026-11-16T12:00:00Z');
function rows(): NeedsYouMember[] {
  return [
    {
      delivery: {
        hold_reason: 'Need access',
        id: 'MMR-d1',
        lifecycle: 'running',
        phase: 'MMR-2',
        project: 'MMR',
        seq: 1,
        title: 'Stopped run',
        updated_at: stamp,
      },
      kind: 'delivery',
    },
    {
      decision: {
        class: 'product',
        created_at: stamp,
        delivery: 'MMR-d1',
        id: 'MMR-q1',
        lifecycle: 'provisional',
        option_details: [null, null],
        options: ['Keep', 'Remove'],
        outcome_note: null,
        overturn_option: null,
        project_key: 'MMR',
        question: 'Keep the rail?',
        recommended: 1,
        seq: 1,
        taken: 1,
        tasks: [],
        updated_at: stamp,
        why: null,
      },
      kind: 'decision',
      workBuiltOnIt: true,
    },
  ];
}
beforeEach(() => {
  serveBrowse();
  stubViewport('desktop');
  serveNodes({ nodes: [engineProject({ id: 'MMR', title: 'Mimir' })] });
  const members = rows();
  serveShell({ projects: [engineProject({ id: 'MMR', title: 'Mimir' })] });
  serveViews({
    projects: { MMR: engineWork({ needsYou: members }) },
    review: engineReview({
      needsYou: [{ project: { key: 'MMR', name: 'Mimir' }, rows: members }],
      projects: [stripRow({ key: 'MMR', name: 'Mimir' }, { needsYou: 2 })],
      queue: [
        { id: 'MMR-d1', kind: 'delivery' },
        { id: 'MMR-q1', kind: 'decision' },
      ],
    }),
  });
});
afterEach(() => vi.unstubAllGlobals());
const open = (path: string) =>
  renderRoute(
    consoleRoutes,
    path,
    new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5000 } } }),
  );

test('Home’s deck and the alert show the mixed set in core order and count it', async () => {
  await renderShell('/');
  const deck = await screen.findByRole('region', { name: 'Needs you 2 cards, 2 items' });
  expect(within(deck).getByText('Stopped')).toBeInTheDocument();
  expect(within(deck).getByText('Decisions')).toBeInTheDocument();
  const content = deck.textContent;
  expect(content.indexOf('Stopped run')).toBeLessThan(content.indexOf('Decisions'));
  expect(screen.getAllByLabelText('2 need you').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: '2 need you' }));
  const panel = await screen.findByRole('dialog', { name: 'Needs you' });
  const text = panel.textContent;
  expect(text.indexOf('Stopped run')).toBeLessThan(text.indexOf('Keep the rail?'));
  expect(
    within(panel)
      .getAllByRole('link')
      .filter((a) => a.getAttribute('href') === '/p/MMR/d1'),
  ).toHaveLength(2);
});

test('focus walks delivery and decision cards with Skip only and the right up-next question', async () => {
  await open('/?mode=focus');
  await screen.findByText('Stopped run');
  expect(screen.getByText('Stopped')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Skip' })).toHaveFocus();
  expect(
    within(screen.getByRole('main'))
      .getAllByRole('button')
      .map((b) => b.textContent),
  ).toEqual(['Skip']);
  expect(
    within(screen.getByRole('region', { name: 'Up next' })).getByText('Keep the rail?'),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
  await screen.findByRole('heading', { name: 'Keep the rail?' });
  expect(screen.getByText(/MMR-q1 · product/)).toBeInTheDocument();
  expect(
    within(screen.getByRole('main'))
      .getAllByRole('button')
      .map((b) => b.textContent),
  ).toEqual(['Confirm 1', 'Take 2', 'Note…', 'Skip']);
  expect(screen.getByRole('link', { name: 'MMR-d1' })).toHaveAttribute('href', '/p/MMR/d1');
});

test('a work page preserves the ordered mixed list', async () => {
  await open('/p/MMR');
  await screen.findByRole('heading', { name: 'Keep the rail?' });
  const main = screen.getByRole('main');
  expect(main.textContent.indexOf('Stopped run')).toBeLessThan(
    main.textContent.indexOf('Keep the rail?'),
  );
  expect(within(main).getByText('Stopped')).toBeInTheDocument();
});

test('focus lands on a decision card itself after Skip on a task card', async () => {
  const [, decision] = rows();
  const task = needsYouRow(
    { id: 'MMR-480', status: 'ready', title: 'Pick the skip behavior' },
    'needs_answers',
    { question: 'Skip, or drop it?' },
  );
  const members = [task, decision!];
  serveViews({
    review: engineReview({
      needsYou: [{ project: { key: 'MMR', name: 'Mimir' }, rows: members }],
      projects: [stripRow({ key: 'MMR', name: 'Mimir' }, { needsYou: 2 })],
      queue: [
        { id: 'MMR-480', kind: 'task' },
        { id: 'MMR-q1', kind: 'decision' },
      ],
    }),
  });
  await open('/?mode=focus');
  const card = await screen.findByRole('region', { name: 'Pick the skip behavior' });
  const skip = within(card).getByRole('button', { name: 'Skip' });
  skip.focus();
  fireEvent.click(skip);
  await screen.findByRole('heading', { name: 'Keep the rail?' });
  expect(screen.getByRole('heading', { name: 'Keep the rail?' }).closest('section')).toHaveFocus();
});

test.each(['work page', 'popover'])(
  'answer hands focus to the next decision row, never a chip or link (%s)',
  async (surface) => {
    const first = rows()[1]!;
    if (first.kind !== 'decision') {
      throw new Error('fixture');
    }
    const second: NeedsYouMember = {
      ...first,
      decision: { ...first.decision, id: 'MMR-q2', question: 'Second question?', seq: 2 },
    };
    const members = [first, second];
    const world = serveViews({
      review: engineReview({
        needsYou: [{ project: { key: 'MMR', name: 'Mimir' }, rows: members }],
        projects: [stripRow({ key: 'MMR', name: 'Mimir' }, { needsYou: 2 })],
        queue: [
          { id: 'MMR-q1', kind: 'decision' },
          { id: 'MMR-q2', kind: 'decision' },
        ],
      }),
    });
    world.projects = { MMR: engineWork({ needsYou: members }) };
    vi.mocked(confirm).mockImplementation(async () => {
      world.projects = { MMR: engineWork({ needsYou: [second] }) };
      world.review = engineReview({
        needsYou: [{ project: { key: 'MMR', name: 'Mimir' }, rows: [second] }],
        projects: [stripRow({ key: 'MMR', name: 'Mimir' }, { needsYou: 1 })],
        queue: [{ id: 'MMR-q2', kind: 'decision' }],
      });
      return { ...first.decision, history: [] };
    });
    if (surface === 'popover') {
      await renderShell('/p/MMR');
    } else {
      await open('/p/MMR');
    }
    let scope: HTMLElement;
    if (surface === 'popover') {
      fireEvent.click(await screen.findByRole('button', { name: '2 need you' }));
      scope = await screen.findByRole('dialog', { name: 'Needs you' });
    } else {
      await screen.findByRole('heading', { name: 'Keep the rail?' });
      scope = screen.getByRole('main');
    }
    const chip = await within(scope).findByRole('button', {
      name: 'Confirm option 1 for MMR-q1: Keep',
    });
    chip.focus();
    fireEvent.click(chip);
    await waitFor(() => expect(chip).not.toBeInTheDocument());
    const next = within(scope)
      .getByRole('heading', { name: 'Second question?' })
      .closest('[data-row-id]');
    await waitFor(() => expect(next).toHaveFocus());
    expect(document.activeElement?.tagName).toBe('DIV');
    expect(next?.querySelector('[data-row-actions]')).toBeNull();
    for (const action of next!.querySelectorAll('button, a')) {
      expect(action).not.toHaveFocus();
    }
    fireEvent.keyDown(next!, { key: 'Enter' });
    expect(confirm).toHaveBeenCalledExactlyOnceWith({ data: { id: 'MMR-q1' } });
  },
);

test.each(['/p/MMR', '/?mode=focus'])('decision answer chips are wired on %s', async (path) => {
  const first = rows()[1]!;
  if (first.kind !== 'decision') {
    throw new Error('fixture');
  }
  const members = [first];
  serveViews({
    projects: { MMR: engineWork({ needsYou: members }) },
    review: engineReview({
      needsYou: [{ project: { key: 'MMR', name: 'Mimir' }, rows: members }],
      projects: [stripRow({ key: 'MMR', name: 'Mimir' }, { needsYou: 1 })],
      queue: [{ id: first.decision.id, kind: 'decision' }],
    }),
  });
  vi.mocked(confirm).mockResolvedValue({ ...first.decision, history: [] });
  await open(path);
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm option 1 for MMR-q1: Keep' }));
  await waitFor(() => expect(confirm).toHaveBeenCalledExactlyOnceWith({ data: { id: 'MMR-q1' } }));
});

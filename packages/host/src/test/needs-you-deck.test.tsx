import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deliveryUnblock } from '../api/fns/deliveries';
import { groom } from '../api/fns/nodes';
import type { ReviewReport } from '../api/view-queries';
import { NeedsYouDeck } from '../components/needs-you-deck';
import { readMark, useBackToOpener, useOpenerFocus, useOpenerMark } from '../lib/walkthrough-mark';
import { blocked, decision, question, report, stopped } from './needs-you-fixtures';
import { stubViewport } from './viewport';
import type { Viewport } from './viewport';

/*
 * The Needs you deck over the review report, with the console's writes
 * (ADR 0019, MMR-721 refinement: The cards, The deck's state, A
 * walkthrough's return, Offline): each card's action, the deck's write
 * states, focus after the answer dialog, and the walkthrough's return to a
 * bundle the page has to turn to. The mapping is swept in
 * needs-you-deck-model.test.ts; the deck pattern's own rules in
 * feed-deck.test.tsx.
 */

vi.mock('../api/fns/deliveries');
vi.mock('../api/fns/nodes');
const { toast } = vi.hoisted(() => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../components/patterns/notice', () => ({ NoticeHost: () => null, toast }));

beforeEach(() => {
  vi.mocked(deliveryUnblock).mockReturnValue(Promise.withResolvers<never>().promise);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/** The report the deck page shows, kept across a navigation away and back, as the query cache keeps it. */
const served = { listeners: new Set<() => void>(), report: report([]) };

/** A refetch: the deck page renders the next report. */
function refetch(next: ReviewReport) {
  served.report = next;
  for (const listener of served.listeners) {
    listener();
  }
}

function subscribe(listener: () => void) {
  served.listeners.add(listener);
  return () => {
    served.listeners.delete(listener);
  };
}

function DeckPage({ offline }: { offline: boolean }) {
  const current = useSyncExternalStore(subscribe, () => served.report);
  return (
    <main>
      <NeedsYouDeck report={current} offline={offline} />
    </main>
  );
}

/** The walkthrough's page, reduced to its marked Close. */
function Walkthrough() {
  const mark = useOpenerMark();
  const back = useBackToOpener();
  return (
    <button
      type="button"
      onClick={() => {
        if (mark !== undefined) {
          back(mark);
        }
      }}
    >
      Close the walkthrough
    </button>
  );
}

/** The deck on `/` and the walkthroughs' addresses, under a root that carries out the shell's focus request. */
async function mount(initial: ReviewReport, viewport: Viewport, { offline = false } = {}) {
  stubViewport(viewport);
  served.report = initial;
  const root = createRootRoute({
    component: () => {
      useOpenerFocus();
      return <Outlet />;
    },
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/'] }),
    routeTree: root.addChildren([
      createRoute({
        component: () => <DeckPage offline={offline} />,
        getParentRoute: () => root,
        path: '/',
      }),
      createRoute({ component: Walkthrough, getParentRoute: () => root, path: '/p/$key/d{$seq}' }),
      createRoute({ component: Walkthrough, getParentRoute: () => root, path: '/p/$key' }),
    ]),
  });
  await router.load();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { name: /Needs you/u });
  return router;
}

const button = (name: string) => screen.getByRole('button', { name });
const target = (title: string) => screen.getByRole('button', { name: title });

/** Ten cards: a stop and its bundle first, a project's bundle sixth, then questions and blocks. */
const TEN = report([
  stopped('FLT-d2', { reason: 'Stopped by its time cap.' }),
  decision('FLT-q1', { delivery: 'FLT-d2' }),
  question('FLT-8'),
  blocked('MMR-7'),
  question('FLT-9'),
  decision('MMR-q5', {}),
  decision('MMR-q6', {}),
  question('MMR-10'),
  question('MMR-11'),
  blocked('MMR-12'),
  question('MMR-13'),
]);

describe('the cards', () => {
  it('name each card’s project after its ID', async () => {
    await mount(TEN, 'desktop');
    expect(target('Delivery FLT-d2')).toHaveAccessibleDescription(
      expect.stringContaining('Stopped FLT-d2 Fleet'),
    );
    expect(target('Task MMR-7')).toHaveAccessibleDescription(
      expect.stringContaining('MMR-7 Mimir'),
    );
  });
});

describe('Review N decisions', () => {
  it('opens the delivery’s walkthrough marked with this page and its set, and stays live offline', async () => {
    const router = await mount(TEN, 'desktop', { offline: true });
    const review = button('Review 1 decision on FLT-d2');
    expect(review).not.toHaveAttribute('aria-disabled');
    await userEvent.click(review);
    const { location } = router.state;
    expect(location.pathname).toBe('/p/FLT/d2');
    expect(location.search).toEqual({ mode: 'decisions' });
    expect(readMark(location.state)).toEqual({ entry: 'delivery:FLT-d2', opener: '/' });
  });

  it('opens a project’s walkthrough for its decisions without a delivery', async () => {
    const router = await mount(TEN, 'desktop');
    await userEvent.click(button('Next page'));
    await userEvent.click(button('Review 2 decisions without a delivery in MMR'));
    expect(router.state.location.pathname).toBe('/p/MMR');
    expect(readMark(router.state.location.state)).toEqual({ entry: 'project:MMR', opener: '/' });
  });
});

describe('a walkthrough’s return', () => {
  it('turns the deck to a bundle on another page and focuses its button', async () => {
    await mount(TEN, 'desktop');
    await userEvent.click(button('Next page'));
    await userEvent.click(button('Review 2 decisions without a delivery in MMR'));
    await userEvent.click(await screen.findByRole('button', { name: 'Close the walkthrough' }));
    const review = await screen.findByRole('button', {
      name: 'Review 2 decisions without a delivery in MMR',
    });
    await waitFor(() => expect(review).toHaveFocus());
    expect(screen.getByRole('heading', { level: 2 }).parentElement).toHaveTextContent('5–8 of 10');
  });

  it('focuses the page’s main region when the bundle is gone', async () => {
    await mount(TEN, 'desktop');
    await userEvent.click(button('Review 1 decision on FLT-d2'));
    served.report = report([stopped('FLT-d2'), question('FLT-8')]);
    await userEvent.click(await screen.findByRole('button', { name: 'Close the walkthrough' }));
    await waitFor(() => expect(screen.getByRole('main')).toHaveFocus());
  });
});

describe('Clear stop', () => {
  it('holds its button while in flight, and lands focus on the next card when the refetch drops the stop', async () => {
    const write = Promise.withResolvers<Awaited<ReturnType<typeof deliveryUnblock>>>();
    vi.mocked(deliveryUnblock).mockReturnValue(write.promise);
    await mount(TEN, 'phone');
    const clear = button('Clear stop on FLT-d2');
    await userEvent.click(clear);
    expect(deliveryUnblock).toHaveBeenCalledExactlyOnceWith({
      data: { attempt: expect.any(String), id: 'FLT-d2' },
    });
    expect(clear).toHaveAttribute('aria-disabled', 'true');
    expect(clear).toHaveFocus();
    await userEvent.click(clear);
    expect(deliveryUnblock).toHaveBeenCalledOnce();

    await act(async () => {
      write.resolve({ record: {} as never, wake: { state: 'skipped' } as never });
      await write.promise;
    });
    act(() => {
      refetch(report(TEN.needsYou.flatMap((group) => group.rows).slice(1)));
    });
    await waitFor(() => expect(target('Decisions on FLT-d2')).toHaveFocus());
  });

  it('keeps the card and its focus when refused, and frees the button', async () => {
    const write = Promise.withResolvers<never>();
    vi.mocked(deliveryUnblock).mockReturnValue(write.promise);
    await mount(TEN, 'phone');
    const clear = button('Clear stop on FLT-d2');
    await userEvent.click(clear);
    await act(async () => {
      write.reject(new Error('The delivery is not stopped.'));
      await write.promise.catch(() => undefined);
    });
    await waitFor(() => expect(clear).not.toHaveAttribute('aria-disabled'));
    expect(clear).toHaveFocus();
    expect(toast.error).toHaveBeenCalledWith('The delivery is not stopped.');
  });

  it('does nothing offline, and neither does Answer…', async () => {
    await mount(report([stopped('FLT-d2'), question('FLT-8')]), 'desktop', { offline: true });
    const clear = button('Clear stop on FLT-d2');
    const answer = button('Answer FLT-8');
    for (const control of [clear, answer]) {
      expect(control).toHaveAttribute('aria-disabled', 'true');
      await userEvent.click(control);
    }
    expect(deliveryUnblock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Answer…', () => {
  it('returns focus to the card’s Answer… once the dialog closes', async () => {
    await mount(report([blocked('MMR-7'), question('FLT-8')]), 'desktop');
    await userEvent.click(button('Answer FLT-8'));
    const dialog = await screen.findByRole('dialog', { name: 'Answer' });
    expect(within(dialog).getByText('Where does the pin live?')).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(button('Answer FLT-8')).toHaveFocus());
  });

  it('returns focus to the card’s own Answer… when the preview’s footer opened the dialog', async () => {
    await mount(report([blocked('MMR-7'), question('FLT-8')]), 'desktop');
    await userEvent.click(target('Task FLT-8'));
    const panel = await screen.findByRole('dialog', { name: 'Task FLT-8' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Answer FLT-8' }));
    const dialog = await screen.findByRole('dialog', { name: 'Answer' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const own = screen.getAllByRole('button', { name: 'Answer FLT-8' });
    expect(own).toHaveLength(1);
    await waitFor(() => expect(own[0]).toHaveFocus());
  });

  it('moves focus to the next card’s target when the answer takes the card out of the set', async () => {
    const after = report([question('MMR-10'), blocked('MMR-7')]);
    vi.mocked(groom).mockImplementation(async () => {
      refetch(after);
      return [] as never;
    });
    await mount(report([question('FLT-8'), question('MMR-10'), blocked('MMR-7')]), 'desktop');
    await userEvent.click(button('Answer FLT-8'));
    const dialog = await screen.findByRole('dialog', { name: 'Answer' });
    await userEvent.type(within(dialog).getByRole('textbox'), 'In the manifest.');
    await userEvent.click(within(dialog).getAllByRole('radio')[0]!);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Answer' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(target('Task MMR-10')).toHaveFocus());
  });
});

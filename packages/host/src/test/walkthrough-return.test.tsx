import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import { RETURN_TARGET_ATTRIBUTE } from '../lib/return-target';
import {
  markState,
  useBackToOpener,
  useOpenerFocus,
  useOpenerMark,
  useReturnTargetResolver,
} from '../lib/walkthrough-mark';
import type { ReturnTargetResolver } from '../lib/walkthrough-mark';

/*
 * A walkthrough's return through a registered resolver (ADR 0019, MMR-721
 * refinement: A walkthrough's return): a surface that answers later, as the
 * Needs you deck does once its turn can render, and finds nothing, hands the
 * return on to the control on the page.
 */

const ENTRY = 'delivery:MMR-d3';

function Opener({ resolve }: { resolve: ReturnTargetResolver }) {
  useReturnTargetResolver(resolve);
  return (
    <main>
      <button type="button" {...{ [RETURN_TARGET_ATTRIBUTE]: ENTRY }}>
        Review 1 decision
      </button>
    </main>
  );
}

/** A control that goes back to the opener, each with its own `useBackToOpener`, as Close and the link back have. */
function BackButton({ children }: { children: string }) {
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
      {children}
    </button>
  );
}

function Walkthrough() {
  return (
    <>
      <BackButton>Close the walkthrough</BackButton>
      <BackButton>Back to the page</BackButton>
    </>
  );
}

async function mount(resolve: ReturnTargetResolver) {
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
        component: () => <Opener resolve={resolve} />,
        getParentRoute: () => root,
        path: '/',
      }),
      createRoute({ component: Walkthrough, getParentRoute: () => root, path: '/walkthrough' }),
      createRoute({
        component: () => <main>Other</main>,
        getParentRoute: () => root,
        path: '/other',
      }),
    ]),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await screen.findByRole('button', { name: 'Review 1 decision' });
  return router;
}

test('focuses the control on the page when a resolver answers later that it placed nothing', async () => {
  const router = await mount(() => Promise.resolve(false));
  router.history.push('/walkthrough', markState({ entry: ENTRY, opener: '/' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Close the walkthrough' }));
  const entry = await screen.findByRole('button', { name: 'Review 1 decision' });
  await waitFor(() => expect(entry).toHaveFocus());
});

test('a second Close while the first back is in flight goes back only one entry', async () => {
  const router = await mount(() => false);
  router.history.push('/other');
  router.history.push('/walkthrough', markState({ entry: ENTRY, opener: '/other' }));
  const close = await screen.findByRole('button', { name: 'Close the walkthrough' });
  const back = vi.spyOn(router.history, 'back');
  // A fast double click lands both clicks before the first navigation settles.
  act(() => {
    close.click();
    close.click();
  });
  expect(back).toHaveBeenCalledTimes(1);
});

test('Close, then the link back while the first back is in flight, goes back only one entry', async () => {
  const router = await mount(() => false);
  router.history.push('/other');
  router.history.push('/walkthrough', markState({ entry: ENTRY, opener: '/other' }));
  const close = await screen.findByRole('button', { name: 'Close the walkthrough' });
  const linkBack = screen.getByRole('button', { name: 'Back to the page' });
  const back = vi.spyOn(router.history, 'back');
  act(() => {
    close.click();
    linkBack.click();
  });
  expect(back).toHaveBeenCalledTimes(1);
});

test('Close goes back again after Forward cut a back short', async () => {
  const router = await mount(() => false);
  router.history.push('/walkthrough', markState({ entry: ENTRY, opener: '/' }));
  const close = await screen.findByRole('button', { name: 'Close the walkthrough' });
  close.click();
  router.history.forward();
  await router.load();
  await waitFor(() => expect(router.state.resolvedLocation?.pathname).toBe('/walkthrough'));
  const back = vi.spyOn(router.history, 'back');
  (await screen.findByRole('button', { name: 'Close the walkthrough' })).click();
  expect(back).toHaveBeenCalledTimes(1);
});

test('a focus request a cut-short back left does not move focus on a later visit to the opener', async () => {
  const router = await mount(() => false);
  router.history.push('/walkthrough', markState({ entry: ENTRY, opener: '/' }));
  const close = await screen.findByRole('button', { name: 'Close the walkthrough' });
  // Back, then Forward before the opener resolves: the walkthrough shows again at the same href.
  close.click();
  router.history.forward();
  await router.load();
  await screen.findByRole('button', { name: 'Close the walkthrough' });
  router.history.push('/');
  const entry = await screen.findByRole('button', { name: 'Review 1 decision' });
  await waitFor(() => expect(router.state.resolvedLocation?.pathname).toBe('/'));
  await act(() => Promise.resolve());
  expect(entry).not.toHaveFocus();
});

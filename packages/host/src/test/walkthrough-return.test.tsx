import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';

import {
  RETURN_TARGET_ATTRIBUTE,
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
    ]),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  await screen.findByRole('button', { name: 'Review 1 decision' });
  return router;
}

it('focuses the control on the page when a resolver answers later that it placed nothing', async () => {
  const router = await mount(() => Promise.resolve(false));
  await router.navigate({ state: markState({ entry: ENTRY, opener: '/' }), to: '/walkthrough' });
  await userEvent.click(await screen.findByRole('button', { name: 'Close the walkthrough' }));
  const entry = await screen.findByRole('button', { name: 'Review 1 decision' });
  await waitFor(() => expect(entry).toHaveFocus());
});

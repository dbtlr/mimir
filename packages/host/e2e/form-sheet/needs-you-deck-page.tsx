import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';

import { NeedsYouDeckDemo } from '../../src/kit/needs-you-deck';
import { useBackToOpener, useOpenerFocus, useOpenerMark } from '../../src/lib/walkthrough-mark';

/** The records the deck starts with: `?only=FLT-d2,MMR-731`, every fixture record by default. */
const only = new URLSearchParams(globalThis.location.search).get('only')?.split(',');

/** The walkthrough's page, reduced to its marked Close, at the addresses Review N decisions opens. */
function Walkthrough() {
  const mark = useOpenerMark();
  const back = useBackToOpener();
  return (
    <main className="p-4">
      <h1 className="text-page">Decisions walkthrough</h1>
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
    </main>
  );
}

const root = createRootRoute({
  component: () => {
    // The shell's focus request after a walkthrough's Close.
    useOpenerFocus();
    return <Outlet />;
  },
});

const router = createRouter({
  history: createMemoryHistory(),
  routeTree: root.addChildren([
    createRoute({
      component: () => (
        <main className="mx-auto max-w-[900px] px-3.5 py-4 md:px-5">
          <NeedsYouDeckDemo only={only} />
          <button type="button" className="mt-8">
            After the deck
          </button>
        </main>
      ),
      getParentRoute: () => root,
      path: '/',
    }),
    createRoute({ component: Walkthrough, getParentRoute: () => root, path: '/p/$key/d{$seq}' }),
    createRoute({ component: Walkthrough, getParentRoute: () => root, path: '/p/$key' }),
  ]),
});

/**
 * The Needs you deck's /kit demo over its fixture review report, under a
 * memory router with the walkthrough's addresses and the shell's focus
 * request, so a walkthrough's return crosses pages (e2e/needs-you-deck.test.ts).
 */
export function NeedsYouDeckPage() {
  return <RouterProvider router={router} />;
}

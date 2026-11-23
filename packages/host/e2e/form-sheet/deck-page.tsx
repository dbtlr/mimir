import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';

import { DeckDemo } from '../../src/kit/deck';

/** How many cards the deck starts with: `?cards=N`, ten by default. */
const initial = Number(new URLSearchParams(globalThis.location.search).get('cards') ?? '10');

function DeckRoot() {
  return (
    <main className="mx-auto max-w-[900px] px-3.5 py-4 md:px-5">
      <DeckDemo initial={initial} />
      <button type="button" className="mt-8">
        After the deck
      </button>
    </main>
  );
}

const router = createRouter({
  history: createMemoryHistory(),
  routeTree: createRootRoute({ component: DeckRoot }),
});

/**
 * The Needs you deck's /kit demo under a bare memory router, since a feed
 * card's preview reads the router, on the page's 14 gutter below 768 and 20
 * from it, with a control after it to Tab to (e2e/feed-deck.test.ts).
 */
export function DeckPage() {
  return <RouterProvider router={router} />;
}

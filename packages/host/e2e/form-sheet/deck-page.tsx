import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';

import { DeckDemo } from '../../src/kit/deck';

const params = new URLSearchParams(globalThis.location.search);
/** How many cards the deck starts with: `?cards=N`, ten by default. */
const initial = Number(params.get('cards') ?? '10');
/** `?gutter=wide` sets the page's gutter at 20 on a phone too, as a page without the phone gutter does. */
const wide = params.get('gutter') === 'wide';

function DeckRoot() {
  return (
    <main className={wide ? 'mx-auto max-w-[900px] px-5 py-4' : 'mx-auto max-w-[900px] px-3.5 py-4 md:px-5'}>
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

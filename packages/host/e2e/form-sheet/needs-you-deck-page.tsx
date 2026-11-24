import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import type { NeedsYouWrites } from '../../src/components/needs-you-cards';
import { NeedsYouDeckView } from '../../src/components/needs-you-deck-view';
import { NeedsYouDeckDemo } from '../../src/kit/needs-you-deck';
import { useBackToOpener, useOpenerFocus, useOpenerMark } from '../../src/lib/walkthrough-mark';
import { question, report } from '../../src/test/needs-you-fixtures';

/** The records the deck starts with: `?only=FLT-d2,MMR-731`, every fixture record by default. */
const only = new URLSearchParams(globalThis.location.search).get('only')?.split(',');

/** `&refetch`: the deck over the harness's own rows, which a check reorders as a refetch would. */
const refetch = new URLSearchParams(globalThis.location.search).has('refetch');

/** The refetch deck's rows, in their first queue order. */
const ROWS = [question('MMR-1'), question('MMR-2'), question('MMR-3')];
const rowId = (row: (typeof ROWS)[number]) => (row.kind === 'task' ? row.task.id : '');

/**
 * The event a check dispatches on `window`, its `detail` the row ids in a new
 * queue order, to replace the deck's report with them, as a refetch would.
 */
const REORDER_EVENT = 'needs-you-reorder';

const NO_WRITES: NeedsYouWrites = {
  AnswerDialog: () => null,
  clearStop: async () => undefined,
};

/** The real deck over rows a `needs-you-reorder` event replaces. */
function RefetchDeck() {
  const [rows, setRows] = useState(ROWS);
  useEffect(() => {
    const reorder = (event: Event) => {
      const ids: unknown = event instanceof CustomEvent ? event.detail : undefined;
      const order = Array.isArray(ids) ? ids : [];
      setRows(order.flatMap((id) => ROWS.filter((row) => rowId(row) === id)));
    };
    globalThis.addEventListener(REORDER_EVENT, reorder);
    return () => {
      globalThis.removeEventListener(REORDER_EVENT, reorder);
    };
  }, []);
  return <NeedsYouDeckView report={report(rows)} writes={NO_WRITES} seeAll={{ to: '/' }} />;
}

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
          {refetch ? <RefetchDeck /> : <NeedsYouDeckDemo only={only} />}
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

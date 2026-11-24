import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { FeedCard } from '../components/patterns/feed/card';
import { CardGrid } from '../components/patterns/feed/card-grid';
import { DayFolds, FinishedRow } from '../components/patterns/feed/day-fold';
import { FeedPreview } from '../components/patterns/feed/feed-preview';
import { RowGroup } from '../components/patterns/feed/row-group';
import { FeedSection } from '../components/patterns/feed/section-head';
import { ShippedSummary, chartName, shortCount } from '../components/patterns/feed/shipped-summary';
import { nodeLink } from '../lib/record-url';
import { renderInRouter } from './router';

/*
 * The feed blocks (ADR 0019, MMR-719 refinement): each block's behavior at its
 * public seam. Type, ink, and sizes are the readable-type guard's and a real
 * browser's to check; jsdom has no layout.
 */

/** Two "When you have a minute" rows, the first counting `seeds`. */
function spare(seeds: number) {
  return [
    { count: seeds, name: 'Seeds to triage', to: { to: '/' } as const },
    { count: 15, name: 'To groom', to: { params: { key: 'MMR' }, to: '/p/$key' } as const },
  ];
}

/**
 * A day row whose first controls cannot take focus (a disabled button that
 * keeps a tab index, a link out of the tab order), before its own link.
 */
function rowWithDisabledFirst(name: string) {
  return (
    <div key={name}>
      <button type="button" disabled tabIndex={0}>
        Undo
      </button>
      <a href="/skip" tabIndex={-1}>
        skip
      </a>
      <a href={`/${name}`}>{name}</a>
    </div>
  );
}

/** A day row with nothing to focus. */
function plainRow(name: string) {
  return <p key={name}>{name}</p>;
}

/** A day row that is a bare link. */
function linkedRow(name: string) {
  return (
    <a key={name} href={`/${name}`}>
      {name}
    </a>
  );
}

describe('feed section head', () => {
  it('names the section and its count in one heading, and its See all opens the filtered list', async () => {
    await renderInRouter(
      <FeedSection
        title="Now"
        count={1204}
        seeAll={{ params: { key: 'MMR' }, search: { status: 'live' }, to: '/p/$key/tasks' }}
      >
        <p>body</p>
      </FeedSection>,
    );
    const section = screen.getByRole('region', { name: 'Now 1,204' });
    expect(within(section).getByRole('heading', { level: 2, name: 'Now 1,204' })).toBeVisible();
    const seeAll = within(section).getByRole('link', { name: 'See all in Now' });
    expect(seeAll).toHaveTextContent('See all');
    expect(seeAll).toHaveAttribute('href', '/p/MMR/tasks?status=live');
    expect(within(section).getByText('body')).toBeVisible();
  });

  it('offers no See all, and no count, when the caller gives none', async () => {
    await renderInRouter(
      <FeedSection title="When you have a minute">
        <p>rows</p>
      </FeedSection>,
    );
    const section = screen.getByRole('region', { name: 'When you have a minute' });
    expect(within(section).queryByRole('link')).toBeNull();
  });

  it('reads a count the caller words, such as a capped section’s “6 of 9”', async () => {
    await renderInRouter(
      <FeedSection title="Now" count="6 of 9">
        <p>cards</p>
      </FeedSection>,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Now 6 of 9' })).toBeVisible();
  });
});

/** A card inside the feed that opens its preview, as every card sits. */
function inFeed(ui: ReactNode) {
  return renderInRouter(<FeedPreview preview={() => undefined}>{ui}</FeedPreview>);
}

describe('feed card', () => {
  it('is one target named by its title and described by its status line and chips', async () => {
    await inFeed(
      <FeedCard
        previewKey="MMR-709"
        lead={<span>In progress</span>}
        id="MMR-709"
        age="50m"
        title="Send an encrypted Web Push"
        detail="Latest note: agreement confirmed."
        chips={<span>Size large</span>}
      />,
    );
    const targets = screen.getAllByRole('button');
    expect(targets).toHaveLength(1);
    const [target] = targets;
    expect(target).toHaveAccessibleName('Send an encrypted Web Push');
    expect(target).toHaveAccessibleDescription('In progress MMR-709 50m Size large');
  });

  it('is described by its status line alone when it has no chips', async () => {
    await inFeed(
      <FeedCard
        previewKey="MMR-715"
        lead={<span>Under review</span>}
        id="MMR-715"
        age="15m"
        title="Mobile top bar"
        chips={false}
      />,
    );
    expect(screen.getByRole('button', { name: 'Mobile top bar' })).toHaveAccessibleDescription(
      'Under review MMR-715 15m',
    );
  });
});

describe('card grid', () => {
  // jsdom has no layout, so the container rule is read from the grid's classes;
  // a real browser checks the columns at each width.
  it('turns two columns on the room the feed has, a container query, not the viewport’s md', async () => {
    await renderInRouter(
      <FeedPreview preview={() => undefined}>
        <CardGrid>
          <FeedCard previewKey="A" lead={<span>Ready</span>} title="A card" />
        </CardGrid>
      </FeedPreview>,
    );
    const grid = screen.getByRole('button', { name: 'A card' }).closest('[data-slot="card-grid"]');
    const classes = grid?.className.split(/\s+/) ?? [];
    expect(grid?.parentElement?.className.split(/\s+/)).toContain('@container');
    expect(classes).toContain('md:@min-[612px]:grid-cols-2');
    expect(classes).not.toContain('md:grid-cols-2');
  });
});

describe('feed row group', () => {
  it('makes each counted row a door, leaves out a row counting zero, and ends a capped group in a filtered door', async () => {
    await renderInRouter(
      <RowGroup
        label="Shipped by project"
        rows={[
          { count: 71, key: 'LM', name: 'Loom CLI', to: { params: { key: 'LM' }, to: '/p/$key' } },
          { count: 0, key: 'ART', name: 'Muninn', to: { params: { key: 'ART' }, to: '/p/$key' } },
          { count: 48, key: 'MMR', name: 'Mimir', to: { params: { key: 'MMR' }, to: '/p/$key' } },
        ]}
        more={{
          count: 34,
          name: '5 more projects',
          to: { params: { key: 'MMR' }, search: { status: 'terminal' }, to: '/p/$key/tasks' },
        }}
      />,
    );
    const list = screen.getByRole('list', { name: 'Shipped by project' });
    expect(within(list).getAllByRole('link')).toHaveLength(3);
    expect(within(list).getByRole('link', { name: 'LM Loom CLI 71' })).toHaveAttribute(
      'href',
      '/p/LM',
    );
    expect(within(list).getByRole('link', { name: 'MMR Mimir 48' })).toBeVisible();
    expect(within(list).getByRole('link', { name: '5 more projects 34' })).toHaveAttribute(
      'href',
      '/p/MMR/tasks?status=terminal',
    );
    expect(within(list).queryByText('Muninn')).toBeNull();
  });

  it('keeps focus on a door when an earlier row drops to zero', async () => {
    const { rerender } = await renderInRouter(<RowGroup label="Spare" rows={spare(12)} />);
    screen.getByRole('link', { name: 'To groom 15' }).focus();
    rerender(<RowGroup label="Spare" rows={spare(0)} />);
    expect(screen.getByRole('link', { name: 'To groom 15' })).toHaveFocus();
  });

  it('keeps focus on a door when an unkeyed row is inserted above it', async () => {
    const groom = { count: 15, name: 'To groom', to: { to: '/' } as const };
    const seeds = { count: 12, name: 'Seeds to triage', to: { to: '/' } as const };
    const { rerender } = await renderInRouter(<RowGroup label="Spare" rows={[groom]} />);
    screen.getByRole('link', { name: 'To groom 15' }).focus();
    rerender(<RowGroup label="Spare" rows={[seeds, groom]} />);
    expect(screen.getByRole('link', { name: 'To groom 15' })).toHaveFocus();
  });

  it('offers no door to more when nothing more is there', async () => {
    await renderInRouter(
      <RowGroup
        label="By project"
        rows={[
          { count: 3, key: 'MMR', name: 'Mimir', to: { params: { key: 'MMR' }, to: '/p/$key' } },
        ]}
        more={{ count: 0, name: '0 more projects', to: { to: '/' } }}
      />,
    );
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('draws a row with no destination as a plain row: no link, no chevron, no hover fill', async () => {
    await renderInRouter(
      <RowGroup
        label="When you have a minute"
        rows={[
          { count: 7, name: 'Seeds to triage' },
          { count: 0, name: 'Going cold' },
          { count: 12, name: 'Ready to start', to: { to: '/' } },
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: 'When you have a minute' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Seeds to triage 7');
    expect(within(items[0]!).queryByRole('link')).toBeNull();
    expect(items[0]!.querySelector('svg')).toBeNull();
    expect(items[0]!.matches('[class*="hover:bg-"]')).toBe(false);
    expect(items[0]!.querySelector('[class*="hover:bg-"]')).toBeNull();
    expect(within(items[1]!).getByRole('link', { name: 'Ready to start 12' })).toBeVisible();
    expect(items[1]!.querySelector('svg')).not.toBeNull();
    expect(items[1]!.querySelector('[class*="hover:bg-"]')).not.toBeNull();
  });

  it('frames a standalone group in a card when asked, and leaves it unframed by default', async () => {
    const rows = [{ count: 2, name: 'Doctor findings' }];
    const { rerender } = await renderInRouter(<RowGroup label="Spare" rows={rows} framed />);
    const framed = screen.getByRole('list', { name: 'Spare' });
    expect(framed.parentElement).toHaveAttribute('data-slot', 'row-group-frame');
    rerender(<RowGroup label="Spare" rows={rows} />);
    expect(screen.getByRole('list', { name: 'Spare' }).parentElement).not.toHaveAttribute(
      'data-slot',
      'row-group-frame',
    );
  });
});

function finished(id: string, title: string, time: string, note?: string) {
  return (
    <FinishedRow
      key={id}
      to={nodeLink(id)}
      dot={<span />}
      status={note === undefined ? 'Done' : 'Abandoned'}
      title={title}
      time={time}
      note={note}
    />
  );
}

/** One open day, "Today", holding `rows`. */
function todayOf(rows: ReturnType<typeof finished>[]) {
  return [{ count: rows.length, key: 'today', label: 'Today', rows }];
}

/**
 * A day capped at 2 whose focused row, Loom 0.20, a refetch has pushed to
 * third: it is held past the cap, with Show 1 more below it.
 */
async function renderHeldPastCap() {
  const first = finished('MMR-718', 'Readable type', '08:06');
  const second = finished('MMR-746', 'Loom 0.20', '04:40');
  const third = finished('MMR-697', 'MCP hints', '03:10');
  const { rerender } = await renderInRouter(
    <DayFolds days={todayOf([first, second, third])} cap={2} />,
  );
  const link = screen.getByRole('link', { name: 'Done: Loom 0.20 04:40' });
  link.focus();
  const newer = finished('MMR-750', 'Newer', '09:30');
  rerender(<DayFolds days={todayOf([newer, first, second, third])} cap={2} />);
  return { first, link, newer, rerender, second, third };
}

describe('feed day folds', () => {
  const days = [
    {
      count: 3,
      key: '2026-11-22',
      label: 'Today',
      rows: [
        finished('MMR-718', 'Readable type', '08:06'),
        finished('MMR-737', 'Stop-run dialog', '05:12', 'Abandoned: absorbed by MMR-740'),
        finished('MMR-746', 'Loom 0.20', '04:40'),
      ],
    },
    {
      count: 1,
      key: '2026-11-21',
      label: 'Saturday 21 November',
      rows: [finished('MMR-697', 'MCP hints', '22:41')],
    },
    {
      count: 1,
      key: '2026-11-20',
      label: 'Friday 20 November',
      rows: [finished('MMR-712', 'Notification kinds', '19:02')],
    },
  ];

  it('opens only the latest day, and opens another on a press', async () => {
    await renderInRouter(<DayFolds days={days} cap={2} />);
    const today = screen.getByRole('button', { name: 'Today 3' });
    const saturday = screen.getByRole('button', { name: 'Saturday 21 November 1' });
    expect(today).toHaveAttribute('aria-expanded', 'true');
    expect(saturday).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Friday 20 November 1' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByRole('link', { name: /MCP hints/ })).toBeNull();
    await userEvent.click(saturday);
    expect(saturday).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Done: MCP hints 22:41' })).toBeVisible();
  });

  it('names each finished row with its status, and an abandoned row with its reason', async () => {
    await renderInRouter(<DayFolds days={days} cap={3} />);
    expect(screen.getByRole('link', { name: 'Done: Readable type 08:06' })).toHaveAttribute(
      'href',
      '/p/MMR/718',
    );
    expect(
      screen.getByRole('link', {
        name: 'Abandoned: Stop-run dialog Abandoned: absorbed by MMR-740 05:12',
      }),
    ).toBeVisible();
  });

  it('keeps focus on its record when a refetch adds a newer row above it', async () => {
    const day = (rows: ReturnType<typeof finished>[]) => [
      { count: rows.length, key: 'today', label: 'Today', rows },
    ];
    const older = finished('MMR-718', 'Readable type', '08:06');
    const { rerender } = await renderInRouter(<DayFolds days={day([older])} cap={3} />);
    screen.getByRole('link', { name: 'Done: Readable type 08:06' }).focus();
    rerender(<DayFolds days={day([finished('MMR-750', 'Newer', '09:30'), older])} cap={3} />);
    expect(document.activeElement).toHaveAccessibleName('Done: Readable type 08:06');
    expect(document.activeElement).toHaveAttribute('href', '/p/MMR/718');
  });

  it('keeps a focused row shown, and focused, when a refetch pushes it past the cap', async () => {
    const day = (rows: ReturnType<typeof finished>[]) => [
      { count: rows.length, key: 'today', label: 'Today', rows },
    ];
    const first = finished('MMR-718', 'Readable type', '08:06');
    const second = finished('MMR-746', 'Loom 0.20', '04:40');
    const third = finished('MMR-697', 'MCP hints', '03:10');
    const { rerender } = await renderInRouter(
      <DayFolds days={day([first, second, third])} cap={2} />,
    );
    screen.getByRole('link', { name: 'Done: Loom 0.20 04:40' }).focus();
    rerender(
      <DayFolds
        days={day([finished('MMR-750', 'Newer', '09:30'), first, second, third])}
        cap={2}
      />,
    );
    expect(document.activeElement).toHaveAccessibleName('Done: Loom 0.20 04:40');
    expect(screen.getByRole('button', { name: 'Show 1 more' })).toBeVisible();
  });

  it('keeps a row held past the cap shown when the window loses focus', async () => {
    const day = (rows: ReturnType<typeof finished>[]) => [
      { count: rows.length, key: 'today', label: 'Today', rows },
    ];
    const first = finished('MMR-718', 'Readable type', '08:06');
    const second = finished('MMR-746', 'Loom 0.20', '04:40');
    const third = finished('MMR-697', 'MCP hints', '03:10');
    const { rerender } = await renderInRouter(
      <DayFolds days={day([first, second, third])} cap={2} />,
    );
    const link = screen.getByRole('link', { name: 'Done: Loom 0.20 04:40' });
    link.focus();
    rerender(
      <DayFolds
        days={day([finished('MMR-750', 'Newer', '09:30'), first, second, third])}
        cap={2}
      />,
    );
    // Switching away fires focusout with no relatedTarget while the document
    // no longer has focus; the element keeps focus for when the window returns.
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    try {
      fireEvent.focusOut(link, { relatedTarget: null });
    } finally {
      hasFocus.mockRestore();
    }
    expect(screen.getByRole('link', { name: 'Done: Loom 0.20 04:40' })).toBe(link);
    expect(screen.getByRole('button', { name: 'Show 1 more' })).toBeVisible();
  });

  it('lets a row held past the cap go when focus leaves it within the page', async () => {
    const day = (rows: ReturnType<typeof finished>[]) => [
      { count: rows.length, key: 'today', label: 'Today', rows },
    ];
    const first = finished('MMR-718', 'Readable type', '08:06');
    const second = finished('MMR-746', 'Loom 0.20', '04:40');
    const third = finished('MMR-697', 'MCP hints', '03:10');
    const { rerender } = await renderInRouter(
      <DayFolds days={day([first, second, third])} cap={2} />,
    );
    screen.getByRole('link', { name: 'Done: Loom 0.20 04:40' }).focus();
    rerender(
      <DayFolds
        days={day([finished('MMR-750', 'Newer', '09:30'), first, second, third])}
        cap={2}
      />,
    );
    act(() => {
      screen.getByRole('button', { name: 'Today 4' }).focus();
    });
    expect(screen.queryByRole('link', { name: 'Done: Loom 0.20 04:40' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show 2 more' })).toBeVisible();
  });

  it('keeps a row held past the cap when Tab moves from it to Show N more', async () => {
    await renderHeldPastCap();
    await userEvent.tab();
    expect(document.activeElement).toHaveAccessibleName('Show 1 more');
    expect(screen.getByRole('link', { name: 'Done: Loom 0.20 04:40' })).toBeVisible();
  });

  it('reveals the rest on the first mouse press of Show N more while a row is held', async () => {
    await renderHeldPastCap();
    const user = userEvent.setup();
    const more = screen.getByRole('button', { name: 'Show 1 more' });
    await user.pointer({ keys: '[MouseLeft>]', target: more });
    expect(more).toHaveAccessibleName('Show 1 more');
    expect(screen.getAllByRole('link')).toHaveLength(3);
    await user.pointer({ keys: '[/MouseLeft]', target: more });
    expect(screen.getAllByRole('link')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: /^Show/ })).toBeNull();
  });

  it('leaves focus on a held row through a mouse press on Show N more', async () => {
    const { link } = await renderHeldPastCap();
    const more = screen.getByRole('button', { name: 'Show 1 more' });
    // A press that moved focus would blur the held row before the click: to
    // the page in Safari and Firefox, or out of the fold from another day.
    expect(fireEvent.mouseDown(more)).toBe(false);
    expect(document.activeElement).toBe(link);
    expect(screen.getAllByRole('link')).toHaveLength(3);
  });

  it('moves focus to the row Show N more reveals, not the held row before it', async () => {
    await renderHeldPastCap();
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    expect(document.activeElement).toHaveAccessibleName('Done: MCP hints 03:10');
  });

  it('lets a held row go when focus leaves to the page while the window keeps focus', async () => {
    const { link } = await renderHeldPastCap();
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    try {
      act(() => {
        link.blur();
      });
    } finally {
      hasFocus.mockRestore();
    }
    expect(screen.queryByRole('link', { name: 'Done: Loom 0.20 04:40' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show 2 more' })).toBeVisible();
  });

  it('drops the hold when a refetch removes the held row, so its return keeps the cap', async () => {
    const { first, newer, rerender, second, third } = await renderHeldPastCap();
    rerender(<DayFolds days={todayOf([newer, first, third])} cap={2} />);
    rerender(<DayFolds days={todayOf([newer, first, second, third])} cap={2} />);
    expect(screen.getAllByRole('link')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Show 2 more' })).toBeVisible();
  });

  it('opens the new day alone when a new latest day arrives', async () => {
    const { rerender } = await renderInRouter(<DayFolds days={days.slice(1)} cap={2} />);
    await userEvent.click(screen.getByRole('button', { name: 'Friday 20 November 1' }));
    rerender(<DayFolds days={days} cap={2} />);
    expect(screen.getByRole('button', { name: 'Today 3' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    for (const name of ['Saturday 21 November 1', 'Friday 20 November 1']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-expanded', 'false');
    }
  });

  it('gives a finished title up to two lines on a phone and one line from md', async () => {
    await renderInRouter(
      <FinishedRow
        to={nodeLink('MMR-1')}
        dot={<span />}
        status="Done"
        title="Home becomes one feed column, opening with the day"
        time="09:00"
      />,
    );
    const title = screen.getByText('Home becomes one feed column, opening with the day');
    expect(title).toHaveClass(
      'block',
      'truncate',
      'max-md:line-clamp-2',
      'max-md:whitespace-normal',
    );
  });

  it('keeps a dot’s own text out of the row’s name', async () => {
    await renderInRouter(
      <FinishedRow
        to={nodeLink('MMR-1')}
        dot={<span>Completed</span>}
        status="Done"
        title="One"
        time="09:00"
      />,
    );
    expect(screen.getByRole('link')).toHaveAccessibleName('Done: One 09:00');
  });

  it('hands focus past a revealed row’s disabled control to the one that takes it', async () => {
    await renderInRouter(
      <DayFolds
        days={[
          {
            count: 2,
            key: 'd',
            label: 'Today',
            rows: [rowWithDisabledFirst('one'), rowWithDisabledFirst('two')],
          },
        ]}
        cap={1}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Show 1 more' }));
    expect(screen.getByRole('link', { name: 'two' })).toHaveFocus();
  });

  it('looks past a revealed row with nothing to focus, and falls back to the day', async () => {
    const { unmount } = await renderInRouter(
      <DayFolds
        days={[
          {
            count: 3,
            key: 'd',
            label: 'Today',
            rows: [linkedRow('one'), plainRow('two'), linkedRow('three')],
          },
        ]}
        cap={1}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Show 2 more' }));
    expect(screen.getByRole('link', { name: 'three' })).toHaveFocus();
    unmount();
    await renderInRouter(
      <DayFolds
        days={[{ count: 2, key: 'd', label: 'Today', rows: [linkedRow('one'), plainRow('two')] }]}
        cap={1}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Show 1 more' }));
    expect(screen.getByRole('button', { name: 'Today 2' })).toHaveFocus();
  });

  it('shows a capped day’s rest in place and moves focus to the first row it revealed', async () => {
    await renderInRouter(<DayFolds days={days} cap={2} />);
    expect(screen.queryByRole('link', { name: /Loom 0\.20/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show 1 more' }));
    const revealed = screen.getByRole('link', { name: 'Done: Loom 0.20 04:40' });
    expect(revealed).toHaveFocus();
    expect(screen.queryByRole('button', { name: /Show \d+ more/ })).toBeNull();
  });
});

describe('shipped summary', () => {
  const week = [
    { count: 41, name: 'Monday', short: 'Mon' },
    { count: 12_400, name: 'Tuesday', short: 'Tue' },
    { count: 50, name: 'Wednesday', short: 'Wed' },
    { count: 0, name: 'Thursday', short: 'Thu' },
    { count: 12, name: 'Friday', short: 'Fri' },
    { count: 6, name: 'Saturday', short: 'Sat' },
    { count: 7, name: 'today', short: 'Today' },
  ];

  it('reads every day’s exact count, today’s as so far, and shortens a large count on screen', async () => {
    await renderInRouter(<ShippedSummary days={week} breakdown={<p>by project</p>} />);
    expect(
      screen.getByRole('img', {
        name: 'Shipped each day for the last 7 days: Monday 41, Tuesday 12,400, Wednesday 50, Thursday 0, Friday 12, Saturday 6, and 7 so far today.',
      }),
    ).toBeVisible();
    expect(screen.getByText('12k')).toBeVisible();
    // Today is the last column, not the first.
    const columns = screen.getByRole('img').children;
    expect(columns[columns.length - 1]).toHaveTextContent('so far');
    expect(columns[0]).not.toHaveTextContent('so far');
    expect(screen.getByText('by project')).toBeVisible();
  });

  it('keeps every shortened count to four characters, up through millions', () => {
    expect(
      [
        999, 1000, 1234, 9949, 9950, 10_000, 12_400, 999_499, 999_500, 1_000_000, 12_400_000,
        999_500_000, 2_500_000_000, 999_500_000_000,
      ].map(shortCount),
    ).toEqual([
      '999',
      '1k',
      '1.2k',
      '9.9k',
      '10k',
      '10k',
      '12k',
      '999k',
      '1M',
      '1M',
      '12M',
      '1B',
      '2.5B',
      '1T',
    ]);
  });

  it('reads a short week without a dangling list', () => {
    expect(chartName([{ count: 3, name: 'today', short: 'Today' }])).toBe(
      'Shipped today: 3 so far today.',
    );
    expect(chartName([])).toBe('Nothing shipped to show.');
  });
});

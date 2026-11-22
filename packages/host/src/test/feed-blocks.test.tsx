import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { FeedCard } from '../components/patterns/feed/card';
import { DayFolds, FinishedRow } from '../components/patterns/feed/day-fold';
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
});

describe('feed card', () => {
  it('is one link named by its title and described by its status line and chips', async () => {
    await renderInRouter(
      <FeedCard
        to={nodeLink('MMR-709')}
        lead={<span>In progress</span>}
        id="MMR-709"
        age="50m"
        title="Send an encrypted Web Push"
        detail="Latest note: agreement confirmed."
        chips={<span>Size large</span>}
      />,
    );
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    const [link] = links;
    expect(link).toHaveAccessibleName('Send an encrypted Web Push');
    expect(link).toHaveAttribute('href', '/p/MMR/709');
    expect(link).toHaveAccessibleDescription('In progress MMR-709 50m Size large');
  });

  it('is described by its status line alone when it has no chips', async () => {
    await renderInRouter(
      <FeedCard
        to={nodeLink('MMR-715')}
        lead={<span>Under review</span>}
        id="MMR-715"
        age="15m"
        title="Mobile top bar"
        chips={false}
      />,
    );
    expect(screen.getByRole('link', { name: 'Mobile top bar' })).toHaveAccessibleDescription(
      'Under review MMR-715 15m',
    );
  });

  it('keeps its one button a separate target that acts without following the link', async () => {
    const answered = vi.fn();
    const { router } = await renderInRouter(
      <FeedCard
        to={nodeLink('HUGI-15')}
        lead={<span>Needs answers</span>}
        id="HUGI-15"
        age="1d"
        title="Keep run logs and make them readable"
        action={
          <button type="button" onClick={answered}>
            Answer
          </button>
        }
      />,
    );
    const link = screen.getByRole('link', { name: 'Keep run logs and make them readable' });
    const answer = screen.getByRole('button', { name: 'Answer' });
    expect(link).not.toContainElement(answer);
    await userEvent.click(answer);
    expect(answered).toHaveBeenCalledOnce();
    expect(router.state.location.pathname).toBe('/');
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
    const spare = (seeds: number) => [
      { count: seeds, name: 'Seeds to triage', to: { to: '/' } as const },
      { count: 15, name: 'To groom', to: { params: { key: 'MMR' }, to: '/p/$key' } as const },
    ];
    const { rerender } = await renderInRouter(<RowGroup label="Spare" rows={spare(12)} />);
    screen.getByRole('link', { name: 'To groom 15' }).focus();
    rerender(<RowGroup label="Spare" rows={spare(0)} />);
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
    const row = (name: string) => (
      <div key={name}>
        <button type="button" disabled tabIndex={0}>
          Undo
        </button>
        <a href={`/${name}`}>{name}</a>
      </div>
    );
    await renderInRouter(
      <DayFolds
        days={[{ count: 2, key: 'd', label: 'Today', rows: [row('one'), row('two')] }]}
        cap={1}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Show 1 more' }));
    expect(screen.getByRole('link', { name: 'two' })).toHaveFocus();
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

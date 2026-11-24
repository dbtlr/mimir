import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RecordHeader } from '../components/patterns/record-header';
import type { TrailStep } from '../components/patterns/record-header';
import { renderInRouter } from './router';
import { stubViewport } from './viewport';

/*
 * The record header's measured behaviour (ADR 0019, MMR-726): jsdom lays
 * nothing out, so each case stands in the sizes a browser would measure.
 */

const step = (key: string, label: string): TrailStep => ({
  key,
  label,
  to: { params: { key: 'MMR' }, to: '/p/$key' },
});

const TRAIL = [
  step('MMR', 'Mimir'),
  step('MMR-356', 'Console usability'),
  step('MMR-717', 'Console readability'),
];

/** Stand in a layout: every element reports these sizes. */
function stubLayout(size: {
  clientWidth?: number;
  scrollWidth?: number;
  clientHeight?: number;
  scrollHeight?: number;
  rectWidth?: number;
}) {
  for (const [name, value] of Object.entries(size)) {
    if (name === 'rectWidth') {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        width: value,
      } as DOMRect);
    } else {
      vi.spyOn(HTMLElement.prototype, name as 'clientWidth', 'get').mockReturnValue(value);
    }
  }
}

function header(actions = true) {
  return renderInRouter(
    <RecordHeader
      trail={TRAIL}
      title="Record pages share one header"
      status={<span>Ready</span>}
      type="Task"
      recordId="MMR-726"
      summary="A summary long enough to run past three lines."
      actions={
        actions ? (
          <>
            <button type="button">Start</button>
            <button type="button">More</button>
          </>
        ) : undefined
      }
    />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('record header summary', () => {
  it('offers "more" when the summary runs past its three lines, and "less" once open', async () => {
    stubLayout({ clientHeight: 69, scrollHeight: 92 });
    await header();

    const more = await screen.findByRole('button', { name: 'more' });
    expect(screen.getByText(/A summary long enough/)).toHaveClass('line-clamp-3');
    await userEvent.click(more);
    expect(screen.getByRole('button', { name: 'less' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/A summary long enough/)).not.toHaveClass('line-clamp-3');
  });

  it('offers nothing when the summary fits', async () => {
    stubLayout({ clientHeight: 46, scrollHeight: 46 });
    await header();

    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('button', { name: 'more' })).toBeNull();
  });
});

/** Whether the actions sit in the title's row rather than below the summary. */
const besideTitle = () =>
  screen
    .getByRole('heading', { level: 1 })
    .parentElement?.contains(screen.getByRole('button', { name: 'More' }));

describe('record header actions', () => {
  it('sit beside the title on desktop while the title keeps 440px', async () => {
    stubViewport('desktop');
    // 440 for the title, 24 between, and two 90px buttons 12 apart: 656 is enough.
    stubLayout({ clientWidth: 700, rectWidth: 90 });
    await header();

    await vi.waitFor(() => {
      expect(besideTitle()).toBe(true);
    });
  });

  it('drop below the summary on desktop when the title would keep less than 440px', async () => {
    stubViewport('desktop');
    stubLayout({ clientWidth: 600, rectWidth: 90 });
    await header();

    await screen.findByRole('heading', { level: 1 });
    expect(besideTitle()).toBe(false);
  });

  it('always sit below the summary on a phone', async () => {
    stubViewport('phone');
    stubLayout({ clientWidth: 2000, rectWidth: 90 });
    await header();

    await screen.findByRole('heading', { level: 1 });
    expect(besideTitle()).toBe(false);
  });
});

describe('record header trail', () => {
  it('folds the middle ancestors on desktop once they would give way past 120px', async () => {
    stubViewport('desktop');
    // Every box shows 80 of its 200px, so the middle label has given way past 120.
    stubLayout({ clientWidth: 80, scrollWidth: 200 });
    await header(false);

    const trail = screen.getByRole('navigation', { name: 'Ancestors' });
    await within(trail).findByRole('button', { name: 'Show 1 more ancestor' });
    expect(
      within(trail)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toStrictEqual(['Mimir', 'Console readability']);
  });
});

import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FeedCard } from '../components/patterns/feed/card';
import { CardGrid } from '../components/patterns/feed/card-grid';
import { FeedPreview } from '../components/patterns/feed/feed-preview';
import type { Preview } from '../components/patterns/feed/preview-panel';
import { ActionButton } from '../components/ui/action-button';
import { nodeLink } from '../lib/record-url';
import { renderInRouter } from './router';
import { stubViewport } from './viewport';
import type { Viewport } from './viewport';

/*
 * The preview panel (ADR 0019, MMR-720 refinement): a feed card's tap opens
 * its preview, a non-modal panel from `md` up and a modal bottom sheet below.
 * Layout, ink, and motion are a real browser's to check; jsdom has none.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const answered = vi.fn();
// The panel's action hands on the card's own button; this one moves focus to it, as a next surface's opener would.
const handedOn = vi.fn((button: HTMLElement | null) => {
  button?.focus();
});

const PREVIEWS: Record<string, Preview> = {
  'HUGI-15': {
    action: { label: 'Answer', name: 'Answer HUGI-15', onAction: handedOn },
    facts: [
      { label: 'Parent', value: 'Hugi 0.4: run logs' },
      { label: 'Size', value: 'Medium' },
    ],
    id: 'HUGI-15',
    lead: <span>Ready</span>,
    open: nodeLink('HUGI-15'),
    reason: 'Needs an answer before it can start.',
    title: 'Keep run logs and make them readable',
  },
  'MMR-709': {
    id: 'MMR-709',
    lead: <span>In progress</span>,
    open: nodeLink('MMR-709'),
    reason: 'The agent is building it.',
    title: 'Send an encrypted Web Push',
  },
  'MMR-715': {
    id: 'MMR-715',
    lead: <span>Under review</span>,
    open: nodeLink('MMR-715'),
    reason: 'Waiting on your review.',
    title: 'Mobile top bar',
  },
};

function Feed() {
  return (
    <>
      <button type="button">Before the feed</button>
      <FeedPreview preview={(key) => PREVIEWS[key]}>
        <CardGrid>
          <FeedCard
            previewKey="HUGI-15"
            lead={<span>Ready</span>}
            id="HUGI-15"
            title="Keep run logs and make them readable"
            action={
              <ActionButton variant="formOutline" aria-label="Answer HUGI-15" onClick={answered}>
                Answer
              </ActionButton>
            }
          />
          <FeedCard
            previewKey="MMR-709"
            lead={<span>In progress</span>}
            id="MMR-709"
            title="Send an encrypted Web Push"
          />
          <FeedCard
            previewKey="MMR-715"
            lead={<span>Under review</span>}
            id="MMR-715"
            title="Mobile top bar"
          />
        </CardGrid>
      </FeedPreview>
    </>
  );
}

async function renderFeed(viewport: Viewport = 'desktop') {
  stubViewport(viewport);
  answered.mockClear();
  handedOn.mockClear();
  return renderInRouter(<Feed />);
}

const card = (title: string) => screen.getByRole('button', { name: title });
const panel = () => screen.getByRole('dialog');
const panelTitle = () => within(panel()).getByRole('heading', { level: 2 });
const body = () => panel().querySelector<HTMLElement>('[data-slot="preview-body"]');

describe('feed card as the preview’s opener', () => {
  it('is a button that announces a dialog, named by its title and described by its status line', async () => {
    await renderFeed();
    const opener = card('Keep run logs and make them readable');
    expect(opener).toHaveAttribute('aria-haspopup', 'dialog');
    expect(opener).toHaveAccessibleDescription('Ready HUGI-15');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('keeps its own button a separate target that runs its action without opening the preview', async () => {
    await renderFeed();
    await userEvent.click(screen.getByRole('button', { name: 'Answer HUGI-15' }));
    expect(answered).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('preview panel: open, switch, close', () => {
  it('opens on the card’s tap, names the dialog by the record, and moves focus to its title', async () => {
    await renderFeed();
    await userEvent.click(card('Keep run logs and make them readable'));
    expect(panel()).toHaveAccessibleName('Keep run logs and make them readable');
    expect(panelTitle()).toHaveFocus();
    expect(within(panel()).getByText('Needs an answer before it can start.')).toBeVisible();
    expect(card('Keep run logs and make them readable')).toHaveAttribute('aria-expanded', 'true');
  });

  it('is non-modal from md up, so another card switches it in place', async () => {
    await renderFeed();
    await userEvent.click(card('Keep run logs and make them readable'));
    expect(panel()).not.toHaveAttribute('aria-modal', 'true');
    expect(document.querySelector('[data-slot="drawer-backdrop"]')).toBeNull();
    await userEvent.click(card('Send an encrypted Web Push'));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(panel()).toHaveAccessibleName('Send an encrypted Web Push');
    expect(panelTitle()).toHaveFocus();
    expect(card('Keep run logs and make them readable')).toHaveAttribute('aria-expanded', 'false');
    expect(card('Send an encrypted Web Push')).toHaveAttribute('aria-expanded', 'true');
  });

  it('scrolls the body back to the top on a switch', async () => {
    await renderFeed();
    await userEvent.click(card('Keep run logs and make them readable'));
    const scrolled = body();
    expect(scrolled).not.toBeNull();
    if (scrolled === null) {
      return;
    }
    scrolled.scrollTop = 120;
    await userEvent.click(card('Send an encrypted Web Push'));
    expect(body()?.scrollTop).toBe(0);
  });

  it('closes on a second tap of the selected card', async () => {
    await renderFeed();
    await userEvent.click(card('Keep run logs and make them readable'));
    await userEvent.click(card('Keep run logs and make them readable'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(card('Keep run logs and make them readable')).toHaveAttribute('aria-expanded', 'false');
  });

  it('runs another card’s own button without switching', async () => {
    await renderFeed();
    await userEvent.click(card('Send an encrypted Web Push'));
    await userEvent.click(screen.getByRole('button', { name: 'Answer HUGI-15' }));
    expect(answered).toHaveBeenCalledOnce();
    expect(panel()).toHaveAccessibleName('Send an encrypted Web Push');
  });

  it('closes on a click in empty feed space, and returns focus to the card', async () => {
    await renderFeed();
    await userEvent.click(card('Send an encrypted Web Push'));
    const grid = card('Send an encrypted Web Push').closest('[data-slot="card-grid"]');
    expect(grid).not.toBeNull();
    if (grid === null) {
      return;
    }
    await userEvent.click(grid);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(card('Send an encrypted Web Push')).toHaveFocus();
  });

  it('stays open for a click outside the feed', async () => {
    await renderFeed();
    await userEvent.click(card('Send an encrypted Web Push'));
    await userEvent.click(screen.getByRole('button', { name: 'Before the feed' }));
    expect(panel()).toBeVisible();
  });

  it('closes as the page navigates', async () => {
    const { router } = await renderFeed();
    await userEvent.click(card('Send an encrypted Web Push'));
    await act(async () => {
      await router.navigate({ params: { key: 'MMR' }, to: '/p/$key' });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Close returns focus to the card that opened the latest preview', async () => {
    await renderFeed();
    await userEvent.click(card('Keep run logs and make them readable'));
    await userEvent.click(card('Mobile top bar'));
    await userEvent.click(within(panel()).getByRole('button', { name: 'Close preview' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(card('Mobile top bar')).toHaveFocus();
  });

  it('Escape closes it from the panel, and focus returns to the card', async () => {
    await renderFeed();
    await userEvent.click(card('Send an encrypted Web Push'));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(card('Send an encrypted Web Push')).toHaveFocus();
  });

  it('Escape closes it from the feed', async () => {
    await renderFeed();
    await userEvent.click(card('Send an encrypted Web Push'));
    card('Mobile top bar').focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('preview panel: tab order on desktop', () => {
  it('Shift+Tab from the title goes back to the selected card, with the panel left open', async () => {
    await renderFeed();
    await userEvent.click(card('Send an encrypted Web Push'));
    await userEvent.tab({ shift: true });
    expect(card('Send an encrypted Web Push')).toHaveFocus();
    expect(panel()).toBeVisible();
  });

  it('Close follows the title, and Shift+Tab from Close goes back through the title to the card', async () => {
    await renderFeed();
    await userEvent.click(card('Send an encrypted Web Push'));
    await userEvent.tab();
    expect(within(panel()).getByRole('button', { name: 'Close preview' })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(panelTitle()).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(card('Send an encrypted Web Push')).toHaveFocus();
  });

  it('Tab from the last button goes on to the selected card’s own button', async () => {
    await renderFeed();
    await userEvent.click(card('Keep run logs and make them readable'));
    within(panel()).getByRole('button', { name: 'Answer HUGI-15' }).focus();
    await userEvent.tab();
    expect(
      screen.getAllByRole('button', { name: 'Answer HUGI-15' }).find((b) => !panel().contains(b)),
    ).toHaveFocus();
  });

  it('Tab from the last button goes on to the next card when the selected one has no button', async () => {
    await renderFeed();
    await userEvent.click(card('Send an encrypted Web Push'));
    within(panel()).getByRole('link', { name: 'Open MMR-709' }).focus();
    await userEvent.tab();
    expect(card('Mobile top bar')).toHaveFocus();
  });
});

describe('preview panel footer', () => {
  it('is Open, always an outline, then the card’s action as the one solid button', async () => {
    await renderFeed();
    await userEvent.click(card('Keep run logs and make them readable'));
    const open = within(panel()).getByRole('link', { name: 'Open HUGI-15' });
    expect(open).toHaveAttribute('href', '/p/HUGI/15');
    expect(open.className.split(/\s+/)).toContain('inset-ring-ink-faint');
    const action = within(panel()).getByRole('button', { name: 'Answer HUGI-15' });
    expect(action.className.split(/\s+/)).toContain('bg-action');
    expect(open.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('closes for the card’s action and hands it the card’s own button, where focus can land', async () => {
    await renderFeed();
    await userEvent.click(card('Keep run logs and make them readable'));
    await userEvent.click(within(panel()).getByRole('button', { name: 'Answer HUGI-15' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    const own = screen.getByRole('button', { name: 'Answer HUGI-15' });
    expect(handedOn).toHaveBeenCalledExactlyOnceWith(own);
    expect(own).toHaveFocus();
    expect(answered).not.toHaveBeenCalled();
  });

  it('is Open alone when the card has no action', async () => {
    await renderFeed();
    await userEvent.click(card('Send an encrypted Web Push'));
    const footer = panel().querySelector('[data-slot="preview-footer"]');
    expect(footer).not.toBeNull();
    if (footer === null) {
      return;
    }
    expect(within(footer as HTMLElement).getAllByRole('link')).toHaveLength(1);
    expect(within(footer as HTMLElement).queryByRole('button')).toBeNull();
  });

  it('lists the facts as a definition list', async () => {
    await renderFeed();
    await userEvent.click(card('Keep run logs and make them readable'));
    const terms = within(panel()).getAllByRole('term');
    expect(terms.map((term) => term.textContent)).toEqual(['Parent', 'Size']);
    expect(
      within(panel())
        .getAllByRole('definition')
        .map((value) => value.textContent),
    ).toEqual(['Hugi 0.4: run logs', 'Medium']);
  });
});

describe('preview panel on a phone', () => {
  it('is a modal bottom sheet', async () => {
    await renderFeed('phone');
    await userEvent.click(card('Send an encrypted Web Push'));
    expect(panel()).toHaveAttribute('aria-modal', 'true');
    expect(document.querySelector('[data-slot="drawer-backdrop"]')).not.toBeNull();
    expect(panelTitle()).toHaveFocus();
  });
});

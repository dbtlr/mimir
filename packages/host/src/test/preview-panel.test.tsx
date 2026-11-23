import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FeedCard } from '../components/patterns/feed/card';
import { CardGrid } from '../components/patterns/feed/card-grid';
import { FeedPreview } from '../components/patterns/feed/feed-preview';
import type { Preview } from '../components/patterns/feed/preview-panel';
import { ActionButton } from '../components/ui/action-button';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../components/ui/menu';
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

/** The sample feed; `gone` is a record that has left it, whose card has no preview any more. */
function Feed({ gone }: { gone?: string }) {
  return (
    <>
      <button type="button">Before the feed</button>
      <FeedPreview preview={(key) => (key === gone ? undefined : PREVIEWS[key])}>
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
        <div role="img" aria-label="Lanes this week" />
        <div inert>
          <button type="button">Behind a dialog</button>
        </div>
        <button type="button" hidden>
          Folded away
        </button>
      </FeedPreview>
      <button type="button">After the feed</button>
    </>
  );
}

/** A feed whose one card sits beside a menu, for the Escape order. */
function FeedWithMenu() {
  return (
    <FeedPreview preview={(key) => PREVIEWS[key]}>
      <FeedCard
        previewKey="MMR-709"
        lead={<span>In progress</span>}
        title="Send an encrypted Web Push"
      />
      <Menu>
        <MenuTrigger render={<ActionButton variant="outline" />}>Sort</MenuTrigger>
        <MenuContent>
          <MenuItem>Newest first</MenuItem>
        </MenuContent>
      </Menu>
    </FeedPreview>
  );
}

/** A feed whose card with no button is followed by a control out of the tab order and a disclosure. */
function FeedWithDisclosure() {
  return (
    <FeedPreview preview={(key) => PREVIEWS[key]}>
      <FeedCard
        previewKey="MMR-709"
        lead={<span>In progress</span>}
        title="Send an encrypted Web Push"
      />
      <button type="button" tabIndex={-1}>
        Out of the tab order
      </button>
      <details>
        <summary>Why it runs long</summary>
        <p>Every device needs its own key.</p>
      </details>
      <FeedCard previewKey="MMR-715" lead={<span>Under review</span>} title="Mobile top bar" />
    </FeedPreview>
  );
}

/** A ResizeObserver jsdom lacks: `resize(element)` runs the observers watching `element`. */
function stubResizeObserver() {
  const watching = new Map<Element, Set<() => void>>();
  class FakeResizeObserver {
    readonly #report: () => void;
    readonly #targets = new Set<Element>();
    constructor(report: () => void) {
      this.#report = report;
    }
    observe(target: Element) {
      this.#targets.add(target);
      watching.set(target, (watching.get(target) ?? new Set()).add(this.#report));
    }
    unobserve(target: Element) {
      watching.get(target)?.delete(this.#report);
    }
    disconnect() {
      for (const target of this.#targets) {
        watching.get(target)?.delete(this.#report);
      }
    }
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  return (element: Element) => {
    act(() => {
      for (const report of watching.get(element) ?? []) {
        report();
      }
    });
  };
}

async function renderFeed(viewport: Viewport = 'desktop') {
  stubViewport(viewport);
  answered.mockClear();
  handedOn.mockClear();
  const rendered = await renderInRouter(<Feed />);
  // jsdom lays nothing out, so a hidden control is shown to `checkVisibility` unless told.
  for (const hidden of document.querySelectorAll<HTMLElement>('[hidden]')) {
    Object.defineProperty(hidden, 'checkVisibility', { configurable: true, value: () => false });
  }
  return rendered;
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

  it('closes on a click on a chart in the feed, which is not a control', async () => {
    await renderFeed();
    await userEvent.click(card('Send an encrypted Web Push'));
    await userEvent.click(screen.getByRole('img', { name: 'Lanes this week' }));
    expect(screen.queryByRole('dialog')).toBeNull();
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

  it('lets go of the selection when the selected card’s record leaves the feed', async () => {
    const { rerender } = await renderFeed();
    await userEvent.click(card('Send an encrypted Web Push'));
    rerender(<Feed gone="MMR-709" />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(card('Send an encrypted Web Push')).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(card('Mobile top bar'));
    expect(panel()).toHaveAccessibleName('Mobile top bar');
  });

  it('Escape closes it from the feed', async () => {
    await renderFeed();
    await userEvent.click(card('Send an encrypted Web Push'));
    card('Mobile top bar').focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('preview panel: the selected card', () => {
  it('marks the selected card and gives it the accent edge, and only that card', async () => {
    await renderFeed();
    await userEvent.click(card('Send an encrypted Web Push'));
    const selected = card('Send an encrypted Web Push').closest('[data-slot="feed-card"]');
    const other = card('Mobile top bar').closest('[data-slot="feed-card"]');
    expect(selected).toHaveAttribute('data-selected');
    expect(selected?.className.split(/\s+/)).toContain('data-selected:border-accent');
    expect(other).not.toHaveAttribute('data-selected');
  });

  it('scrolls into view on open, and again when a reflow changes the feed’s width', async () => {
    const resize = stubResizeObserver();
    const scrolled = vi.spyOn(Element.prototype, 'scrollIntoView');
    await renderFeed();
    const feed = document.querySelector<HTMLElement>('[data-slot="feed-preview"]');
    if (feed === null) {
      throw new Error('no feed');
    }
    let width = 1240;
    vi.spyOn(feed, 'getBoundingClientRect').mockImplementation(() =>
      DOMRect.fromRect({ height: 600, width }),
    );
    await userEvent.click(card('Mobile top bar'));
    const selected = card('Mobile top bar').closest('[data-slot="feed-card"]');
    expect(scrolled.mock.contexts).toEqual([selected]);
    expect(scrolled).toHaveBeenLastCalledWith({ behavior: 'instant', block: 'nearest' });
    scrolled.mockClear();
    resize(feed);
    expect(scrolled).not.toHaveBeenCalled();
    width = 800;
    resize(feed);
    expect(scrolled.mock.contexts).toEqual([selected]);
    vi.restoreAllMocks();
  });
});

describe('preview panel: Escape and the layers above it', () => {
  it('closes an open menu in the feed first, then the panel', async () => {
    stubViewport('desktop');
    await renderInRouter(<FeedWithMenu />);
    await userEvent.click(card('Send an encrypted Web Push'));
    await userEvent.click(screen.getByRole('button', { name: 'Sort' }));
    expect(screen.getByRole('menu')).toBeVisible();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(panel()).toBeVisible();
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

describe('preview panel: tab order from outside on desktop', () => {
  it('Tab from the selected card goes into the panel, to its title', async () => {
    await renderFeed();
    await userEvent.click(card('Send an encrypted Web Push'));
    card('Send an encrypted Web Push').focus();
    await userEvent.tab();
    expect(panelTitle()).toHaveFocus();
  });

  it('Shift+Tab from the control after the selected card goes back into the panel, to its last button', async () => {
    await renderFeed();
    await userEvent.click(card('Keep run logs and make them readable'));
    screen
      .getAllByRole('button', { name: 'Answer HUGI-15' })
      .find((button) => !panel().contains(button))
      ?.focus();
    await userEvent.tab({ shift: true });
    expect(within(panel()).getByRole('button', { name: 'Answer HUGI-15' })).toHaveFocus();
  });

  it('Tab from the feed’s last card goes past the panel to the control after it', async () => {
    await renderFeed();
    await userEvent.click(card('Keep run logs and make them readable'));
    card('Mobile top bar').focus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'After the feed' })).toHaveFocus();
  });

  it('Shift+Tab from the control after the panel goes past it to the feed’s last card', async () => {
    await renderFeed();
    await userEvent.click(card('Keep run logs and make them readable'));
    screen.getByRole('button', { name: 'After the feed' }).focus();
    await userEvent.tab({ shift: true });
    expect(card('Mobile top bar')).toHaveFocus();
  });

  it('Tab from the last button of the last card’s panel skips the panel, a closed region, and a hidden control', async () => {
    await renderFeed();
    await userEvent.click(card('Mobile top bar'));
    within(panel()).getByRole('link', { name: 'Open MMR-715' }).focus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'After the feed' })).toHaveFocus();
  });
});

describe('preview panel: tab order through a disclosure', () => {
  it('Tab from the last button reaches a disclosure after the card, past a control out of the tab order', async () => {
    stubViewport('desktop');
    await renderInRouter(<FeedWithDisclosure />);
    await userEvent.click(card('Send an encrypted Web Push'));
    within(panel()).getByRole('link', { name: 'Open MMR-709' }).focus();
    await userEvent.tab();
    expect(screen.getByText('Why it runs long')).toHaveFocus();
  });

  it('Shift+Tab from that disclosure goes back into the panel, to its last button', async () => {
    stubViewport('desktop');
    await renderInRouter(<FeedWithDisclosure />);
    await userEvent.click(card('Send an encrypted Web Push'));
    screen.getByText('Why it runs long').focus();
    await userEvent.tab({ shift: true });
    expect(within(panel()).getByRole('link', { name: 'Open MMR-709' })).toHaveFocus();
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

  it('on a phone, closes for the card’s action with focus on the card’s own button', async () => {
    await renderFeed('phone');
    // The feature moves nothing itself: the sheet lands focus on the next surface's opener.
    handedOn.mockReturnValueOnce(undefined);
    await userEvent.click(card('Keep run logs and make them readable'));
    await userEvent.click(within(panel()).getByRole('button', { name: 'Answer HUGI-15' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    const own = screen.getByRole('button', { name: 'Answer HUGI-15' });
    expect(handedOn).toHaveBeenCalledExactlyOnceWith(own);
    expect(own).toHaveFocus();
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

/** A rect 300 wide at `top`, for a layout jsdom lacks. */
const rectAt = (top: number, height: number) =>
  DOMRect.fromRect({ height, width: 300, x: 0, y: top });

/**
 * HUGI-15's capped body, laid out as jsdom cannot: 200 tall at 100, the reason
 * 24–99, the fact list from 119 (its hairline at 120), and the two facts at
 * 140–162 and 176–198, in the body's scroll space. Its rests are 0, 120 (the
 * hairline hidden, the first fact 20 below the header), and 162.
 */
function layOutCappedBody(element: HTMLElement) {
  const content = element.firstElementChild;
  const list = element.querySelector('dl');
  const facts = [...element.querySelectorAll('[data-slot="preview-fact"]')];
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: 200 });
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 362 });
  const at = (top: number, height: number) => rectAt(100 + top - element.scrollTop, height);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function layout(
    this: HTMLElement,
  ) {
    if (this === element) {
      return rectAt(100, 200);
    }
    if (this === content?.firstElementChild) {
      return at(24, 75);
    }
    if (this === list) {
      return at(119, 79);
    }
    const fact = facts.indexOf(this);
    return fact === -1 ? DOMRect.fromRect() : at(140 + fact * 36, 22);
  });
  element.style.paddingTop = '24px';
}

describe('preview panel on a phone', () => {
  it('is a modal bottom sheet', async () => {
    await renderFeed('phone');
    await userEvent.click(card('Send an encrypted Web Push'));
    expect(panel()).toHaveAttribute('aria-modal', 'true');
    expect(document.querySelector('[data-slot="drawer-backdrop"]')).not.toBeNull();
    expect(panelTitle()).toHaveFocus();
  });

  it('cues a body that runs on under the footer with a brighter footer hairline, in both themes', async () => {
    await renderFeed('phone');
    await userEvent.click(card('Keep run logs and make them readable'));
    const element = body();
    const footer = panel().querySelector('[data-slot="preview-footer"]');
    if (element === null || footer === null) {
      throw new Error('no body or footer');
    }
    layOutCappedBody(element);
    fireEvent.scroll(element);
    expect(footer).toHaveAttribute('data-continues');
    expect(footer.className.split(/\s+/)).toContain('data-continues:border-line-bright');
    element.scrollTop = 162;
    fireEvent.scroll(element);
    expect(footer).not.toHaveAttribute('data-continues');
    vi.restoreAllMocks();
  });

  it('settles a capped body’s scroll on the next rest the way it moved, a whole fact under the header', async () => {
    await renderFeed('phone');
    await userEvent.click(card('Keep run logs and make them readable'));
    const element = body();
    if (element === null) {
      throw new Error('no body');
    }
    layOutCappedBody(element);
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      element.scrollTop = options.top ?? element.scrollTop;
    });
    element.scrollTo = scrollTo as typeof element.scrollTo;
    const stopAt = (top: number) => {
      element.scrollTop = top;
      fireEvent.scroll(element);
      fireEvent(element, new Event('scrollend'));
    };
    // A short swipe down that stops with the reason cut under the header goes on, not back.
    stopAt(30);
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 120 }));
    stopAt(150);
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 162 }));
    stopAt(130);
    expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 120 }));
    scrollTo.mockClear();
    stopAt(120);
    expect(scrollTo).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

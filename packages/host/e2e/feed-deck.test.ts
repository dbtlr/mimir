import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { serveHarness } from './form-sheet/serve';
import type { Harness } from './form-sheet/serve';

/*
 * The Needs you deck in real layout (ADR 0019, MMR-721 refinement): the
 * phone deck's swipe, its peek, and its settle, focus moving into the
 * incoming card on every kind of turn, reduced motion, and a crossing of 768.
 * jsdom lays nothing out, moves nothing, and has no pointer gestures, so this
 * runs the /kit demo in Chromium, served from `e2e/form-sheet`.
 */

let harness: Harness;

test.beforeAll(async () => {
  harness = await serveHarness();
});

test.afterAll(async () => {
  await harness.close();
});

test.use({ hasTouch: true });

const PHONE = { height: 844, width: 390 };
const DESKTOP = { height: 900, width: 1024 };
/** The page's gutter on a phone, where the current card rests. */
const GUTTER = 14;

async function openDeck(page: Page, viewport = PHONE) {
  await page.setViewportSize(viewport);
  await page.goto(`${harness.origin}?form=deck`);
  await expect(page.getByRole('group', { name: '1 of 10' })).toBeVisible();
}

const group = (page: Page, name: string) => page.getByRole('group', { name });

/** The left edge of the card shown at a position, in px. */
async function left(page: Page, name: string): Promise<number | undefined> {
  return (await group(page, name).boundingBox())?.x;
}

/** The left edge of the card at a position one frame from now, before a slide could finish. */
function leftNextFrame(page: Page, position: string): Promise<number | null> {
  return page.evaluate(
    (name) =>
      new Promise<number | null>((resolve) => {
        requestAnimationFrame(() => {
          const card = document.querySelector(`[role="group"][aria-label="${name}"]`);
          resolve(card === null ? null : Math.round(card.getBoundingClientRect().x));
        });
      }),
    position,
  );
}

/** The position of the card whose stretched target holds focus, or what holds it instead. */
function focusedCard(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (active?.matches('[data-slot="feed-card-target"]') === true) {
      return active.closest('[role="group"]')?.getAttribute('aria-label') ?? 'no group';
    }
    return `not a card: ${active?.tagName ?? 'none'} ${active?.getAttribute('aria-label') ?? ''}`;
  });
}

/** A mouse drag across the current card, from x `from` by `by`. */
async function drag(
  page: Page,
  { from, by, steps = 12 }: { from: number; by: number; steps?: number },
) {
  const box = await group(page, '1 of 10').or(page.locator('[data-current]')).first().boundingBox();
  const y = (box?.y ?? 0) + 40;
  await page.mouse.move(from, y);
  await page.mouse.down();
  await page.mouse.move(from + by, y, { steps });
  await page.mouse.up();
}

/**
 * A finger's swipe across the deck by `by`, through Chromium's touch input, a
 * frame between moves and held still before it lifts, as a hand does: an
 * instant swipe leaves a fling running, and the next tap only stops it.
 */
async function swipe(page: Page, { from, by }: { from: number; by: number }) {
  const box = await page.locator('[data-current]').boundingBox();
  const y = (box?.y ?? 0) + 40;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { touchPoints: [{ x: from, y }], type: 'touchStart' });
  for (let step = 1; step <= 12; step += 1) {
    await cdp.send('Input.dispatchTouchEvent', {
      touchPoints: [{ x: from + (by * step) / 12, y }],
      type: 'touchMove',
    });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(150);
  await cdp.send('Input.dispatchTouchEvent', { touchPoints: [], type: 'touchEnd' });
  await cdp.detach();
}

/** A press on a control that does not focus it, as Safari's click on a button does not. */
async function clickWithoutFocus(page: Page, name: string) {
  const button = page.getByRole('button', { name });
  await button.evaluate((element) => {
    element.addEventListener('mousedown', (event) => event.preventDefault(), { once: true });
  });
  await button.click();
}

test.describe('phone deck', () => {
  test('a swipe follows the finger and turns one card, which settles at the gutter', async ({
    page,
  }) => {
    await openDeck(page);
    expect(await left(page, '1 of 10')).toBe(GUTTER);
    await swipe(page, { by: -200, from: 300 });
    await expect(group(page, '2 of 10')).toBeVisible();
    await expect.poll(() => left(page, '2 of 10')).toBe(GUTTER);
    // A long drag still turns one card.
    await drag(page, { by: -330, from: 360 });
    await expect(group(page, '3 of 10')).toBeVisible();
    await expect.poll(() => left(page, '3 of 10')).toBe(GUTTER);
    // A drag short of half a card falls back to the card it started on.
    await drag(page, { by: -100, from: 300 });
    await expect.poll(() => left(page, '3 of 10')).toBe(GUTTER);
  });

  test('a drag past either end moves nothing, so nothing springs back', async ({ page }) => {
    await openDeck(page);
    const box = await group(page, '1 of 10').boundingBox();
    const y = (box?.y ?? 0) + 40;
    await page.mouse.move(100, y);
    await page.mouse.down();
    await page.mouse.move(260, y, { steps: 10 });
    expect(await left(page, '1 of 10')).toBe(GUTTER);
    await page.mouse.up();
    expect(await leftNextFrame(page, '1 of 10')).toBe(GUTTER);
  });

  test('a refetch during a swipe applies once the swipe settles', async ({ page }) => {
    await openDeck(page);
    const box = await group(page, '1 of 10').boundingBox();
    const y = (box?.y ?? 0) + 40;
    await page.mouse.move(300, y);
    await page.mouse.down();
    await page.mouse.move(100, y, { steps: 10 });
    // The refetch drops card 2, the card the swipe is turning to.
    await page.getByRole('button', { name: 'Card 2 leaves' }).evaluate((button) => {
      if (button instanceof HTMLElement) {
        button.click();
      }
    });
    await expect(page.locator('[data-slot="deck-pager"] p')).toHaveText('1 of 10');
    await page.mouse.up();
    await expect(group(page, '2 of 9')).toContainText('Release channels');
    await expect.poll(() => left(page, '2 of 9')).toBe(GUTTER);
  });

  test('the deck runs from the page’s gutter to the screen’s right edge, whatever the gutter', async ({
    page,
  }) => {
    await openDeck(page);
    // DESIGN.md: 330 at 390, the width less 14, the 8 gap, and the 38 peek.
    expect((await group(page, '1 of 10').boundingBox())?.width).toBe(330);
    const viewport = page.locator('[data-slot="swipe-viewport"]');
    const edge = async () => {
      const box = await viewport.boundingBox();
      return (box?.x ?? 0) + (box?.width ?? 0);
    };
    expect(await edge()).toBe(PHONE.width);

    await page.goto(`${harness.origin}?form=deck&gutter=wide`);
    await expect(group(page, '1 of 10')).toBeVisible();
    expect(await left(page, '1 of 10')).toBe(20);
    expect((await group(page, '1 of 10').boundingBox())?.width).toBe(PHONE.width - 20 - 46);
    expect(await edge()).toBe(PHONE.width);
  });

  test('the last card rests at the gutter with nothing peeking beside it', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto(`${harness.origin}?form=deck&cards=3`);
    const next = page.getByRole('button', { name: 'Next card' });
    await next.click();
    await next.click();
    await expect(group(page, '3 of 3')).toBeVisible();
    await expect.poll(() => left(page, '3 of 3')).toBe(GUTTER);
    await expect(page.locator('[data-slot="swipe-peek"]')).toHaveCount(0);
    await expect(next).toHaveAttribute('aria-disabled', 'true');
  });

  test('a tap on the peek turns the deck and never presses the peeking card', async ({ page }) => {
    await openDeck(page);
    // Aim at the peeking card's own button, Clear stop on MMR-d9, under the peek's tap target.
    const button = page.locator('[data-deck-card="MMR-d9"] [data-slot="feed-card-action"] > *');
    const box = await button.boundingBox();
    expect(box?.x).toBeGreaterThan(PHONE.width - 46);
    await page.touchscreen.tap(PHONE.width - 20, (box?.y ?? 0) + (box?.height ?? 0) / 2);
    await expect(group(page, '2 of 10')).toBeVisible();
    await expect.poll(() => left(page, '2 of 10')).toBe(GUTTER);
    await expect(page.getByRole('button', { name: /Land MMR-d9/u })).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('focus held in a card moves into the incoming card on every kind of turn', async ({
    page,
  }) => {
    await openDeck(page);
    await group(page, '1 of 10').locator('[data-slot="feed-card-target"]').focus();
    await swipe(page, { by: -200, from: 300 });
    await expect.poll(() => focusedCard(page)).toBe('2 of 10');
    const shown = await group(page, '2 of 10').boundingBox();
    await page.touchscreen.tap(PHONE.width - 20, (shown?.y ?? 0) + 40);
    await expect.poll(() => focusedCard(page)).toBe('3 of 10');
    await clickWithoutFocus(page, 'Next card');
    await expect.poll(() => focusedCard(page)).toBe('4 of 10');
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => focusedCard(page)).toBe('5 of 10');
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => focusedCard(page)).toBe('4 of 10');
  });

  test('a turn slides to rest, and at once under reduced motion', async ({ page }) => {
    await openDeck(page);
    await page.getByRole('button', { name: 'Next card' }).click();
    expect(await leftNextFrame(page, '2 of 10')).toBeGreaterThan(GUTTER);
    await expect.poll(() => left(page, '2 of 10')).toBe(GUTTER);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: 'Next card' }).click();
    expect(await leftNextFrame(page, '3 of 10')).toBe(GUTTER);
    // A swipe tracks the finger, then settles at once.
    await drag(page, { by: -220, from: 300 });
    expect(await leftNextFrame(page, '4 of 10')).toBe(GUTTER);
  });
});

test.describe('desktop deck', () => {
  test('a turn from a focused card or a press that does not focus the arrow moves focus to the new page’s first card', async ({
    page,
  }) => {
    await openDeck(page, DESKTOP);
    await group(page, '2 of 10').locator('[data-slot="feed-card-target"]').focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => focusedCard(page)).toBe('5 of 10');
    await clickWithoutFocus(page, 'Next page');
    await expect.poll(() => focusedCard(page)).toBe('9 of 10');
  });

  test('the head keeps 12 between the arrows and See all’s text', async ({ page }) => {
    await openDeck(page, DESKTOP);
    const gap = await page.evaluate(() => {
      const next = document.querySelector('[aria-label="Next page"]');
      const link = document.querySelector('[data-slot="section-see-all"]');
      if (next === null || link === null) {
        return null;
      }
      const text = link.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(link).paddingLeft);
      return Math.round(text - next.getBoundingClientRect().right);
    });
    expect(gap).toBe(12);
  });

  test('crossing 768 keeps the current card, and focus on it', async ({ page }) => {
    await openDeck(page, DESKTOP);
    await page.getByRole('button', { name: 'Next page' }).click();
    await group(page, '5 of 10').locator('[data-slot="feed-card-target"]').focus();
    await page.setViewportSize(PHONE);
    await expect(group(page, '5 of 10')).toBeVisible();
    await expect.poll(() => left(page, '5 of 10')).toBe(GUTTER);
    await expect.poll(() => focusedCard(page)).toBe('5 of 10');
    await page.setViewportSize(DESKTOP);
    await expect(page.getByText('of 10', { exact: false }).first()).toHaveText('5–8 of 10');
    await expect.poll(() => focusedCard(page)).toBe('5 of 10');
  });
});

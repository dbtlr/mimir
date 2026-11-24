import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { serveHarness } from './form-sheet/serve';
import type { Harness } from './form-sheet/serve';

/*
 * The Needs you page over a seeded review read in Chromium (ADR 0019, MMR-723
 * refinement; DESIGN.md, Needs you page): its cards and the bar render in the
 * shell's frame, the bar's button meets a phone's 44 tap height, and the bar
 * sits under the page's scroller, above the version footer strip, so no card
 * scrolls beneath it.
 */

let harness: Harness;

test.beforeAll(async () => {
  harness = await serveHarness();
});

test.afterAll(async () => {
  await harness.close();
});

const PHONE = { height: 844, width: 390 };
const DESKTOP = { height: 900, width: 1280 };

async function openPage(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.goto(`${harness.origin}?form=needs-you-page`);
  await expect(page.getByRole('heading', { level: 1, name: 'Needs you' })).toBeVisible();
}

const bar = (page: Page) => page.getByRole('link', { name: /^Work through/u });

test('shows the cards by project and the bar over the seeded read', async ({ page }) => {
  await openPage(page, DESKTOP);
  await expect(page.getByText('7 cards, 8 items in 3 projects.')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2 })).toHaveText([
    'Fleet 2 cards, 3 items',
    'Mimir 3 cards, 3 items',
    'Loom CLI 2 cards, 2 items',
  ]);
  await expect(bar(page)).toHaveText('Work through all 8');
  await expect(
    page.getByText('One item at a time, in queue order across projects, then back here.'),
  ).toBeVisible();
});

test('gives the bar’s button a phone’s 44 tap height, full width, with no note', async ({
  page,
}) => {
  await openPage(page, PHONE);
  const box = await bar(page).boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  // The phone's 14 gutters on either side.
  expect(box?.width).toBe(PHONE.width - 28);
  await expect(
    page.getByText('One item at a time, in queue order across projects, then back here.'),
  ).toBeHidden();
});

test('puts the bar under the scroller and above the footer strip, with the overflow cue while more lies below', async ({
  page,
}) => {
  await openPage(page, PHONE);
  const main = page.getByRole('main');
  const barRow = page.locator('[data-slot="work-through-bar"]');
  const footer = page.getByRole('contentinfo');
  const [mainBox, barBox, footerBox] = await Promise.all([
    main.boundingBox(),
    barRow.boundingBox(),
    footer.boundingBox(),
  ]);
  if (mainBox === null || barBox === null || footerBox === null) {
    throw new Error('the page did not lay out');
  }
  // The scroller ends at the bar's top edge, and the footer strip lies under the bar.
  expect(Math.round(mainBox.y + mainBox.height)).toBe(Math.round(barBox.y));
  expect(Math.round(barBox.y + barBox.height)).toBe(Math.round(footerBox.y));
  await expect(barRow).toHaveAttribute('data-continues', '');

  await main.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(barRow).not.toHaveAttribute('data-continues');
});

test('shows the overflow cue when the read lands after the page mounts, as on a cold load', async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  // Until the read lands the page is pending, never unreachable: note it if the host's absence ever shows.
  await page.addInitScript(() => {
    new MutationObserver(() => {
      if (document.body.textContent.includes('Unreachable')) {
        document.documentElement.dataset.sawUnreachable = '';
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto(`${harness.origin}?form=needs-you-page&late`);
  // The page mounts pending (the main region with no title yet); only then does the read land.
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Needs you' })).toHaveCount(0);
  await page.evaluate(() => {
    globalThis.dispatchEvent(new Event('needs-you-release'));
  });
  await expect(page.getByRole('heading', { level: 1, name: 'Needs you' })).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-saw-unreachable');
  const main = page.getByRole('main');
  await expect
    .poll(async () => main.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  await expect(page.locator('[data-slot="work-through-bar"]')).toHaveAttribute(
    'data-continues',
    '',
  );
});

/** The card a list card's identity names. */
const card = (page: Page, key: string) => page.locator(`[data-list-card="${key}"]`);
const targetOf = (page: Page, key: string) =>
  card(page, key).locator('[data-slot="feed-card-target"]');
const buttonOf = (page: Page, key: string) =>
  card(page, key).locator('[data-slot="feed-card-action"] > *').first();

/** Replaces the review read with the rows in a new queue order, as a refetch would. */
async function refetchInOrder(page: Page, ids: readonly string[]) {
  await page.evaluate((order) => {
    globalThis.dispatchEvent(new CustomEvent('needs-you-reorder', { detail: order }));
  }, ids);
}

test.describe('a refetch that reorders the cards', () => {
  // MMR-688 now ranks ahead of MMR-731, so React moves MMR-731's node after it.
  const WITHIN_SECTION = [
    'FLT-d2',
    'MMR-688',
    'FLT-q1',
    'FLT-q2',
    'MMR-731',
    'LM-640',
    'MMR-q41',
    'LM-571',
  ];
  // Loom CLI's first card now ranks first, so its section moves ahead of Fleet's and Mimir's.
  const SECTION_AHEAD = [
    'LM-640',
    'FLT-d2',
    'MMR-731',
    'FLT-q1',
    'FLT-q2',
    'MMR-688',
    'MMR-q41',
    'LM-571',
  ];

  test('keeps focus on a card’s target its card moved within its section', async ({ page }) => {
    await openPage(page, DESKTOP);
    await targetOf(page, 'MMR-731').focus();
    await refetchInOrder(page, WITHIN_SECTION);
    await expect(card(page, 'MMR-731')).toHaveAttribute('data-list-card', 'MMR-731');
    await expect(page.locator('[data-list-card]').nth(2)).toHaveAttribute(
      'data-list-card',
      'MMR-688',
    );
    await expect(targetOf(page, 'MMR-731')).toBeFocused();
  });

  test('keeps focus on a card’s button its card moved within its section', async ({ page }) => {
    await openPage(page, DESKTOP);
    await buttonOf(page, 'MMR-731').focus();
    await refetchInOrder(page, WITHIN_SECTION);
    await expect(page.locator('[data-list-card]').nth(2)).toHaveAttribute(
      'data-list-card',
      'MMR-688',
    );
    await expect(buttonOf(page, 'MMR-731')).toBeFocused();
  });

  test('keeps focus on a card’s target its section moved behind another', async ({ page }) => {
    await openPage(page, DESKTOP);
    await targetOf(page, 'FLT-d2').focus();
    await refetchInOrder(page, SECTION_AHEAD);
    await expect(page.getByRole('heading', { level: 2 }).first()).toHaveText(/^Loom CLI/u);
    await expect(targetOf(page, 'FLT-d2')).toBeFocused();
  });

  test('keeps focus on a card’s button its section moved behind another', async ({ page }) => {
    await openPage(page, DESKTOP);
    await buttonOf(page, 'FLT-d2').focus();
    await refetchInOrder(page, SECTION_AHEAD);
    await expect(page.getByRole('heading', { level: 2 }).first()).toHaveText(/^Loom CLI/u);
    await expect(buttonOf(page, 'FLT-d2')).toBeFocused();
  });

  // The moved card leaves on the next refetch: focus goes on to its successor, so the list still owned it.
  const WITHOUT_MMR_731 = WITHIN_SECTION.filter((id) => id !== 'MMR-731');
  const WITHOUT_FLEET = SECTION_AHEAD.filter((id) => !id.startsWith('FLT-'));

  test('still moves focus on from a card’s target it moved, once that card leaves', async ({
    page,
  }) => {
    await openPage(page, DESKTOP);
    await targetOf(page, 'MMR-731').focus();
    await refetchInOrder(page, WITHIN_SECTION);
    await expect(page.locator('[data-list-card]').nth(2)).toHaveAttribute(
      'data-list-card',
      'MMR-688',
    );
    await expect(targetOf(page, 'MMR-731')).toBeFocused();
    await refetchInOrder(page, WITHOUT_MMR_731);
    await expect(card(page, 'MMR-731')).toHaveCount(0);
    await expect(targetOf(page, 'project:MMR')).toBeFocused();
  });

  test('still moves focus on from a card’s button it moved, once that card leaves', async ({
    page,
  }) => {
    await openPage(page, DESKTOP);
    await buttonOf(page, 'MMR-731').focus();
    await refetchInOrder(page, WITHIN_SECTION);
    await expect(page.locator('[data-list-card]').nth(2)).toHaveAttribute(
      'data-list-card',
      'MMR-688',
    );
    await expect(buttonOf(page, 'MMR-731')).toBeFocused();
    await refetchInOrder(page, WITHOUT_MMR_731);
    await expect(card(page, 'MMR-731')).toHaveCount(0);
    await expect(targetOf(page, 'project:MMR')).toBeFocused();
  });

  test('still moves focus on from a card its section moved, once that section leaves', async ({
    page,
  }) => {
    await openPage(page, DESKTOP);
    await targetOf(page, 'FLT-d2').focus();
    await refetchInOrder(page, SECTION_AHEAD);
    await expect(page.getByRole('heading', { level: 2 }).first()).toHaveText(/^Loom CLI/u);
    await expect(targetOf(page, 'FLT-d2')).toBeFocused();
    await refetchInOrder(page, WITHOUT_FLEET);
    await expect(page.getByRole('heading', { level: 2 })).toHaveCount(2);
    await expect(page.locator(':focus')).toHaveAttribute('data-slot', 'feed-card-target');
  });

  test('leaves focus that already left the list where it went', async ({ page }) => {
    await openPage(page, DESKTOP);
    await targetOf(page, 'MMR-731').focus();
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    await refetchInOrder(page, WITHIN_SECTION);
    await expect(page.locator('[data-list-card]').nth(2)).toHaveAttribute(
      'data-list-card',
      'MMR-688',
    );
    await expect(page.locator('body')).toBeFocused();
  });
});

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

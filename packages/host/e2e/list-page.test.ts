import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { serveHarness } from './form-sheet/serve';
import type { Harness } from './form-sheet/serve';

/*
 * The list page's group headings in Chromium (ADR 0019, MMR-724 refinement;
 * DESIGN.md, List page): over a seeded in-flight Tasks list, a group's heading
 * pins to the top of the page's scroller while its group scrolls under it,
 * with its hairline only while pinned, and the next group's heading takes its
 * place, at a phone's width and a desktop's.
 */

let harness: Harness;

test.beforeAll(async () => {
  harness = await serveHarness();
});

test.afterAll(async () => {
  await harness.close();
});

const PHONE = { height: 844, width: 390 };
const DESKTOP = { height: 800, width: 1280 };

async function openList(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.goto(`${harness.origin}?form=tasks-page`);
  await expect(page.getByText('18 tasks in flight')).toBeVisible();
}

/** The band that holds a group's heading, by the heading's name. */
const band = (page: Page, name: string) =>
  page.getByRole('heading', { level: 2, name }).locator('xpath=..');

/** Scrolls the page's scroller so `name`'s group starts `past` px above its top. */
async function scrollIntoGroup(page: Page, name: string, past: number) {
  await page.getByRole('main').evaluate(
    (main, [heading, offset]) => {
      const section = [...main.querySelectorAll('section')].find(
        (each) => each.querySelector('h2')?.textContent === heading,
      );
      if (section === undefined) {
        throw new Error(`no group ${heading}`);
      }
      const top =
        section.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
      main.scrollTop = top + offset;
    },
    [name, past] as const,
  );
}

/** Scrolls through the first two groups at `viewport`, checking which heading is pinned. */
async function checkPinning(page: Page, viewport: { width: number; height: number }) {
  await openList(page, viewport);
  const main = page.getByRole('main');
  const inProgress = band(page, 'In progress 6');
  const underReview = band(page, 'Under review 6');

  // At rest the heading sits in the page's flow, with no hairline.
  await expect(inProgress).not.toHaveAttribute('data-pinned');
  expect(await inProgress.evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none');

  await scrollIntoGroup(page, 'In progress 6', 200);
  await expect(inProgress).toHaveAttribute('data-pinned', '');
  const [mainBox, pinnedBox] = await Promise.all([main.boundingBox(), inProgress.boundingBox()]);
  expect(Math.round(pinnedBox?.y ?? -1)).toBe(Math.round(mainBox?.y ?? -2));
  expect(await inProgress.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');
  // The band is opaque, so a card passing under it never shows through.
  expect(await inProgress.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
    'rgba(0, 0, 0, 0)',
  );
  await expect(underReview).not.toHaveAttribute('data-pinned');

  // The next group's heading takes the place.
  await scrollIntoGroup(page, 'Under review 6', 120);
  await expect(underReview).toHaveAttribute('data-pinned', '');
  const nextBox = await underReview.boundingBox();
  expect(Math.round(nextBox?.y ?? -1)).toBe(Math.round(mainBox?.y ?? -2));

  // Back at the top, nothing is pinned.
  await main.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(inProgress).not.toHaveAttribute('data-pinned');
  await expect(underReview).not.toHaveAttribute('data-pinned');
}

test('pins a group’s heading with its hairline while the group scrolls, on a phone', async ({
  page,
}) => {
  await checkPinning(page, PHONE);
});

test('pins a group’s heading with its hairline while the group scrolls, on a desktop', async ({
  page,
}) => {
  await checkPinning(page, DESKTOP);
});

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { serveHarness } from './form-sheet/serve';
import type { Harness } from './form-sheet/serve';

/*
 * The list page's group headings in Chromium (ADR 0019, MMR-724 refinement;
 * DESIGN.md, List page): over a seeded in-flight Tasks list, a group's heading
 * pins to the top of the page's scroller while its group scrolls under it,
 * with its hairline only while pinned, and the next group's heading takes its
 * place, at a phone's width and a desktop's. The page's rhythm (the chip row
 * 8 below the search and 32 above the first head's row, the room under the
 * last card), and the phone Filter sheet's grip, seam, and first view, which
 * ends a field gap after Tag at 390 × 844.
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

/** An element's box, rounded to whole px, for the spacing checks. */
const boxOf = async (locator: ReturnType<Page['locator']>) => {
  const box = await locator.boundingBox();
  if (box === null) {
    throw new Error('no box');
  }
  return { bottom: Math.round(box.y + box.height), top: Math.round(box.y) };
};

for (const [width, viewport] of [
  ['phone', PHONE],
  ['desktop', DESKTOP],
] as const) {
  test(`the chip row sits 8 below the search and 32 above the first head’s row, on a ${width}`, async ({
    page,
  }) => {
    await openList(page, viewport);
    // The field's 44 box, not the text input inside it.
    const search = await boxOf(
      page.getByRole('searchbox', { name: 'Search tasks' }).locator('xpath=ancestor::label[1]'),
    );
    // The pill the chip draws, not its tap area.
    const pill = await boxOf(page.getByRole('button', { name: 'Remove In flight' }).locator('span').first());
    const head = await boxOf(page.getByRole('heading', { level: 2, name: 'In progress 6' }));
    expect(pill.top - search.bottom).toBe(8);
    expect(head.top - pill.bottom).toBe(32);
  });
}

test('the last card sits 40 above the end of the page on a phone and 48 on a desktop', async ({
  page,
}) => {
  for (const [viewport, room] of [
    [PHONE, 40],
    [DESKTOP, 48],
  ] as const) {
    await openList(page, viewport);
    const main = page.getByRole('main');
    const gap = await main.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      const cards = el.querySelectorAll('[data-slot="feed-card"]');
      const last = cards[cards.length - 1];
      return el.getBoundingClientRect().bottom - (last?.getBoundingClientRect().bottom ?? 0);
    });
    expect(Math.round(gap)).toBe(room);
  }
});

test('the phone Filter sheet shows its grip and seam, and its first view ends a field gap after Tag', async ({
  page,
}) => {
  await openList(page, PHONE);
  await page.getByRole('button', { name: /^Filter/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Filter tasks' });
  await expect(sheet.getByRole('button', { name: 'Show 18 tasks' })).toBeVisible();

  // The grip shows inside the sheet, above the title.
  const grip = sheet.locator('[data-slot="drawer-grip"]');
  await expect(grip).toBeVisible();
  const [gripBox, sheetBox, titleBox] = await Promise.all([
    boxOf(grip),
    boxOf(sheet),
    boxOf(sheet.getByRole('heading', { name: 'Filter tasks' })),
  ]);
  expect(gripBox.top).toBeGreaterThan(sheetBox.top);
  expect(gripBox.bottom).toBeLessThan(titleBox.top);

  // The top edge is the sheet seam, which clears 3:1 against the scrim.
  const [edge, seam] = await sheet.evaluate((el) => {
    const probe = el.ownerDocument.createElement('span');
    probe.style.color = 'var(--color-sheet-seam)';
    el.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return [getComputedStyle(el).borderTopColor, color];
  });
  expect(edge).toBe(seam);

  // The first view ends a field gap below Tag, with Sort wholly below it.
  await page.waitForTimeout(300);
  const body = await boxOf(sheet.locator('[data-slot="filter-sheet-body"]'));
  const tag = await boxOf(sheet.getByRole('group', { name: 'Tag' }));
  const sort = await boxOf(sheet.getByRole('radiogroup', { name: 'Sort' }).locator('xpath=..'));
  expect(body.bottom - tag.bottom).toBeGreaterThanOrEqual(24);
  // Each box rounds to whole px on its own, so allow the one px that can part them.
  expect(sort.top).toBeGreaterThanOrEqual(body.bottom - 1);
});

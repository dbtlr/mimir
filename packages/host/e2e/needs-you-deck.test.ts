import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { serveHarness } from './form-sheet/serve';
import type { Harness } from './form-sheet/serve';

/*
 * The Needs you deck over its fixture review report in Chromium (ADR 0019,
 * MMR-721 refinement: A walkthrough's return; Previews, writes, and the answer
 * dialog): the return to a bundle the deck must turn to, across a real page
 * change, and where focus lands after an answer and after the last Clear
 * stop. The /kit demo's writes take 600 ms and then drop their card, as the
 * refetch after a write would.
 */

let harness: Harness;

test.beforeAll(async () => {
  harness = await serveHarness();
});

test.afterAll(async () => {
  await harness.close();
});

const PHONE = { height: 844, width: 390 };
const DESKTOP = { height: 900, width: 1024 };

async function openDeck(
  page: Page,
  viewport: { width: number; height: number },
  only?: string,
  query = '',
) {
  await page.setViewportSize(viewport);
  await page.goto(
    `${harness.origin}?form=needs-you-deck${only === undefined ? '' : `&only=${only}`}${query}`,
  );
  await expect(page.getByRole('heading', { name: /Needs you/u })).toBeVisible();
}

/** The accessible name of the focused element, or its tag when it has none. */
function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    return (
      active?.getAttribute('aria-label') ?? active?.textContent?.trim() ?? active?.tagName ?? 'none'
    );
  });
}

test.describe('a walkthrough’s return', () => {
  test('turns the desktop deck to the bundle’s page and focuses its button', async ({ page }) => {
    await openDeck(page, DESKTOP);
    await page.getByRole('button', { name: 'Next page' }).click();
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.getByText('9–11', { exact: true })).toBeVisible();
    await page
      .getByRole('button', { name: 'Review 3 decisions without a delivery in MMR' })
      .click();
    await expect(page.getByRole('heading', { name: 'Decisions walkthrough' })).toBeVisible();

    await page.getByRole('button', { name: 'Close the walkthrough' }).click();
    const review = page.getByRole('button', {
      name: 'Review 3 decisions without a delivery in MMR',
    });
    await expect(review).toBeFocused();
    await expect(review).toBeInViewport();
    await expect(page.getByText('9–11', { exact: true })).toBeVisible();
  });

  test('turns the phone deck to the bundle and focuses its button', async ({ page }) => {
    await openDeck(page, PHONE);
    const next = page.getByRole('button', { name: 'Next card' });
    for (let turn = 0; turn < 4; turn += 1) {
      await next.click();
    }
    await expect(page.getByRole('group', { name: '5 of 11' })).toBeVisible();
    await page.getByRole('button', { name: 'Review 3 decisions on FLT-d2' }).click();
    await page.getByRole('button', { name: 'Close the walkthrough' }).click();

    const review = page.getByRole('button', { name: 'Review 3 decisions on FLT-d2' });
    await expect(review).toBeFocused();
    await expect(page.getByRole('group', { name: '5 of 11' })).toBeVisible();
    await expect(review).toBeInViewport({ ratio: 1 });
  });
});

test.describe('focus after a write', () => {
  test('an answer that takes its card out of the set moves focus to the next card', async ({
    page,
  }) => {
    await openDeck(page, PHONE);
    const next = page.getByRole('button', { name: 'Next card' });
    for (let turn = 0; turn < 7; turn += 1) {
      await next.click();
    }
    await page.getByRole('button', { name: 'Answer MMR-731' }).click();
    const dialog = page.getByRole('dialog', { name: 'Answer' });
    await dialog.getByRole('textbox').fill('Summed for the whole delivery.');
    await dialog.getByRole('button', { name: 'Answer' }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole('group', { name: '8 of 10' })).toBeVisible();
    await expect.poll(() => focused(page)).toBe('Keep run logs and make them readable');
  });

  test('Clear stop on the last card, from its preview, moves focus to the quiet line', async ({
    page,
  }) => {
    await openDeck(page, PHONE, 'FLT-d2');
    await page.getByRole('button', { name: 'Rolling host upgrades' }).click();
    const sheet = page.getByRole('dialog', { name: 'Rolling host upgrades' });
    const clear = sheet.getByRole('button', { name: 'Clear stop on FLT-d2' });
    await clear.click();
    // The preview stays open while its write is in flight, and the write holds its button.
    await expect(clear).toHaveAttribute('aria-disabled', 'true');
    await expect(clear).toBeFocused();

    const quiet = page.getByText('Nothing needs you.');
    await expect(quiet).toBeFocused();
    await expect(sheet).toBeHidden();
  });
});

test.describe('a bundle’s preview', () => {
  test('lists its tasks as relations: one a line, 4 apart, each ID in the label’s ink-dim', async ({
    page,
  }) => {
    await openDeck(page, DESKTOP, 'FLT-q1,FLT-q2');
    await page.getByRole('button', { name: 'Rolling host upgrades' }).click();
    const panel = page.getByRole('dialog', { name: 'Rolling host upgrades' });
    await expect(panel.getByText('FLT-91', { exact: true })).toBeVisible();
    // Read in one frame, since the panel may still be sliding in.
    const tasks = await panel.getByText('Tasks', { exact: true }).evaluate((label) => {
      const lines = [...(label.nextElementSibling?.children ?? [])].map((line) => {
        const rect = line.getBoundingClientRect();
        const id = getComputedStyle(line.firstElementChild ?? line);
        return {
          bottom: rect.bottom,
          color: id.color,
          family: id.fontFamily,
          left: rect.left,
          text: line.textContent,
          top: rect.top,
        };
      });
      return { color: getComputedStyle(label).color, lines };
    });
    expect(tasks.lines.map((line) => line.text)).toEqual(['FLT-88', 'FLT-89', 'FLT-90', 'FLT-91']);
    for (const [at, line] of tasks.lines.entries()) {
      expect(line.color).toBe(tasks.color);
      expect(line.family).toMatch(/mono/iu);
      const before = tasks.lines[at - 1];
      if (before !== undefined) {
        expect(line.left).toBe(before.left);
        expect(Math.round(line.top - before.bottom)).toBe(4);
      }
    }
  });
});

/** A deck card's target, by the card's identity. */
const targetOf = (page: Page, key: string) =>
  page.locator(`[data-deck-card="${key}"] [data-slot="feed-card-target"]`);

/** Replaces the refetch deck's report with the rows in a new queue order, as a refetch would. */
async function refetchInOrder(page: Page, ids: readonly string[]) {
  await page.evaluate((order) => {
    globalThis.dispatchEvent(new CustomEvent('needs-you-reorder', { detail: order }));
  }, ids);
}

test.describe('a refetch that reorders the cards', () => {
  test('still moves focus on from a card it moved, once that card leaves', async ({ page }) => {
    await openDeck(page, DESKTOP, undefined, '&refetch');
    await targetOf(page, 'MMR-1').focus();
    // MMR-2 now ranks first, so React moves MMR-1's node after it.
    await refetchInOrder(page, ['MMR-2', 'MMR-1', 'MMR-3']);
    await expect(page.locator('[data-deck-card]').first()).toHaveAttribute(
      'data-deck-card',
      'MMR-2',
    );
    await expect(targetOf(page, 'MMR-1')).toBeFocused();
    await refetchInOrder(page, ['MMR-2', 'MMR-3']);
    await expect(page.locator('[data-deck-card="MMR-1"]')).toHaveCount(0);
    await expect(targetOf(page, 'MMR-3')).toBeFocused();
  });
});

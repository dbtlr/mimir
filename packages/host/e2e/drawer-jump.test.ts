import { expect, test } from '@playwright/test';

import { serveHarness } from './form-sheet/serve';
import type { Harness } from './form-sheet/serve';

/*
 * The drawer's Jump to in Chromium (ADR 0013, MMR-729 refinement): choosing
 * it closes the drawer and opens the palette once the close has finished. A
 * drawer reopened during that close drops the jump, so a later close opens
 * nothing. jsdom finishes the close at once, so only a real browser can
 * reopen inside it.
 */

let harness: Harness;

test.beforeAll(async () => {
  harness = await serveHarness();
});

test.afterAll(async () => {
  await harness.close();
});

const PALETTE = 'Jump to a record or action';

test('a drawer reopened during its close drops the Jump to it was closing for', async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(`${harness.origin}?form=touch-targets&context=project`);
  const menu = page.getByRole('button', { name: 'Open project menu' });
  await menu.click();
  const drawer = page.getByRole('dialog', { name: 'Project' });
  await drawer.getByRole('button', { name: 'Jump to…' }).click();
  // The closing drawer still covers the menu button, so reopen it as a keyboard or script would.
  await menu.evaluate((button) => {
    (button as HTMLButtonElement).click();
  });
  await expect(drawer).toBeVisible();
  await expect(page.getByRole('combobox', { name: PALETTE })).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  // Past the drawer's 200ms slide, when a pending jump would have fired.
  await page.waitForTimeout(500);
  await expect(page.getByRole('combobox', { name: PALETTE })).toHaveCount(0);
});

test('choosing Jump to closes the drawer and opens the palette once', async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto(`${harness.origin}?form=touch-targets&context=project`);
  await page.getByRole('button', { name: 'Open project menu' }).click();
  await page
    .getByRole('dialog', { name: 'Project' })
    .getByRole('button', { name: 'Jump to…' })
    .click();
  const input = page.getByRole('combobox', { name: PALETTE });
  await expect(input).toBeFocused();
  await expect(page.getByRole('dialog', { name: 'Project' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open project menu' })).toBeFocused();
});

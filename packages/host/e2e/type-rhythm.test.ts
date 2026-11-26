import { expect, test } from '@playwright/test';

import { serveHarness } from './form-sheet/serve';
import type { Harness } from './form-sheet/serve';

/*
 * The line heights the type tokens draw in Chromium (DESIGN.md, Type):
 * `text-body` is 14 / 23 for prose wherever it is used, and a label is not
 * prose, so it takes `text-label`'s 14 / 20 (MMR-749). jsdom computes no
 * Tailwind, so only a browser can tell a paired line height from the default.
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

test('body copy draws a 23px line with no line height of its own', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto(`${harness.origin}?form=type-rhythm`);
  await expect(page.locator('[data-probe=body]')).toHaveCSS('line-height', '23px');
  await expect(page.getByText('Nothing needs you.')).toHaveCSS('line-height', '23px');
});

test("a default ActionButton's label draws the label's 20px line", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto(`${harness.origin}?form=type-rhythm`);
  await expect(page.getByRole('button', { name: 'Resolve' })).toHaveCSS('line-height', '20px');
});

test("the project picker's name and the phone alert's count draw the label's 20px line", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await page.goto(`${harness.origin}?form=touch-targets`);
  const alert = page.getByRole('link', { exact: true, name: '1 needs you' });
  await expect(alert).toHaveCSS('line-height', '20px');

  await page.setViewportSize(DESKTOP);
  const sidebar = page.getByRole('complementary');
  await expect(sidebar.getByText('Mimir', { exact: true }).first()).toHaveCSS(
    'line-height',
    '20px',
  );
});

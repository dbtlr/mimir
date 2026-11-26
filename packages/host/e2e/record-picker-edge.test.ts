import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { serveHarness } from './form-sheet/serve';
import type { Harness } from './form-sheet/serve';

/*
 * The Record picker's invalid edge in Chromium (DESIGN.md, Controls): when a
 * task's move fails, the edit sheet's Parent trigger takes the `status-blocked`
 * edge, on a phone as on a desktop, in both themes, and keeps it under the
 * pointer. The harness's host refuses every write, so the move fails.
 */

let harness: Harness;

test.beforeAll(async () => {
  harness = await serveHarness();
});

test.afterAll(async () => {
  await harness.close();
});

/** Longer than a sheet's slide and a control's color transition. */
const SETTLE = 600;

/** Resolve the theme's blocked edge through Chromium's computed color serialization. */
function blockedColor(page: Page) {
  return page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--color-status-blocked)';
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
}

const VIEWS = [
  { hasTouch: true, isMobile: true, name: 'a phone', viewport: { height: 844, width: 390 } },
  { hasTouch: false, isMobile: false, name: 'a 390 window', viewport: { height: 844, width: 390 } },
  { hasTouch: false, isMobile: false, name: 'a desktop', viewport: { height: 900, width: 1280 } },
];

// oxlint-disable-next-line vitest/prefer-each -- Playwright has no `each`; this is its pattern
for (const theme of ['dark', 'light']) {
  // oxlint-disable-next-line vitest/prefer-each -- Playwright has no `each`; this is its pattern
  for (const { name, ...view } of VIEWS) {
    test(`a failed move gives Parent the blocked edge on ${name}, ${theme}, hovered or not`, async ({
      browser,
    }) => {
      const context = await browser.newContext(view);
      const page = await context.newPage();
      await page.goto(`${harness.origin}?form=task-edit&theme=${theme}`);
      const sheet = page.getByRole('dialog', { name: 'Edit task' });
      await sheet.waitFor();
      await page.waitForTimeout(SETTLE);
      const parent = sheet.getByRole('button', { name: /^Parent/ });
      await parent.click();
      await page.getByRole('option', { name: /Console/ }).click();
      await sheet.getByRole('button', { name: 'Save' }).click();
      await expect(parent).toHaveAttribute('aria-invalid', 'true');
      const blocked = await blockedColor(page);

      await page.mouse.move(0, 0);
      await page.waitForTimeout(SETTLE);
      await expect(parent).toHaveCSS('border-top-color', blocked);
      await parent.hover();
      await page.waitForTimeout(SETTLE);
      await expect(parent).toHaveCSS('border-top-color', blocked);
      await context.close();
    });
  }
}

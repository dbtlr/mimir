import { expect, test } from '@playwright/test';

import { serveHarness } from './form-sheet/serve';
import type { Harness } from './form-sheet/serve';

/*
 * The Walkthrough in real layout (ADR 0019, MMR-703 and MMR-736 refinements):
 * a Dialog that covers the whole console at every width, with the page
 * beneath inert, and answers on UI SDK Radio whose arrow keys move the
 * selection. jsdom lays nothing out and has no top layer, so this runs the
 * pattern in Chromium, served from `e2e/form-sheet`.
 */

let harness: Harness;

test.beforeAll(async () => {
  harness = await serveHarness();
});

test.afterAll(async () => {
  await harness.close();
});

const VIEWPORTS = [
  { height: 844, name: 'phone', width: 390 },
  { height: 800, name: 'desktop', width: 1280 },
];

for (const viewport of VIEWPORTS) {
  test.describe(`at ${String(viewport.width)}x${String(viewport.height)}`, () => {
    test.use({ viewport: { height: viewport.height, width: viewport.width } });

    test('covers the whole console, and the page beneath takes no input', async ({ page }) => {
      await page.goto(`${harness.origin}?form=walkthrough`);
      const layer = page.getByRole('dialog', { name: 'Deliver the console' });
      await expect(layer).toBeVisible();
      // Once its 150ms entry settles, the layer is the viewport, edge to edge.
      await expect
        .poll(() => layer.boundingBox())
        .toStrictEqual({ height: viewport.height, width: viewport.width, x: 0, y: 0 });
      // The point at the page's own heading is the layer's, not the page's.
      const covered = await page.evaluate(() => {
        const heading = document.querySelector('h1');
        const rect = heading?.getBoundingClientRect();
        if (rect === undefined) {
          return false;
        }
        const top = document.elementFromPoint(rect.x + 4, rect.y + 4);
        return top !== null && top.closest('[role=dialog]') !== null;
      });
      expect(covered).toBe(true);
      // A control on the page beneath cannot take focus: the page is inert.
      const opener = await page.evaluate(() => {
        const button = [...document.querySelectorAll('button')].find(
          (b) => b.textContent === 'Open',
        );
        button?.focus();
        return document.activeElement === button;
      });
      expect(opener).toBe(false);
      await expect(
        layer.getByRole('heading', { name: 'Keep the rail beside the steps?' }),
      ).toBeFocused();
      // Tab stays inside the layer.
      for (let step = 0; step < 8; step += 1) {
        await page.keyboard.press('Tab');
        expect(
          await page.evaluate(() => document.activeElement?.closest('[role=dialog]') !== null),
        ).toBe(true);
      }
    });

    test('moves the answer with the arrow keys', async ({ page }) => {
      await page.goto(`${harness.origin}?form=walkthrough`);
      const layer = page.getByRole('dialog', { name: 'Deliver the console' });
      const keep = layer.getByRole('radio', { name: 'Keep the rail' });
      const remove = layer.getByRole('radio', { name: 'Remove it on desktop' });
      const custom = layer.getByRole('radio', { name: 'Something else' });
      await expect(keep).toBeChecked();
      await keep.focus();
      await page.keyboard.press('ArrowDown');
      await expect(remove).toBeChecked();
      await expect(remove).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(custom).toBeChecked();
      await page.keyboard.press('ArrowUp');
      await expect(remove).toBeChecked();
      await expect(keep).not.toBeChecked();
      // The row holds the visible focus ring, around the whole answer.
      const ring = await remove.evaluate(
        (radio) => getComputedStyle(radio.closest('label')!).outlineStyle,
      );
      expect(ring).toBe('solid');
    });
  });
}

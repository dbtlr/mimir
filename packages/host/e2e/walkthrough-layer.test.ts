import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

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

const QUESTION = 'Keep the rail beside the steps?';

/** Waits out the layer's 150ms entry, until it is the viewport edge to edge. */
async function settled(page: Page, viewport: { height: number; width: number }) {
  await expect
    .poll(() => page.getByRole('dialog').boundingBox())
    .toStrictEqual({ height: viewport.height, width: viewport.width, x: 0, y: 0 });
}

/** Drops what the screen asks about, as a refresh that resolved it elsewhere would (the harness's event). */
async function drop(page: Page) {
  await page.evaluate(() => globalThis.dispatchEvent(new Event('walkthrough-drop')));
}

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

    test('tabs through the bar in the order it reads, with no CSS order', async ({ page }) => {
      await page.goto(`${harness.origin}?form=walkthrough`);
      const layer = page.getByRole('dialog', { name: 'Deliver the console' });
      await expect(layer.getByRole('heading', { name: QUESTION })).toBeFocused();
      await settled(page, viewport);
      // Back is disabled on the first step, so step on to reach it.
      await layer.getByRole('button', { name: 'Confirm and continue' }).press('Enter');
      await expect(
        layer.getByRole('heading', { name: 'Group the refused answers?' }),
      ).toBeFocused();
      const visited: { name: string; x: number; y: number }[] = [];
      for (let press = 0; press < 12 && visited.length < 3; press += 1) {
        await page.keyboard.press('Tab');
        const stop = await page.evaluate(() => {
          const active = document.activeElement;
          if (active === null || active.closest('footer') === null) {
            return null;
          }
          const box = active.getBoundingClientRect();
          return {
            name: active.getAttribute('aria-label') ?? active.textContent ?? '',
            x: box.x,
            y: box.y,
          };
        });
        if (stop !== null) {
          visited.push(stop);
        }
      }
      const note = 'Add a note for the agent (optional)';
      const names = visited.map((stop) => stop.name);
      expect(names).toStrictEqual(
        viewport.name === 'phone'
          ? [note, 'Back', 'Confirm and review']
          : ['Back', note, 'Confirm and review'],
      );
      // Each stop reads after the one before: lower down, or level with it and further right.
      for (let index = 1; index < visited.length; index += 1) {
        const before = visited[index - 1];
        const stop = visited[index];
        const reads =
          stop.y > before.y + 1 || (Math.abs(stop.y - before.y) <= 30 && stop.x > before.x);
        expect(reads, `${stop.name} after ${before.name}`).toBe(true);
      }
      const ordered = await layer.evaluate(
        (root) =>
          [...root.querySelectorAll('*')].filter((el) => getComputedStyle(el).order !== '0').length,
      );
      expect(ordered).toBe(0);
    });

    test('grows the note to four lines, 110 tall, then scrolls', async ({ page }) => {
      await page.goto(`${harness.origin}?form=walkthrough`);
      await settled(page, viewport);
      const note = page.getByRole('textbox', { name: 'Add a note for the agent (optional)' });
      const oneLine = await note.boundingBox();
      expect(oneLine?.height).toBe(44);
      await note.fill(['one', 'two', 'three', 'four', 'five'].join('\n'));
      // 110 is the border box (DESIGN.md: 22 a line, 20 padding, 2 border, as the 88 of three
      // lines); clientHeight, which leaves out the two 1px borders, reads 108.
      await expect.poll(async () => (await note.boundingBox())?.height).toBe(110);
      const box = await note.evaluate((element) => ({
        client: element.clientHeight,
        overflow: getComputedStyle(element).overflowY,
        scroll: element.scrollHeight,
      }));
      expect(box.client).toBe(108);
      expect(box.overflow).toBe('auto');
      expect(box.scroll).toBeGreaterThan(box.client);
    });

    test('sets its text on whole pixels, on the type scale', async ({ page }) => {
      await page.goto(`${harness.origin}?form=walkthrough`);
      await settled(page, viewport);
      const layer = page.getByRole('dialog', { name: 'Deliver the console' });
      // The dialog's title is an h2 too; the screen's heading is the one that takes focus.
      const [heading, prose, barLine] = await layer.evaluate((root) =>
        ['h2[tabindex]', 'h2[tabindex] + p', 'footer p'].map((selector) => {
          const style = getComputedStyle(root.querySelector(selector)!);
          return {
            letterSpacing: style.letterSpacing,
            lineHeight: style.lineHeight,
            size: style.fontSize,
          };
        }),
      );
      // What shows: a phone keeps the header's progress for a screen reader alone, 1px square.
      const tops = await layer.evaluate((root) =>
        [...root.querySelectorAll('h2, p, label, button, textarea')]
          .map((element) => element.getBoundingClientRect())
          .filter((box) => box.width > 1)
          .map((box) => box.top),
      );
      expect(heading).toStrictEqual({ letterSpacing: '-0.21px', lineHeight: '28px', size: '21px' });
      expect(prose).toMatchObject({ lineHeight: '23px', size: '14px' });
      expect(barLine).toMatchObject({ lineHeight: '20px', size: '13px' });
      expect(tops.filter((top) => !Number.isInteger(top))).toStrictEqual([]);
    });

    test('keeps focus in the layer when what held it is resolved elsewhere', async ({ page }) => {
      const heading = page.getByRole('heading', { name: QUESTION });
      const inLayer = () =>
        page.evaluate(() => document.activeElement?.closest('[role=dialog]') !== null);
      // An answer held focus.
      await page.goto(`${harness.origin}?form=walkthrough`);
      await page.getByRole('radio', { name: 'Keep the rail' }).focus();
      await drop(page);
      await expect(page.getByRole('status')).toHaveText('This decision no longer waits on you');
      await expect(heading).toBeFocused();
      expect(await inLayer()).toBe(true);
      // The note held focus.
      await page.goto(`${harness.origin}?form=walkthrough`);
      await page.getByRole('textbox', { name: 'Add a note for the agent (optional)' }).focus();
      await drop(page);
      await expect(heading).toBeFocused();
      // On the check screen, an entry's Change held focus.
      await page.goto(`${harness.origin}?form=walkthrough`);
      await page.getByRole('button', { name: 'Confirm and continue' }).press('Enter');
      await page.getByRole('button', { name: 'Confirm and review' }).press('Enter');
      const check = page.getByRole('heading', { name: 'Check your answers' });
      await expect(check).toBeFocused();
      await page.getByRole('button', { name: 'Change' }).first().focus();
      await drop(page);
      await expect(page.getByRole('button', { name: 'Change' })).toHaveCount(1);
      await expect(check).toBeFocused();
    });

    test('moves one screen for a double click, and never writes from one', async ({ page }) => {
      await page.goto(`${harness.origin}?form=walkthrough`);
      const layer = page.getByRole('dialog', { name: 'Deliver the console' });
      await settled(page, viewport);
      await layer.getByRole('button', { name: 'Confirm and continue' }).dblclick();
      // The second click's press focuses the button it lands on, so only the screen is checked.
      await expect(
        layer.getByRole('heading', { name: 'Group the refused answers?' }),
      ).toBeVisible();
      await expect(layer).toContainText('2 of 2');
      await layer.getByRole('button', { name: 'Confirm and review' }).dblclick();
      await expect(layer.getByRole('heading', { name: 'Check your answers' })).toBeVisible();
      await expect(page.locator('main')).toHaveAttribute('data-writes', '0');
      // A single click, or a key, still writes.
      await layer.getByRole('button', { name: 'Send 2 answers' }).press('Enter');
      await expect(page.locator('main')).toHaveAttribute('data-writes', '1');
    });

    test('double-clicking Change opens the decision and keeps its answer', async ({ page }) => {
      await page.goto(`${harness.origin}?form=walkthrough`);
      await settled(page, viewport);
      const layer = page.getByRole('dialog');
      await layer.getByRole('button', { name: 'Confirm and continue' }).press('Enter');
      await layer.getByRole('button', { name: 'Confirm and review' }).press('Enter');

      await layer.getByRole('button', { name: 'Change' }).nth(1).dblclick();

      await expect(
        layer.getByRole('heading', { name: 'Group the refused answers?' }),
      ).toBeVisible();
      await expect(layer.getByRole('radio', { name: 'Keep the rail' })).toBeChecked({
        timeout: 3000,
      });
    });

    test('double-clicking Back moves back one step', async ({ page }) => {
      await page.goto(`${harness.origin}?form=walkthrough`);
      await settled(page, viewport);
      const layer = page.getByRole('dialog');
      await layer.getByRole('button', { name: 'Confirm and continue' }).press('Enter');
      await layer.getByRole('button', { name: 'Confirm and review' }).press('Enter');

      await layer.getByRole('button', { name: 'Back' }).dblclick();

      await expect(layer.getByRole('heading', { name: 'Group the refused answers?' })).toBeVisible({
        timeout: 3000,
      });
    });
  });
}

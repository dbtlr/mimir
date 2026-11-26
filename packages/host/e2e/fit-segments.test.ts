import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { serveHarness } from './form-sheet/serve';
import type { Harness } from './form-sheet/serve';

/*
 * The `fit` Segmented tracks in Chromium (DESIGN.md, A form): the Seeds
 * Filter's Show and a task's Size, Priority, and Grooming. On a phone each
 * segment is at least 44 wide and its label never runs past it; a label wraps
 * to two lines only when the row cannot hold it on one, as at 320. From `md`
 * up the segments share the track in equal widths.
 */

let harness: Harness;

test.beforeAll(async () => {
  harness = await serveHarness();
});

test.afterAll(async () => {
  await harness.close();
});

const SHEETS = [
  { form: 'seed-filter', tracks: ['Show'] },
  { form: 'task-edit', tracks: ['Size', 'Priority', 'Grooming'] },
];

/** The phone minimum, in CSS pixels. */
const TAP = 44;

/** Longer than a sheet's slide in. */
const SHEET_MOTION = 600;

type Segment = {
  label: string;
  width: number;
  height: number;
  /** How far the label's text runs past the segment's edges, at most. */
  overflow: number;
  lines: number;
};

/** Every segment of the named track: its box, how far its label overflows it, and its line count. */
function segmentsOf(page: Page, track: string): Promise<Segment[]> {
  return page.getByRole('radiogroup', { name: track }).evaluate((group) =>
    [...group.querySelectorAll('[role=radio]')].map((radio) => {
      const box = radio.getBoundingClientRect();
      const words = document.createTreeWalker(radio, NodeFilter.SHOW_TEXT).nextNode();
      const range = document.createRange();
      range.selectNodeContents(words ?? radio);
      const text = range.getBoundingClientRect();
      const tops = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
      return {
        height: box.height,
        label: radio.textContent,
        lines: tops.size,
        overflow: Math.max(
          box.left - text.left,
          text.right - box.right,
          box.top - text.top,
          text.bottom - box.bottom,
          radio.scrollWidth - radio.clientWidth,
        ),
        width: box.width,
      };
    }),
  );
}

async function openSheet(page: Page, form: string, width: number) {
  await page.setViewportSize({ height: 844, width });
  await page.goto(`${harness.origin}?form=${form}`);
  await page.getByRole('radiogroup').first().waitFor();
  await page.waitForTimeout(SHEET_MOTION);
}

for (const { form, tracks } of SHEETS) {
  for (const width of [320, 390]) {
    test(`${form}: every fit segment is a 44 target whose label stays inside it at ${String(width)}`, async ({
      page,
    }) => {
      await openSheet(page, form, width);
      for (const track of tracks) {
        for (const segment of await segmentsOf(page, track)) {
          const where = `${track} ${segment.label} at ${String(width)}`;
          expect(segment.width, where).toBeGreaterThanOrEqual(TAP);
          expect(segment.height, where).toBeGreaterThanOrEqual(TAP);
          expect(segment.overflow, where).toBeLessThanOrEqual(0.5);
          expect(segment.lines, where).toBeLessThanOrEqual(width === 390 ? 1 : 2);
        }
      }
    });
  }

  test(`${form}: from md up, fit segments share the track in equal widths`, async ({ page }) => {
    await openSheet(page, form, 1280);
    for (const track of tracks) {
      const widths = (await segmentsOf(page, track)).map((segment) => segment.width);
      expect(Math.max(...widths) - Math.min(...widths), track).toBeLessThanOrEqual(1);
    }
  });
}

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import { serveHarness } from './form-sheet/serve';
import type { Harness } from './form-sheet/serve';

/*
 * The shell's phone touch targets in Chromium (DESIGN.md, Sizes: every tap
 * target on a phone is at least 44 × 44): the needs-you alert's pill in the
 * top bar (MMR-754) and every control in the project drawer (MMR-716), over
 * seeded reads. From `md` (the pill) and `lg` (the sidebar) up, the sizes are
 * the desktop's own and do not change.
 */

let harness: Harness;

test.beforeAll(async () => {
  harness = await serveHarness();
});

test.afterAll(async () => {
  await harness.close();
});

const PHONE = { height: 844, width: 390 };
/** Below `lg` the sidebar is still a drawer, but the `md` phone rules no longer apply. */
const TABLET = { height: 900, width: 800 };
const DESKTOP = { height: 900, width: 1280 };

/** The phone minimum, in CSS pixels. */
const TARGET = 44;

type Viewport = { width: number; height: number };

async function open(page: Page, viewport: Viewport, context = 'project') {
  await page.setViewportSize(viewport);
  await page.goto(`${harness.origin}?form=touch-targets&context=${context}`);
  await expect(page.getByRole('link', { exact: true, name: '1 needs you' })).toBeVisible();
}

/** Whether a tap at the control's centre, moved by `dx` and `dy`, lands on it. */
function hitsAt(control: Locator, dx: number, dy: number): Promise<boolean> {
  return control.evaluate(
    (element, [x, y]) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.left + box.width / 2 + x,
        box.top + box.height / 2 + y,
      );
      return hit !== null && element.contains(hit);
    },
    [dx, dy],
  );
}

/**
 * Whether a tap anywhere in the `size` square centred on the control lands on
 * it: its four corners and the midpoints of its edges, read with
 * `elementFromPoint`, so a hit area an overlay extends past the drawn box counts.
 */
function takesSquare(control: Locator, size: number): Promise<boolean> {
  return control.evaluate((element, side) => {
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    // Half a pixel in from the square's edge, so a point on the boundary is inside it.
    const reach = side / 2 - 0.5;
    const offsets = [-reach, 0, reach];
    return offsets.every((dx) =>
      offsets.every((dy) => {
        const hit = document.elementFromPoint(x + dx, y + dy);
        return hit !== null && element.contains(hit);
      }),
    );
  }, size);
}

async function boxSize(control: Locator): Promise<{ width: number; height: number }> {
  const box = await control.boundingBox();
  if (box === null) {
    throw new Error('the control has no box');
  }
  return { height: Math.round(box.height), width: Math.round(box.width) };
}

/** Open the finished fold, so every row shows (ADR 0013, MMR-730 refinement). */
async function openFolds(sidebar: Locator) {
  await sidebar.getByText('1 finished initiative').click();
  await expect(sidebar.getByRole('link', { name: /^initiative MMR-5/u })).toBeVisible();
}

/** Each control in the sidebar, as "its name: width × height", in document order. */
async function controlSizes(sidebar: Locator): Promise<{ label: string; small: boolean }[]> {
  const controls = sidebar.locator('a, button, summary');
  const sizes: { label: string; small: boolean }[] = [];
  for (let index = 0; index < (await controls.count()); index += 1) {
    const control = controls.nth(index);
    // The rendered text, with a line break between a row's parts; textContent runs them together.
    // oxlint-disable-next-line unicorn/prefer-dom-node-text-content
    const name = (await control.getAttribute('aria-label')) ?? (await control.innerText());
    const { width, height } = await boxSize(control);
    sizes.push({
      label: `${name.replaceAll(/\s+/gu, ' ').trim()}: ${String(width)} × ${String(height)}`,
      small: width < TARGET || height < TARGET,
    });
  }
  return sizes;
}

test.describe('the needs-you alert', () => {
  test('takes a 44 × 44 tap on a phone, its pill drawn 34 tall', async ({ page }) => {
    await open(page, PHONE);
    const pill = page.getByRole('link', { exact: true, name: '1 needs you' });
    expect((await boxSize(pill)).height).toBe(34);
    expect(await takesSquare(pill, TARGET)).toBe(true);
  });

  test('reaches no further than 44 tall, and none of its neighbours', async ({ page }) => {
    await open(page, PHONE);
    const pill = page.getByRole('link', { exact: true, name: '1 needs you' });
    // A point 23 above or below the centre is past a 44 tap (22 each way, with 1 to spare).
    expect(await hitsAt(pill, 0, -23)).toBe(false);
    expect(await hitsAt(pill, 0, 23)).toBe(false);
    // Sideways the tap ends at the drawn pill, about 45 wide: 26 out is past it.
    const { width } = await boxSize(pill);
    expect(width).toBeLessThan(50);
    expect(await hitsAt(pill, -26, 0)).toBe(false);
    expect(await hitsAt(pill, 26, 0)).toBe(false);
    // Each neighbour, a 44 icon button, takes a tap 1 inside each edge's midpoint.
    // The sidebar, drawn at every width here, holds a Jump to of its own; the bar's is the one beside the pill.
    for (const name of ['Jump to…', 'More', 'Open project menu']) {
      const neighbour = page.getByRole('banner').getByRole('button', { name });
      for (const [dx, dy] of [
        [-21, 0],
        [21, 0],
        [0, -21],
        [0, 21],
      ] as const) {
        expect(await hitsAt(neighbour, dx, dy)).toBe(true);
      }
    }
  });

  test('keeps its desktop pill, with no hit area past it', async ({ page }) => {
    await open(page, DESKTOP);
    const pill = page.getByRole('link', { exact: true, name: '1 needs you' });
    const drawn = await boxSize(pill);
    expect(drawn.height).toBe(28);
    expect(await takesSquare(pill, drawn.height)).toBe(true);
    expect(await takesSquare(pill, drawn.height + 4)).toBe(false);
  });
});

/** Each sidebar context: its page, the drawer's trigger and name, and how many controls it holds. */
const DRAWERS = [
  { context: 'project', controls: 8, name: 'Project', trigger: 'Open project menu' },
  { context: 'all', controls: 5, name: 'All projects', trigger: 'Open project menu' },
  { context: 'settings', controls: 7, name: 'Settings', trigger: 'Open settings menu' },
];

test.describe('the project sidebar', () => {
  for (const { context, controls, name, trigger } of DRAWERS) {
    for (const [width, viewport] of [
      ['a phone', PHONE],
      ['a tablet', TABLET],
    ] as const) {
      test(`gives every control in the ${context} drawer at least 44 × 44 on ${width}`, async ({
        page,
      }) => {
        await open(page, viewport, context);
        await page.getByRole('button', { name: trigger }).click();
        const drawer = page.getByRole('dialog', { name });
        if (context === 'project') {
          await openFolds(drawer);
        }
        const sizes = await controlSizes(drawer);
        expect(sizes).toHaveLength(controls);
        expect(sizes.filter(({ small }) => small).map(({ label }) => label)).toEqual([]);
      });
    }
  }

  test('keeps its desktop sizes', async ({ page }) => {
    await open(page, DESKTOP);
    const sidebar = page.getByRole('complementary', { name: 'Project' });
    await openFolds(sidebar);
    expect((await controlSizes(sidebar)).map(({ label }) => label)).toEqual([
      'Jump to…: 231 × 36',
      'MMR Mimir: 231 × 36',
      'Blocked task MMR-52: 231 × 32',
      '← Home: 231 × 32',
      'MMR project MMR 1/2: 231 × 32',
      'initiative MMR-1 0/1: 215 × 32',
      '1 finished initiative: 215 × 32',
      'initiative MMR-5 1/1: 215 × 32',
    ]);
  });
});

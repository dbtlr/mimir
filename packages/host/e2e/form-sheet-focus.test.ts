import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

import { serveHarness } from './form-sheet/serve';
import type { Harness } from './form-sheet/serve';

/*
 * The Form sheet's body in real layout (DESIGN.md, Sheets): a focused control
 * is never hidden under the header or the footer (WCAG 2.4.11), at any height a
 * phone or a short window gives the body, and the end of a scroll still rests
 * a field gap below the header. jsdom has no layout, so this runs the real
 * forms in Chromium, served from `e2e/form-sheet`.
 */

/**
 * The least a resting scroll keeps between the header and the first block it
 * shows: the field gap (24), or 20 when that block follows a group heading
 * set 20 above it, since no sliver of the heading may show.
 */
const TIGHTEST_GAP = 20;

let harness: Harness;

test.beforeAll(async () => {
  harness = await serveHarness();
});

test.afterAll(async () => {
  await harness.close();
});

type Placement = {
  /** What has focus, for the failure message. */
  name: string;
  inBody: boolean;
  /** The focused control's edges against the body's, in px. */
  above: number;
  below: number;
};

/** Where the focused control sits in the scrolling body. */
function placement(page: Page): Promise<Placement> {
  return page.evaluate(() => {
    const body = document.querySelector('[data-slot=form-sheet-body]');
    const focused = document.activeElement;
    if (body === null || !(focused instanceof HTMLElement)) {
      return { above: 0, below: 0, inBody: false, name: 'nothing' };
    }
    const frame = body.getBoundingClientRect();
    const rect = focused.getBoundingClientRect();
    return {
      above: frame.top - rect.top,
      below: rect.bottom - frame.bottom,
      inBody: body.contains(focused),
      name: (
        focused.getAttribute('aria-label') ??
        (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement
          ? focused.labels?.[0]?.textContent
          : focused.textContent) ??
        focused.tagName
      )
        .trim()
        .slice(0, 24),
    };
  });
}

/** Opens a form at a viewport, with Advanced unfolded when it has one. */
async function openForm(page: Page, form: string) {
  await page.goto(`${harness.origin}?form=${form}`);
  await page.locator('[data-slot=form-sheet-body]').waitFor();
  // Let the drawer's entry finish, so the body has its resting size.
  await page.waitForTimeout(400);
  const advanced = page.getByRole('button', { name: 'Advanced' });
  if ((await advanced.count()) > 0) {
    await advanced.click();
    await page.getByRole('radio', { name: 'New worktree' }).click();
    await expect(page.getByLabel('Branch')).toBeVisible();
    // Focus starts again on the first field, as on opening.
    await page.locator('[data-slot=form-sheet-body] input').first().focus();
  }
}

/** Tabs through every control in the body, forward then back, and returns any it hid. */
async function hiddenWhileTabbing(page: Page): Promise<string[]> {
  const hidden: string[] = [];
  const check = async (step: string) => {
    // The scroll that keeps focus in view runs in the same task as the move.
    const at = await placement(page);
    if (at.inBody && (at.above > 0.5 || at.below > 0.5)) {
      hidden.push(
        `${step} ${at.name}: ${String(Math.round(at.above))} above, ${String(Math.round(at.below))} below`,
      );
    }
    return at.inBody;
  };
  await check('start');
  for (let step = 0; step < 20; step += 1) {
    await page.keyboard.press('Tab');
    if (!(await check('Tab'))) {
      break;
    }
  }
  for (let step = 0; step < 20; step += 1) {
    await page.keyboard.press('Shift+Tab');
    await check('Shift+Tab');
  }
  return hidden;
}

/**
 * The blocks the end of a scroll leaves too close to the header or cut by it:
 * any whose visible extent starts above the tightest gap and ends below the
 * header. A block's
 * visible extent is its box less the height a negative margin pulls back (a
 * check row's or a collapsible heading's tap row).
 */
async function cutAtEnd(page: Page): Promise<string[]> {
  const body = page.locator('[data-slot=form-sheet-body]');
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.waitForTimeout(100);
  return body.evaluate((element, gap) => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- it runs in the page, inside this callback
    const pull = (node: Element | null, side: 'marginTop' | 'marginBottom') =>
      node === null ? 0 : Math.max(0, -Number.parseFloat(getComputedStyle(node)[side]));
    const top = element.getBoundingClientRect().top;
    return [...element.querySelectorAll('[data-form-block]')]
      .map((block) => {
        const rect = block.getBoundingClientRect();
        const first = block.firstElementChild;
        return {
          bottom: rect.bottom - Math.max(pull(block, 'marginBottom'), pull(first, 'marginBottom')),
          name: (block.textContent ?? '').slice(0, 16),
          top: rect.top + Math.max(pull(block, 'marginTop'), pull(first, 'marginTop')),
        };
      })
      .filter((extent) => extent.bottom > top + 0.5 && extent.top < top + gap - 0.5)
      .map((extent) => `${extent.name} from ${String(Math.round(extent.top - top))}`);
  }, TIGHTEST_GAP);
}

const SWEEP = [
  { form: 't3', heights: [280, 320, 360, 400, 440, 480, 520, 560, 640, 844], width: 390 },
  { form: 't3', heights: [400, 440, 480, 520, 560, 640, 800], width: 1280 },
  { form: 'project', heights: [280, 300, 320, 360, 400, 480, 560, 844], width: 390 },
  { form: 'project', heights: [400, 440, 480, 520, 560, 640, 800], width: 1280 },
];

// oxlint-disable-next-line vitest/prefer-each -- Playwright has no `each`; this is its pattern
for (const { form, width, heights } of SWEEP) {
  test(`the ${form} form keeps every focused control in view at ${String(width)} wide`, async ({
    browser,
  }) => {
    const failures: string[] = [];
    for (const height of heights) {
      const context = await browser.newContext({
        hasTouch: width < 768,
        viewport: { height, width },
      });
      const page = await context.newPage();
      await openForm(page, form);
      for (const hidden of await hiddenWhileTabbing(page)) {
        failures.push(`${String(width)}x${String(height)} ${hidden}`);
      }
      for (const cut of await cutAtEnd(page)) {
        failures.push(`${String(width)}x${String(height)} end of scroll cuts ${cut}`);
      }
      await context.close();
    }
    expect(failures).toEqual([]);
  });
}

/** Opens a form at a viewport as it first shows: Advanced folded, focus on the first field. */
async function openAsShown(
  browser: Browser,
  form: string,
  viewport: { width: number; height: number },
) {
  const phone = viewport.width < 768;
  const context = await browser.newContext({ hasTouch: phone, isMobile: phone, viewport });
  const page = await context.newPage();
  await page.goto(`${harness.origin}?form=${form}`);
  await page.locator('[data-slot=form-sheet-body]').waitFor();
  await page.waitForTimeout(400);
  return { context, page };
}

/** The body's scroll. */
function bodyScroll(page: Page): Promise<number> {
  return page.locator('[data-slot=form-sheet-body]').evaluate((element) => element.scrollTop);
}

type Clearance = {
  name: string;
  /** Room between the header and the top of the focused control's outline, in px. */
  top: number;
  /** Room between the bottom of its outline and the footer, in px. */
  bottom: number;
  /** Room between the body's top and the first block's label: its top padding at rest. */
  firstBlock: number;
};

/** Where the focused control's outline sits against the body's edges. */
function clearance(page: Page): Promise<Clearance> {
  return page.evaluate(() => {
    const body = document.querySelector('[data-slot=form-sheet-body]');
    const focused = document.activeElement;
    const first = document.querySelector('[data-form-block]');
    if (body === null || first === null || !(focused instanceof HTMLElement)) {
      throw new Error('no focused control in a body');
    }
    const style = getComputedStyle(focused);
    const ring =
      style.outlineStyle === 'none'
        ? 0
        : Math.max(
            0,
            Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset),
          );
    const frame = body.getBoundingClientRect();
    const rect = focused.getBoundingClientRect();
    return {
      bottom: Math.round(frame.bottom - (rect.bottom + ring)),
      firstBlock: Math.round(first.getBoundingClientRect().top - frame.top),
      name: (focused.getAttribute('aria-label') ?? focused.textContent ?? '').trim().slice(0, 24),
      top: Math.round(rect.top - ring - frame.top),
    };
  });
}

// oxlint-disable-next-line vitest/prefer-each -- Playwright has no `each`; this is its pattern
for (const width of [390, 1280]) {
  test(`a press on Advanced just in view at the bottom opens it where it lies, at ${String(width)} wide`, async ({
    browser,
  }) => {
    const { context, page } = await openAsShown(browser, 't3', { height: 680, width });
    const trigger = page.getByRole('button', { name: 'Advanced' });
    // Scroll so the heading's tap row ends 2 above the footer: whole, but short of the end padding.
    await page.locator('[data-slot=form-sheet-body]').evaluate((element) => {
      const heading = [...element.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Advanced',
      );
      if (heading === undefined) {
        throw new Error('no Advanced');
      }
      const bottom = heading.getBoundingClientRect().bottom - element.getBoundingClientRect().top;
      element.scrollTop += bottom - element.clientHeight + 2;
    });
    const before = await bodyScroll(page);
    expect(before).toBeGreaterThan(0);
    const box = await trigger.boundingBox();
    if (box === null) {
      throw new Error('Advanced has no box');
    }
    // A mouse press, not a tap: the press focuses the heading before the release lands.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(400);
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(await bodyScroll(page)).toBe(before);
    await context.close();
  });
}

test('a phone’s model list leaves the form behind it where it was, opened and closed', async ({
  browser,
}) => {
  const { context, page } = await openAsShown(browser, 't3', { height: 420, width: 390 });
  const model = page.getByRole('combobox', { name: 'Model' });
  await model.tap();
  await page.waitForTimeout(600);
  await expect(page.getByRole('option', { name: 'Claude Opus' })).toBeVisible();
  expect(await bodyScroll(page)).toBe(0);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  await expect(model).toBeFocused();
  expect(await bodyScroll(page)).toBe(0);
  await context.close();
});

test('arrowing through a phone’s model list leaves the form behind it where it was', async ({
  browser,
}) => {
  const { context, page } = await openAsShown(browser, 't3', { height: 340, width: 390 });
  await page.keyboard.press('Tab');
  await expect(page.getByRole('combobox', { name: 'Model' })).toBeFocused();
  const resting = await bodyScroll(page);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  const scrolls: number[] = [];
  for (let step = 0; step < 3; step += 1) {
    await page.keyboard.press('ArrowDown');
    scrolls.push(await bodyScroll(page));
  }
  expect(scrolls).toEqual([resting, resting, resting]);
  await context.close();
});

test('focus back from a desktop model list lands on its trigger whole, clear of the header', async ({
  browser,
}) => {
  const { context, page } = await openAsShown(browser, 't3', { height: 360, width: 1280 });
  await page.keyboard.press('Tab');
  await expect(page.getByRole('combobox', { name: 'Model' })).toBeFocused();
  const resting = await bodyScroll(page);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  expect(await bodyScroll(page)).toBe(resting);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await expect(page.getByRole('combobox', { name: 'Model' })).toBeFocused();
  const at = await clearance(page);
  expect(at.top).toBeGreaterThanOrEqual(0);
  expect(at.bottom).toBeGreaterThanOrEqual(0);
  await context.close();
});

// oxlint-disable-next-line vitest/prefer-each -- Playwright has no `each`; this is its pattern
for (const { width, height, padding } of [
  { height: 360, padding: 24, width: 390 },
  { height: 400, padding: 32, width: 1280 },
]) {
  test(`Shift+Tab back to the first field rests it at the body's top padding, at ${String(width)} wide`, async ({
    browser,
  }) => {
    const { context, page } = await openAsShown(browser, 'project', { height, width });
    await expect(page.getByRole('textbox', { name: 'Title' })).toBeFocused();
    for (let step = 0; step < 3; step += 1) {
      await page.keyboard.press('Tab');
    }
    for (let step = 0; step < 3; step += 1) {
      await page.keyboard.press('Shift+Tab');
    }
    await expect(page.getByRole('textbox', { name: 'Title' })).toBeFocused();
    const at = await clearance(page);
    expect(at.top).toBeGreaterThan(0);
    expect(at.firstBlock).toBe(padding);
    await context.close();
  });
}

test('a focused field stays whole when the viewport shortens under it, as a phone’s keyboard opens', async ({
  browser,
}) => {
  const { context, page } = await openAsShown(browser, 't3', { height: 640, width: 390 });
  // Runtime, the last field before Advanced, sits low in the body at this height.
  const runtime = page.getByRole('combobox', { name: 'Runtime' });
  for (
    let step = 0;
    step < 8 && !(await runtime.evaluate((e) => e === document.activeElement));
    step += 1
  ) {
    await page.keyboard.press('Tab');
  }
  await expect(runtime).toBeFocused();
  expect((await clearance(page)).bottom).toBeGreaterThanOrEqual(0);
  await page.setViewportSize({ height: 400, width: 390 });
  await page.waitForTimeout(300);
  const at = await clearance(page);
  expect(at.top).toBeGreaterThanOrEqual(0);
  expect(at.bottom).toBeGreaterThanOrEqual(0);
  await context.close();
});

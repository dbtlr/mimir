import { expect, test } from '@playwright/test';
import type { Browser, Locator, Page } from '@playwright/test';

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
  /** The focused control's outline against the body's edges, in px. */
  above: number;
  below: number;
  firstBlock: number;
};

/** Where the focused control sits in the scrolling body. */
function placement(page: Page): Promise<Placement> {
  return page.evaluate(() => {
    const body = document.querySelector('[data-slot=form-sheet-body]');
    const focused = document.activeElement;
    const first = body?.querySelector('[data-form-block]');
    if (body === null || first == null || !(focused instanceof HTMLElement)) {
      throw new Error('no focused control or form body');
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
      above: frame.top - (rect.top - ring),
      below: rect.bottom + ring - frame.bottom,
      firstBlock: first.getBoundingClientRect().top - frame.top,
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
    await page.getByRole('combobox', { name: 'System' }).focus();
  }
}

/** The tab stop in each body field, in order. A Choice contributes its selected radio. */
function bodyControls(page: Page, form: string): Locator[] {
  if (form === 'project') {
    return [
      page.getByRole('textbox', { name: 'Title' }),
      page.getByRole('textbox', { name: /Description/ }),
      page.getByRole('button', { name: 'Archive project' }),
    ];
  }
  return [
    page.getByRole('combobox', { name: 'System' }),
    page.getByRole('combobox', { name: 'Model' }),
    page.getByRole('radio', { name: 'high' }),
    page.getByRole('radio', { name: 'Unset' }),
    page.getByRole('combobox', { name: 'Runtime' }),
    page.getByRole('button', { name: 'Advanced' }),
    page.getByRole('radio', { name: 'New worktree' }),
    page.getByRole('textbox', { name: /Branch/ }),
    page.getByRole('checkbox', { name: 'Plan first' }),
  ];
}

/** Tabs through every control in the body, forward then back, and returns any it hid. */
async function hiddenWhileTabbing(page: Page, form: string): Promise<string[]> {
  const hidden: string[] = [];
  const controls = bodyControls(page, form);
  const check = async (control: Locator, step: string) => {
    await expect(control).toBeFocused();
    // The scroll that keeps focus in view runs in the same task as the move.
    const at = await placement(page);
    expect(at.inBody).toBe(true);
    if (at.above > 0.5 || at.below > 0.5) {
      hidden.push(
        `${step} ${at.name}: ${String(Math.round(at.above))} above, ${String(Math.round(at.below))} below`,
      );
    }
  };
  for (const [index, control] of controls.entries()) {
    if (index > 0) {
      await page.keyboard.press('Tab');
    }
    await check(control, index === 0 ? 'start' : 'Tab');
  }
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-slot=form-sheet-footer] :focus')).toBeVisible();
  for (let index = controls.length - 1; index >= 0; index -= 1) {
    await page.keyboard.press('Shift+Tab');
    await check(controls[index], 'Shift+Tab');
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
      for (const hidden of await hiddenWhileTabbing(page, form)) {
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

/** Where the focused control's outline sits against the body's edges. */
async function clearance(page: Page) {
  const at = await placement(page);
  expect(at.inBody).toBe(true);
  return {
    bottom: Math.round(-at.below),
    firstBlock: Math.round(at.firstBlock),
    top: Math.round(-at.above),
  };
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
  const list = page.getByRole('listbox', { name: 'Model' });
  await expect(list).toBeVisible();
  const active = list.locator('[role=option][data-highlighted]');
  const before = await active.getAttribute('id');
  expect(before).toBeTruthy();
  await page.keyboard.press('ArrowDown');
  await expect(active).toBeVisible();
  await expect(active).not.toHaveAttribute('id', before ?? '');
  const scrolls = [await bodyScroll(page)];
  for (let step = 0; step < 2; step += 1) {
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

// oxlint-disable-next-line vitest/prefer-each -- Playwright has no `each`; this is its pattern
for (const height of [365, 375]) {
  test(`focus back on a phone’s Model, already whole in view, moves nothing, at 390x${String(height)}`, async ({
    browser,
  }) => {
    const { context, page } = await openAsShown(browser, 't3', { height, width: 390 });
    const model = page.getByRole('combobox', { name: 'Model' });
    await model.tap();
    await page.waitForTimeout(600);
    await expect(page.getByRole('option', { name: 'Claude Opus' })).toBeVisible();
    const scrolls = [await bodyScroll(page)];
    for (let step = 0; step < 3; step += 1) {
      await page.keyboard.press('ArrowDown');
      scrolls.push(await bodyScroll(page));
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    await expect(model).toBeFocused();
    scrolls.push(await bodyScroll(page));
    expect(scrolls).toEqual([0, 0, 0, 0, 0]);
    await context.close();
  });
}

// oxlint-disable-next-line vitest/prefer-each -- Playwright has no `each`; this is its pattern
for (const { width, height, padding } of [
  { height: 480, padding: 24, width: 390 },
  { height: 520, padding: 32, width: 1280 },
]) {
  test(`Shift+Tab onto Title with its label scrolled under the header rests the whole field, at ${String(width)} wide`, async ({
    browser,
  }) => {
    const { context, page } = await openAsShown(browser, 'project', { height, width });
    await page.keyboard.press('Tab');
    await expect(page.getByRole('textbox', { name: 'Description' })).toBeFocused();
    // Description shows whole at this height, so the Tab moves nothing.
    expect(await bodyScroll(page)).toBe(0);
    const body = page.locator('[data-slot=form-sheet-body]');
    const box = await body.boundingBox();
    if (box === null) {
      throw new Error('the body has no box');
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 40);
    // Title's control still shows whole at 40; only its label sits under the header.
    await expect.poll(() => bodyScroll(page)).toBe(40);
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('textbox', { name: 'Title' })).toBeFocused();
    const at = await clearance(page);
    expect(at.firstBlock).toBe(padding);
    await context.close();
  });
}

test('a phone’s model list opened, arrowed, and closed by keyboard leaves the form where it was', async ({
  browser,
}) => {
  const { context, page } = await openAsShown(browser, 't3', { height: 365, width: 390 });
  const model = page.getByRole('combobox', { name: 'Model' });
  await page.keyboard.press('Tab');
  await expect(model).toBeFocused();
  const resting = await bodyScroll(page);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  await expect(page.getByRole('option', { name: 'Claude Opus' })).toBeVisible();
  const scrolls = [await bodyScroll(page)];
  for (let step = 0; step < 3; step += 1) {
    await page.keyboard.press('ArrowDown');
    scrolls.push(await bodyScroll(page));
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  await expect(model).toBeFocused();
  scrolls.push(await bodyScroll(page));
  expect(scrolls).toEqual([resting, resting, resting, resting, resting]);
  await context.close();
});

test('a keyboard-focused field low in the form keeps the end padding above the footer when the viewport shortens', async ({
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
  // Shorten the viewport until Runtime ends 16 above the footer: whole, but inside the end padding.
  const before = await clearance(page);
  expect(before.bottom).toBeGreaterThan(16);
  await page.setViewportSize({ height: 640 - (before.bottom - 16), width: 390 });
  await page.waitForTimeout(300);
  // The body's end padding on a phone (DESIGN.md, Sheets): a keyboard focus rests this far up.
  const at = await clearance(page);
  expect(at.top).toBeGreaterThanOrEqual(0);
  expect(at.bottom).toBeGreaterThanOrEqual(32);
  await context.close();
});

test('the task edit sheet opens on Title with the caret after the saved title, nothing selected', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
  const page = await context.newPage();
  await page.goto(`${harness.origin}?form=task-edit`);
  const title = page.getByRole('textbox', { name: 'Title' });
  await expect(title).toBeFocused();
  await page.waitForTimeout(600);
  const caret = await title.evaluate((element) => {
    if (!(element instanceof HTMLInputElement)) {
      throw new TypeError('Title is not an input');
    }
    return {
      end: element.selectionEnd,
      length: element.value.length,
      start: element.selectionStart,
    };
  });
  expect(caret).toStrictEqual({ end: caret.length, length: caret.length, start: caret.length });
  await context.close();
});

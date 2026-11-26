import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import { serveHarness } from './form-sheet/serve';
import type { Harness } from './form-sheet/serve';

/*
 * What the Form sheet's primitives draw in Chromium, which jsdom cannot
 * compute (DESIGN.md, Controls and A form): the focus ring each control shows,
 * and the field gap a Select keeps below it on a phone.
 */

/** Longer than a control's color transition (150ms). */
const TRANSITION = 300;

/** Longer than a bottom sheet's slide in or out. */
const SHEET_MOTION = 600;

let harness: Harness;

test.beforeAll(async () => {
  harness = await serveHarness();
});

test.afterAll(async () => {
  await harness.close();
});

async function openForm(page: Page, form: string) {
  await page.goto(`${harness.origin}?form=${form}`);
  await page.locator('[data-slot=form-sheet-body]').waitFor();
  await page.waitForTimeout(400);
}

/** Tabs until the requested control has focus, then reads its outline and edge. */
async function ringOn(page: Page, control: Locator) {
  for (
    let step = 0;
    step < 12 && !(await control.evaluate((element) => element === document.activeElement));
    step += 1
  ) {
    await page.keyboard.press('Tab');
  }
  // The edge eases to accent (`transition-colors`); read it once it lands.
  await page.waitForTimeout(TRANSITION);
  await expect(control).toBeFocused();
  return control.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      border: style.borderTopColor,
      color: style.outlineColor,
      offset: style.outlineOffset,
      style: style.outlineStyle,
      width: style.outlineWidth,
    };
  });
}

/** Resolve the theme's accent through Chromium's computed color serialization. */
function accentColor(page: Page) {
  return page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--color-accent)';
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
}

test('a long T3 task title takes two lines beside its ID at 390 × 500', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { height: 500, width: 390 } });
  const page = await context.newPage();
  const taskTitle = 'Continue a linked workspace and preserve the current draft '.repeat(5).trim();
  await page.goto(`${harness.origin}?form=t3&taskTitle=${encodeURIComponent(taskTitle)}`);
  const header = page.locator('[data-slot=form-sheet-header]');
  const title = header.getByText(taskTitle, { exact: true });
  const id = header.getByText('MMR-743', { exact: true });
  await expect(id).toBeVisible();
  await expect(title).toHaveCSS('-webkit-line-clamp', '2');
  const dimensions = await title.evaluate((element) => ({
    height: element.clientHeight,
    line: Number.parseFloat(getComputedStyle(element).lineHeight),
    textHeight: element.scrollHeight,
  }));
  expect(dimensions.height).toBe(2 * dimensions.line);
  expect(dimensions.textHeight).toBeGreaterThan(dimensions.height);
  await expect(id).toHaveCSS('white-space', 'nowrap');
  await expect(page.getByRole('button', { name: 'Launch' })).toBeInViewport();
  await context.close();
});

test('a two-action Notice gives its message the full row at 1280px', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { height: 800, width: 1280 } });
  const page = await context.newPage();
  await page.goto(`${harness.origin}?form=notice`);
  await page.getByRole('button', { name: 'Show notice' }).click();
  const notice = page.locator('[data-slot=toast]');
  const rows = await notice.evaluate((element) => {
    const message = element.querySelector('[data-slot=toast-title]')?.parentElement;
    const [first, second] = element.querySelectorAll('button');
    if (message === null || message === undefined || first === undefined || second === undefined) {
      throw new Error('The Notice is missing its message or actions');
    }
    const style = getComputedStyle(element);
    return {
      available:
        element.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight),
      firstTop: first.getBoundingClientRect().top,
      messageBottom: message.getBoundingClientRect().bottom,
      messageWidth: message.clientWidth,
      secondTop: second.getBoundingClientRect().top,
    };
  });
  expect(rows.messageWidth).toBe(rows.available);
  expect(rows.firstTop).toBeGreaterThan(rows.messageBottom);
  expect(rows.secondTop).toBe(rows.firstTop);
  await context.close();
});

test('a field’s focus ring is its accent edge joined by a 1px solid outline', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { height: 800, width: 1280 } });
  const page = await context.newPage();
  await openForm(page, 'project');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const ring = await ringOn(page, page.getByRole('textbox', { name: 'Title' }));
  const accent = await accentColor(page);
  expect(ring).toMatchObject({
    border: accent,
    color: accent,
    offset: '0px',
    style: 'solid',
    width: '1px',
  });
  await context.close();
});

test('a Select trigger and a collapsible heading draw their focus rings solid', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { height: 800, width: 1280 } });
  const page = await context.newPage();
  await openForm(page, 't3');
  const select = await ringOn(page, page.getByRole('combobox', { name: 'Model' }));
  const accent = await accentColor(page);
  expect(select).toMatchObject({
    border: accent,
    color: accent,
    offset: '0px',
    style: 'solid',
    width: '1px',
  });
  const heading = await ringOn(page, page.getByRole('button', { exact: true, name: 'Advanced' }));
  expect(heading).toMatchObject({ offset: '2px', style: 'solid', width: '2px' });
  await context.close();
});

test('a focused Select on a phone keeps the 24 field gap below it', async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { height: 844, width: 390 },
  });
  const page = await context.newPage();
  await openForm(page, 't3');
  // The form opens on System, whose sheet list then mounts beside its trigger.
  const gap = await page.evaluate(() => {
    const [system, model] = document.querySelectorAll('[data-form-block]');
    const trigger = system?.querySelector('button');
    const label = model?.querySelector('label');
    if (trigger === null || trigger === undefined || label === null || label === undefined) {
      return null;
    }
    return {
      focused: document.activeElement === trigger,
      gap: label.getBoundingClientRect().top - trigger.getBoundingClientRect().bottom,
    };
  });
  expect(gap).toEqual({ focused: true, gap: 24 });
  await context.close();
});

test('a phone’s model list blurs its scrim and opens with the tick alone on the chosen row', async ({
  browser,
}) => {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { height: 844, width: 390 },
  });
  const page = await context.newPage();
  await openForm(page, 't3');
  // Opened, closed, and opened again: the second opening once highlighted the chosen row.
  const model = page.getByRole('combobox', { name: 'Model' });
  await model.tap();
  await page.waitForTimeout(SHEET_MOTION);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(SHEET_MOTION);
  await model.click();
  await page.waitForTimeout(SHEET_MOTION);
  const chosen = page.getByRole('option', { name: 'Claude Opus' });
  await expect(chosen).toBeVisible();
  await page.waitForTimeout(TRANSITION);
  const sheet = await page.evaluate(() => {
    const open = [...document.querySelectorAll('[data-slot=select-viewport]')].find((viewport) =>
      viewport.matches(':popover-open'),
    );
    const row = open?.querySelector('[data-slot=select-item][data-selected]');
    return {
      blur: open === undefined ? null : getComputedStyle(open, '::backdrop').backdropFilter,
      row: row === null || row === undefined ? null : getComputedStyle(row).backgroundColor,
    };
  });
  expect(sheet).toEqual({ blur: 'blur(2px)', row: 'rgba(0, 0, 0, 0)' });
  await expect(chosen).toHaveAttribute('aria-selected', 'true');
  await context.close();
});

/** A control's border-box height. */
function heightOf(control: Locator) {
  return control.evaluate((element) => element.getBoundingClientRect().height);
}

test('a task’s Summary grows from one line to three, and its Description from three without a cap', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
  const page = await context.newPage();
  await openForm(page, 'task-edit');
  const summary = page.getByRole('textbox', { name: /Summary/ });
  const description = page.getByRole('textbox', { name: /Description/ });
  expect(await heightOf(summary)).toBe(44);
  expect(await heightOf(description)).toBe(88);
  await summary.fill('A summary long enough to wrap. '.repeat(12));
  await description.fill(Array.from({ length: 8 }, () => 'A line.').join('\n'));
  await expect.poll(() => heightOf(summary)).toBe(88);
  await expect.poll(() => heightOf(description)).toBe(22 + 8 * 22);
  const scrolls = await description.evaluate(
    (element) => element.scrollHeight > element.clientHeight,
  );
  expect(scrolls).toBe(false);
  await context.close();
});

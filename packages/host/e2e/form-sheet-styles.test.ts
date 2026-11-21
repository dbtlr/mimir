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

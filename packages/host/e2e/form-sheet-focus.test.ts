import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { createServer } from 'vite';
import type { ViteDevServer } from 'vite';

/*
 * The Form sheet's body in real layout (DESIGN.md, Sheets): a focused control
 * is never hidden under the header or the footer (WCAG 2.4.11), at any height a
 * phone or a short window gives the body, and the end of a scroll still rests
 * a field gap below the header. jsdom has no layout, so this runs the real
 * forms in Chromium, served from `e2e/form-sheet`.
 */

const HARNESS = fileURLToPath(new URL('form-sheet', import.meta.url));
const WORKSPACE_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * The least a resting scroll keeps between the header and the first block it
 * shows: the field gap (24), or 20 when that block follows a group heading
 * set 20 above it, since no sliver of the heading may show.
 */
const TIGHTEST_GAP = 20;

let server: ViteDevServer;
let origin: string;

test.beforeAll(async () => {
  server = await createServer({
    configFile: false,
    logLevel: 'error',
    plugins: [react(), tailwindcss()],
    root: HARNESS,
    // The harness imports the console's sources and the workspace's packages.
    server: { fs: { allow: [WORKSPACE_ROOT] }, host: '127.0.0.1' },
  });
  await server.listen(0);
  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    throw new Error('the harness server has no port');
  }
  origin = `http://127.0.0.1:${String(address.port)}/`;
});

test.afterAll(async () => {
  await server.close();
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
  await page.goto(`${origin}?form=${form}`);
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

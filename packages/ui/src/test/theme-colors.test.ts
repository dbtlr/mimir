// `@tailwindcss/vite` intercepts `?raw` on .css and empties it, so styles.css
// is read via fs instead of import — everything else uses `?raw`.
// oxlint-disable-next-line import/no-nodejs-modules
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import indexHtml from '../../index.html?raw';
import mimirMaskableIcon from '../../public/icons/mimir-maskable.svg?raw';
import mimirIcon from '../../public/icons/mimir.svg?raw';
import { injectThemeColorMeta, WELL_900 } from '../lib/theme-colors';

/**
 * `styles.css` and the icon SVGs are static assets — they can't import
 * `WELL_900` (MMR-254). This is the gate that keeps them from drifting from
 * the one importable source instead.
 */
describe('the page-ground hex (WELL_900) stays single-sourced', () => {
  it('injectThemeColorMeta fills the index.html meta placeholder with the dark value', () => {
    expect(injectThemeColorMeta(indexHtml)).toContain(`content="${WELL_900.dark}"`);
  });

  it('styles.css well-900 tokens match dark and light', () => {
    const css = readFileSync('src/styles.css', 'utf8');
    expect(css).toContain(`--color-well-900: ${WELL_900.dark};`);
    expect(css).toContain(`--color-well-900: ${WELL_900.light};`);
  });

  it('the app icon fills match the dark value', () => {
    expect(mimirIcon).toContain(`fill="${WELL_900.dark}"`);
    expect(mimirMaskableIcon).toContain(`fill="${WELL_900.dark}"`);
  });
});

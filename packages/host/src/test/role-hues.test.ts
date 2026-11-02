// `@tailwindcss/vite` intercepts `?raw` on .css and empties it, so styles.css
// is read via fs instead of import.
// oxlint-disable-next-line import/no-nodejs-modules
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const css = readFileSync('src/styles.css', 'utf8');

/** The text of the block that opens at `opener`, up to its closing brace at column 0. */
function blockAfter(opener: string): string {
  const start = css.indexOf(opener);
  if (start === -1) {
    throw new Error(`styles.css has no ${opener} block`);
  }
  return css.slice(start, css.indexOf('\n}', start));
}

/** Every `--color-*` declaration in a block, keyed by token name, with its raw value. */
function colorTokens(block: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/(--color-[\w-]+)\s*:\s*([^;]+);/g)) {
    if (name !== undefined && value !== undefined) {
      tokens.set(name, value.trim());
    }
  }
  return tokens;
}

/** A plain `#rgb`, `#rrggbb`, or opaque `#rrggbbff` value as six lowercase digits; undefined otherwise. */
function plainHex(value: string): string | undefined {
  const digits = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{6}ff)$/i.exec(value)?.[1]?.toLowerCase();
  if (digits === undefined) {
    return undefined;
  }
  return digits.length === 3 ? digits.replaceAll(/./g, '$&$&') : digits.slice(0, 6);
}

/** sRGB hex (six digits) to OKLab. */
function oklab(hex: string): [number, number, number] {
  const [r = 0, g = 0, b = 0] = [0, 2, 4].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.412_221_470_8 * r + 0.536_332_536_3 * g + 0.051_445_992_9 * b);
  const m = Math.cbrt(0.211_903_498_2 * r + 0.680_699_545_1 * g + 0.107_396_956_6 * b);
  const s = Math.cbrt(0.088_302_461_9 * r + 0.281_718_837_6 * g + 0.629_978_700_5 * b);
  return [
    0.210_454_255_3 * l + 0.793_617_785 * m - 0.004_072_046_8 * s,
    1.977_998_495_1 * l - 2.428_592_205 * m + 0.450_593_709_9 * s,
    0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766 * s,
  ];
}

/** Perceptual distance between two hexes: OKLab Euclidean distance ×100. */
function deltaE(a: string, b: string): number {
  const [la, aa, ba] = oklab(a);
  const [lb, ab, bb] = oklab(b);
  return Math.hypot(la - lb, aa - ab, ba - bb) * 100;
}

/** A theme's tokens that are plain hexes, as [name, six-digit hex] pairs. */
function hexEntries(tokens: Map<string, string>): (readonly [string, string])[] {
  return [...tokens].flatMap(([name, value]) => {
    const hex = plainHex(value);
    return hex === undefined ? [] : [[name, hex] as const];
  });
}

const DARK = colorTokens(blockAfter('@theme {'));
/** The light theme overrides the dark tokens; anything it leaves out is inherited. */
const LIGHT = new Map([...DARK, ...colorTokens(blockAfter(":root[data-theme='light'] {"))]);
const THEMES = Object.entries({ dark: DARK, light: LIGHT });

/** ADR 0019 §1's accent, action, and attention roles, and the inline-code hue (MMR-445). */
const ROLE = /^--color-(accent|action|attention|code)(-|$)/;
const ATTENTION = /^--color-attention(-|$)/;
const isStatus = (name: string): boolean => name.startsWith('--color-status-');

/** How many status tokens a stretch of CSS declares. */
function declaredStatuses(text: string): number {
  return [...text.matchAll(/--color-status-[\w-]+\s*:/g)].length;
}

/**
 * The nearest a status token may sit to an attention token, in OKLab ΔE ×100.
 * A status this close to violet reads as "needs you" (MMR-617). The closest
 * status today, `queued`'s dark foreground, sits at 7.7. The violet
 * `under_review` replaced copied attention hexes outright (ΔE 0), its light
 * foreground sat at 3.7, and the rejected periwinkle at 4.1.
 */
const MIN_ATTENTION_DISTANCE = 6;

/**
 * ADR 0019 §1: every hue owns exactly one job, and roles never borrow each
 * other's hues. The checks compare the values styles.css declares, so every
 * status token must be a plain hex they can read, declared in a theme block.
 */
describe('status tokens never borrow a role hue (ADR 0019 §1)', () => {
  it('declares status tokens only in the two theme blocks the checks read', () => {
    const inThemes =
      declaredStatuses(blockAfter('@theme {')) +
      declaredStatuses(blockAfter(":root[data-theme='light'] {"));
    expect(inThemes).toBeGreaterThan(0);
    expect(declaredStatuses(css)).toBe(inThemes);
  });

  it.each(THEMES)('%s: every status token is a plain hex', (_theme, tokens) => {
    const statuses = [...tokens].filter(([name]) => isStatus(name));
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.filter(([, value]) => plainHex(value) === undefined)).toEqual([]);
  });

  it.each(THEMES)(
    '%s: no status token shares a hex with an accent, action, attention, or code token',
    (_theme, tokens) => {
      const hexes = hexEntries(tokens);
      const roles = hexes.filter(([name]) => ROLE.test(name));
      expect(roles.length).toBeGreaterThan(0);

      const borrowed = hexes
        .filter(([name]) => isStatus(name))
        .flatMap(([status, hex]) =>
          roles
            .filter(([, roleHex]) => roleHex === hex)
            .map(([role]) => `${status} = ${role} (#${hex})`),
        );
      expect(borrowed).toEqual([]);
    },
  );

  it.each(THEMES)(
    `%s: no status token sits within ΔE ${MIN_ATTENTION_DISTANCE} of an attention token`,
    (_theme, tokens) => {
      const hexes = hexEntries(tokens);
      const attention = hexes.filter(([name]) => ATTENTION.test(name));
      expect(attention.length).toBeGreaterThan(0);

      const near = hexes
        .filter(([name]) => isStatus(name))
        .flatMap(([status, hex]) =>
          attention
            .filter(([, violet]) => deltaE(hex, violet) < MIN_ATTENTION_DISTANCE)
            .map(([role, violet]) => `${status} ~ ${role} (ΔE ${deltaE(hex, violet).toFixed(1)})`),
        );
      expect(near).toEqual([]);
    },
  );
});

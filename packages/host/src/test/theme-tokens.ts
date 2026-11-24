// `@tailwindcss/vite` intercepts `?raw` on .css and empties it, so styles.css
// is read via fs instead of import.
// oxlint-disable-next-line import/no-nodejs-modules
import { readFileSync } from 'node:fs';

/** The console's stylesheet, as the browser reads it. */
export const css = readFileSync('src/styles.css', 'utf8');

/** The text of the block that opens at `opener`, up to its closing brace at column 0. */
export function blockAfter(opener: string): string {
  const start = css.indexOf(opener);
  if (start === -1) {
    throw new Error(`styles.css has no ${opener} block`);
  }
  return css.slice(start, css.indexOf('\n}', start));
}

/** Every `--color-*` declaration in a block, keyed by token name, with its raw value. */
export function colorTokens(block: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/(--color-[\w-]+)\s*:\s*([^;]+);/g)) {
    if (name !== undefined && value !== undefined) {
      tokens.set(name, value.trim());
    }
  }
  return tokens;
}

/** A plain `#rgb`, `#rrggbb`, or opaque `#rrggbbff` value as six lowercase digits; undefined otherwise. */
export function plainHex(value: string): string | undefined {
  const digits = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{6}ff)$/i.exec(value)?.[1]?.toLowerCase();
  if (digits === undefined) {
    return undefined;
  }
  return digits.length === 3 ? digits.replaceAll(/./g, '$&$&') : digits.slice(0, 6);
}

export const DARK = colorTokens(blockAfter('@theme {'));
/** The light theme overrides the dark tokens; anything it leaves out is inherited. */
export const LIGHT = new Map([...DARK, ...colorTokens(blockAfter(":root[data-theme='light'] {"))]);
export const THEMES = Object.entries({ dark: DARK, light: LIGHT });

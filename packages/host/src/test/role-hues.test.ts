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

/** Every `--color-*` token in a block that is a plain hex, keyed by token name. */
function hexTokens(block: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const [, name, hex] of block.matchAll(/(--color-[\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    if (name !== undefined && hex !== undefined) {
      tokens.set(name, hex.toLowerCase());
    }
  }
  return tokens;
}

const THEMES = {
  dark: blockAfter('@theme {'),
  light: blockAfter(":root[data-theme='light'] {"),
};

/** The role tokens a status hue may not borrow: ADR 0019 §1's accent, action, and attention roles, and the inline-code hue (MMR-445). */
const ROLE = /^--color-(accent|action|attention|code)(-|$)/;

/**
 * ADR 0019 §1: every hue owns exactly one job, and roles never borrow each
 * other's hues. A status dot that shares the attention hex reads as "needs
 * you" (MMR-617).
 */
describe('status hues never borrow a role hue (ADR 0019 §1)', () => {
  it.each(Object.entries(THEMES))(
    '%s: no status token shares a hex with an accent, action, attention, or code token',
    (_theme, block) => {
      const tokens = hexTokens(block);
      const roles = [...tokens].filter(([name]) => ROLE.test(name));
      const statuses = [...tokens].filter(([name]) => name.startsWith('--color-status-'));
      expect(roles.length).toBeGreaterThan(0);
      expect(statuses.length).toBeGreaterThan(0);

      const borrowed = statuses.flatMap(([status, hex]) =>
        roles
          .filter(([, roleHex]) => roleHex === hex)
          .map(([role]) => `${status} = ${role} (${hex})`),
      );
      expect(borrowed).toEqual([]);
    },
  );
});

import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { compile } from 'tailwindcss';
import { afterEach, describe, expect, it } from 'vitest';

import {
  Combobox,
  ComboboxButton,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxInput,
  ComboboxTrigger,
} from '../components/ui/combobox';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '../components/ui/select';
import { Textarea } from '../components/ui/textarea';
import { TokenInput } from '../components/ui/token-input';
import { plainHex, THEMES } from './theme-tokens';

/** WCAG 2 relative luminance of a six-digit sRGB hex. */
function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [0, 2, 4].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio between two six-digit hexes. */
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/** The token a class list sets with `prefix` (`bg-`, `data-[disabled]:text-`); undefined when none. */
function tokenOf(element: HTMLElement, prefix: string): string | undefined {
  const name = element.className
    .split(/\s+/)
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
  return name === undefined ? undefined : `--color-${name}`;
}

/** A distinct color per token the field edge and ink use, so a computed color names its token. */
const STUB_TOKENS = {
  accent: 'rgb(0, 0, 1)',
  'ink-bright': 'rgb(0, 0, 2)',
  'ink-dim': 'rgb(0, 0, 3)',
  'ink-faint': 'rgb(0, 0, 4)',
  'ink-ghost': 'rgb(0, 0, 5)',
  'status-blocked': 'rgb(0, 0, 6)',
  'well-950': 'rgb(0, 0, 7)',
} as const;

/** The token whose stub color `color` is; undefined for any other color. */
function stubToken(color: string): string | undefined {
  return Object.entries(STUB_TOKENS).find(([, value]) => value === color)?.[0];
}

/** Build the page's classes as Tailwind does, over the stub tokens, and apply them. */
async function applyBuiltCss(): Promise<void> {
  const classes = [...document.querySelectorAll('[class]')].flatMap((element) =>
    (element.getAttribute('class') ?? '').split(/\s+/),
  );
  const theme = Object.entries(STUB_TOKENS)
    .map(([name, value]) => `--color-${name}: ${value};`)
    .join(' ');
  const compiler = await compile(`@theme inline { ${theme} } @tailwind utilities;`, {});
  const style = document.createElement('style');
  style.dataset.built = '';
  style.textContent = compiler.build(classes);
  document.head.append(style);
}

afterEach(() => {
  document.head.querySelector('style[data-built]')?.remove();
});

/** Each field primitive, disabled, holding a value. */
const FIELDS: [string, () => ReactElement][] = [
  ['Input', () => <Input aria-label="Field" defaultValue="feat/home-feed" disabled />],
  ['Textarea', () => <Textarea aria-label="Field" defaultValue="A stored note" disabled />],
  [
    'Select trigger',
    () => (
      <Select items={[{ label: 'Done', value: 'done' }]} defaultValue="done" disabled>
        <SelectTrigger aria-label="Field" />
        <SelectContent>
          <SelectItem value="done">Done</SelectItem>
        </SelectContent>
      </Select>
    ),
  ],
  [
    'Combobox button',
    () => (
      <Combobox disabled>
        <ComboboxButton aria-label="Field">MMR-12 Ship it</ComboboxButton>
      </Combobox>
    ),
  ],
];

/** Render one field and return its control, the element that carries `data-disabled`. */
function renderField(field: () => ReactElement): HTMLElement {
  render(field());
  const control = screen.getByLabelText('Field');
  expect(control).toHaveAttribute('data-disabled');
  return control;
}

/**
 * DESIGN.md, Color roles (MMR-777): a disabled field is quiet, not faded, as a
 * disabled commit is. Its value stays in ink-dim at full opacity, so what is
 * set still reads at 4.5:1; only its edge (ink-ghost) and glyph (ink-faint)
 * step down. The 40% fade once took the value to about 2.4:1 on light.
 */
describe('a disabled field keeps its value readable (quiet disabled)', () => {
  it.each(FIELDS)('%s draws quiet rather than faded', async (_name, field) => {
    const control = renderField(field);
    const classes = control.className.split(/\s+/);
    expect(classes.filter((value) => value.startsWith('data-[disabled]:opacity-'))).toEqual([]);
    expect(classes).toContain('data-[disabled]:cursor-not-allowed');
    await applyBuiltCss();
    expect(stubToken(getComputedStyle(control).color)).toBe('ink-dim');
    expect(stubToken(getComputedStyle(control).borderTopColor)).toBe('ink-ghost');
  });

  it('a Select’s chevron steps down to ink-faint', () => {
    const trigger = renderField(FIELDS[2]![1]);
    expect(trigger.className.split(/\s+/)).toContain('data-[disabled]:[&_svg]:text-ink-faint');
  });

  describe.each(THEMES)('%s', (_theme, tokens) => {
    it.each(FIELDS)('%s: its value measures 4.5:1 or better on its ground', (_name, field) => {
      const control = renderField(field);
      const value = plainHex(tokens.get(tokenOf(control, 'data-[disabled]:text-') ?? '') ?? '');
      const ground = plainHex(tokens.get(tokenOf(control, 'bg-') ?? '') ?? '');
      expect(value).toBeDefined();
      expect(ground).toBeDefined();
      expect(contrast(value ?? '', ground ?? '')).toBeGreaterThanOrEqual(4.5);
    });
  });
});

/** Each field primitive that can be invalid, disabled and invalid; the returned element draws the edge. */
const INVALID_FIELDS: [string, () => HTMLElement][] = [
  [
    'Input',
    () => {
      render(<Input aria-label="Field" defaultValue="x" aria-invalid disabled />);
      return screen.getByLabelText('Field');
    },
  ],
  [
    'Textarea',
    () => {
      render(<Textarea aria-label="Field" defaultValue="x" aria-invalid disabled />);
      return screen.getByLabelText('Field');
    },
  ],
  [
    'Combobox input',
    () => {
      render(
        <Combobox disabled>
          <ComboboxInput aria-label="Field" aria-invalid />
        </Combobox>,
      );
      return screen.getByLabelText('Field');
    },
  ],
  [
    'Combobox chips',
    () => {
      render(
        <Combobox multiple disabled>
          <ComboboxChips data-testid="chips">
            <ComboboxChipsInput aria-label="Field" aria-invalid />
          </ComboboxChips>
        </Combobox>,
      );
      return screen.getByTestId('chips');
    },
  ],
];

describe('a disabled field that is invalid keeps its blocked edge (MMR-777)', () => {
  it.each(INVALID_FIELDS)('%s', async (_name, field) => {
    const edge = field();
    expect(edge).toHaveAttribute('data-disabled');
    await applyBuiltCss();
    expect(stubToken(getComputedStyle(edge).borderTopColor)).toBe('status-blocked');
  });
});

describe('the parts of a disabled picker draw quiet (MMR-777)', () => {
  it('the Combobox chevron toggle steps down to ink-faint', async () => {
    render(
      <Combobox disabled>
        <div className="relative">
          <ComboboxInput aria-label="Field" />
          <ComboboxTrigger aria-label="Show tasks" />
        </div>
      </Combobox>,
    );
    const toggle = screen.getByRole('button', { name: 'Show tasks' });
    expect(toggle).toHaveAttribute('data-disabled');
    await applyBuiltCss();
    expect(stubToken(getComputedStyle(toggle).color)).toBe('ink-faint');
    expect(getComputedStyle(toggle).opacity).not.toMatch(/^0\./);
  });

  it('the chips input draws its text in ink-dim', async () => {
    render(
      <Combobox multiple disabled>
        <ComboboxChips>
          <ComboboxChipsInput aria-label="Field" />
        </ComboboxChips>
      </Combobox>,
    );
    const input = screen.getByLabelText('Field');
    expect(input).toHaveAttribute('data-disabled');
    await applyBuiltCss();
    expect(stubToken(getComputedStyle(input).color)).toBe('ink-dim');
  });

  it('Token Input draws its value in ink-dim', async () => {
    render(<TokenInput aria-label="Field" defaultValue={['console']} disabled />);
    const editor = screen.getByLabelText('Field');
    expect(editor).toHaveAttribute('data-disabled');
    await applyBuiltCss();
    expect(stubToken(getComputedStyle(editor).color)).toBe('ink-dim');
  });
});

import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { apply, resolve, setTheme, storedChoice, systemTheme } from '../lib/theme';

/** Stub `matchMedia` so the prefers-color-scheme query resolves deterministically. */
function mockOS(prefersLight: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    addEventListener: () => {},
    matches: q.includes('light') ? prefersLight : !prefersLight,
    media: q,
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  if (document.querySelector('meta[name="theme-color"]') === null) {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('theme resolution (MMR-74)', () => {
  it('storedChoice accepts only the valid values', () => {
    expect(storedChoice()).toBeNull();
    localStorage.setItem('mimir-theme', 'light');
    expect(storedChoice()).toBe('light');
    localStorage.setItem('mimir-theme', 'bogus');
    expect(storedChoice()).toBeNull();
  });

  it('systemTheme reads the OS preference', () => {
    mockOS(true);
    expect(systemTheme()).toBe('light');
    mockOS(false);
    expect(systemTheme()).toBe('dark');
  });

  it('resolve: an explicit pick wins over the OS', () => {
    mockOS(true); // OS says light
    localStorage.setItem('mimir-theme', 'dark');
    expect(resolve()).toBe('dark');
  });

  it('resolve: with no pick, follow the OS', () => {
    mockOS(true);
    expect(resolve()).toBe('light');
    mockOS(false);
    expect(resolve()).toBe('dark');
  });

  it('setTheme persists the pick and reflects it on the document', () => {
    setTheme('light');
    expect(localStorage.getItem('mimir-theme')).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      '#e9edf3',
    );
  });

  it('apply sets data-theme without persisting', () => {
    apply('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('mimir-theme')).toBeNull();
  });
});

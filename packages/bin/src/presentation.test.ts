/**
 * Presentation primitives (MMR-308) — `FORMATS`/`Io` plus the color/glyph
 * helpers every command surface reaches for directly. These were extracted
 * from `cli/render.ts` into this shared module so `doctor`, `service`, and
 * `vault` command handlers can use them without importing the CLI transport.
 */
import { expect, test } from 'bun:test';

import { arrow, bold, color, FORMATS, ok, warn } from './presentation';
import type { Io } from './presentation';

function fakeIo(overrides: Partial<Io> = {}): Io & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    err,
    error: (s) => err.push(s),
    isTTY: false,
    out,
    plain: true,
    write: (s) => out.push(s),
    ...overrides,
  };
}

// ─── FORMATS ────────────────────────────────────────────────────────────────

test('FORMATS enumerates exactly the five output formats, table first', () => {
  expect(FORMATS).toEqual(['table', 'records', 'ids', 'json', 'jsonl']);
});

// ─── color ──────────────────────────────────────────────────────────────────

test('color wraps text in the requested ANSI code when not plain', () => {
  expect(color('hi', 36, false)).toBe('\x1b[36mhi\x1b[0m');
});

test('color passes text through untouched when plain', () => {
  expect(color('hi', 36, true)).toBe('hi');
});

test('color renders an empty string without producing bare escape codes', () => {
  expect(color('', 31, false)).toBe('\x1b[31m\x1b[0m');
  expect(color('', 31, true)).toBe('');
});

// ─── bold ───────────────────────────────────────────────────────────────────

test('bold wraps text in ANSI bold when not plain', () => {
  expect(bold('usage:', false)).toBe('\x1b[1musage:\x1b[0m');
});

test('bold passes text through untouched when plain', () => {
  expect(bold('usage:', true)).toBe('usage:');
});

// ─── arrow ──────────────────────────────────────────────────────────────────

test('arrow is the unicode glyph when not plain', () => {
  expect(arrow(false)).toBe('→');
});

test('arrow degrades to ASCII when plain (--ascii/NO_COLOR)', () => {
  expect(arrow(true)).toBe('->');
});

// ─── ok ─────────────────────────────────────────────────────────────────────

test('ok writes the ascii [ok] glyph + message to stdout when plain', () => {
  const io = fakeIo({ plain: true });
  ok(io, 'created MMR-5');
  expect(io.out).toEqual(['[ok] created MMR-5']);
  expect(io.err).toEqual([]);
});

test('ok writes the colored check glyph + message to stdout when not plain', () => {
  const io = fakeIo({ plain: false });
  ok(io, 'created MMR-5');
  expect(io.out).toEqual(['\x1b[32m✓\x1b[0m created MMR-5']);
});

test('ok never touches stderr', () => {
  const io = fakeIo();
  ok(io, 'anything');
  expect(io.err).toHaveLength(0);
});

// ─── warn ───────────────────────────────────────────────────────────────────

test('warn writes the ascii [warn] glyph + message to stderr when plain', () => {
  const io = fakeIo({ plain: true });
  warn(io, 'snapshot interval unset');
  expect(io.err).toEqual(['[warn] snapshot interval unset']);
  expect(io.out).toEqual([]);
});

test('warn writes the colored warning glyph + message to stderr when not plain', () => {
  const io = fakeIo({ plain: false });
  warn(io, 'snapshot interval unset');
  expect(io.err).toEqual(['\x1b[33m⚠\x1b[0m snapshot interval unset']);
});

test('warn never touches stdout', () => {
  const io = fakeIo();
  warn(io, 'anything');
  expect(io.out).toHaveLength(0);
});
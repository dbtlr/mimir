/**
 * Coverage for the shared `fakeIo` test helper (MMR-308: `Io` now lives in
 * `presentation.ts`; `fakeIo` implements that same shape). Every other CLI
 * test file leans on this helper, so its own contract — capturing output,
 * the `plain` default, and the `isTTY`/`plain` overrides — is worth pinning
 * down directly.
 */
import { expect, test } from 'bun:test';

import { fakeIo } from './testing';

test('fakeIo defaults to a non-TTY, plain sink', () => {
  const io = fakeIo();
  expect(io.isTTY).toBe(false);
  expect(io.plain).toBe(true);
  expect(io.out).toEqual([]);
  expect(io.err).toEqual([]);
});

test('fakeIo(true) reports isTTY true but still defaults plain to true', () => {
  const io = fakeIo(true);
  expect(io.isTTY).toBe(true);
  expect(io.plain).toBe(true);
});

test('fakeIo write() appends to `out` in call order', () => {
  const io = fakeIo();
  io.write('first');
  io.write('second');
  expect(io.out).toEqual(['first', 'second']);
  expect(io.err).toEqual([]);
});

test('fakeIo error() appends to `err` in call order, independent of `out`', () => {
  const io = fakeIo();
  io.error('uh oh');
  io.write('fine');
  io.error('again');
  expect(io.err).toEqual(['uh oh', 'again']);
  expect(io.out).toEqual(['fine']);
});

test('fakeIo({ plain: false }) opts into the color path alongside a real isTTY', () => {
  const io = fakeIo(true, { plain: false });
  expect(io.isTTY).toBe(true);
  expect(io.plain).toBe(false);
});

test('fakeIo({ plain: false }) on a non-TTY still honors the explicit override', () => {
  const io = fakeIo(false, { plain: false });
  expect(io.isTTY).toBe(false);
  expect(io.plain).toBe(false);
});

test('each fakeIo() call returns an independent sink (no shared mutable state)', () => {
  const a = fakeIo();
  const b = fakeIo();
  a.write('only in a');
  expect(a.out).toEqual(['only in a']);
  expect(b.out).toEqual([]);
});
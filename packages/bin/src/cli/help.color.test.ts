/**
 * MMR-300 — color/plain regression for the help renderer. The hard rule is
 * byte-identical plain output (color is pure decoration, per render.ts's
 * `plain` contract); these tests force the color path (the test harness
 * itself runs non-TTY, so nothing else here exercises it) and assert ANSI
 * wraps only the expected tokens while the stripped content matches plain.
 */
import { expect, test } from 'bun:test';

import { helpForCommand, renderFullHelp, renderTerseHelp, TERSE_HELP } from './help';

// oxlint-disable-next-line eslint/no-control-regex -- matching the ANSI escapes render.ts emits is the point of this test.
const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI, '');

test('plain root help is byte-identical to the raw template (MMR-300)', () => {
  expect(renderTerseHelp(true)).toBe(TERSE_HELP);
});

test('colored root help carries ANSI but strips back to the plain text exactly (MMR-300)', () => {
  const plain = renderTerseHelp(true);
  const colored = renderTerseHelp(false);
  expect(colored).not.toBe(plain);
  expect(colored).toContain('\x1b['); // color actually rendered
  expect(stripAnsi(colored)).toBe(plain);
});

test('colored root help bolds the usage label and section headers (MMR-300)', () => {
  const colored = renderTerseHelp(false);
  expect(colored).toContain('\x1b[1musage:\x1b[0m');
  expect(colored).toContain('\x1b[1moptions:\x1b[0m');
  expect(colored).toContain('\x1b[1m  read:\x1b[0m');
});

test('colored root help highlights a bare command name and a flag token (MMR-300)', () => {
  const colored = renderTerseHelp(false);
  // "next" leads its verb row in the read: group.
  expect(colored).toContain('\x1b[36mnext\x1b[0m');
  // "-s, --scope <KEY>" — the flag portion of the label is colored, not the whole row.
  expect(colored).toContain('\x1b[36m-s\x1b[0m');
  expect(colored).toContain('\x1b[36m--scope\x1b[0m');
});

test('colored full help round-trips to the plain FULL_HELP text (MMR-300)', () => {
  const plain = renderFullHelp(true);
  const colored = renderFullHelp(false);
  expect(colored).toContain('\x1b[');
  expect(stripAnsi(colored)).toBe(plain);
});

test('per-command help: plain is unchanged, colored strips back to plain (MMR-300)', () => {
  const plain = helpForCommand('get', undefined, true, true);
  const colored = helpForCommand('get', undefined, true, false);
  if (plain === undefined || colored === undefined) {
    throw new Error('expected a COMMAND_HELP descriptor for `get`');
  }
  expect(colored).not.toBe(plain);
  expect(colored).toContain('\x1b['); // color actually rendered
  expect(stripAnsi(colored)).toBe(plain);
  // usage line bold, flag label colored, description left plain.
  expect(colored).toContain('\x1b[1mmimir get <id>\x1b[0m');
  expect(colored).toContain('\x1b[1mflags:\x1b[0m');
  expect(colored.includes('full record: task/phase/initiative')).toBe(true);
});

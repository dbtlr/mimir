import { expect, test } from 'bun:test';

import { SERVE_LABEL, mayDrive, unitLabels } from './units';
import type { SupervisorScope } from './units';

const SANDBOX_ID = '1234abcd-1234-4234-8234-123456789012';
const OTHER_SANDBOX_ID = '87654321-4321-4321-8321-210987654321';
const live: SupervisorScope = { kind: 'live' };
const sandbox: SupervisorScope = { id: SANDBOX_ID, kind: 'sandbox' };
const none: SupervisorScope = { kind: 'none' };

test('a live installation keeps the existing unit names, so installed units need no migration', () => {
  expect(unitLabels(live)).toEqual({ serve: 'com.dbtlr.mimir.serve' });
  expect(SERVE_LABEL).toBe('com.dbtlr.mimir.serve');
});

test('a sandbox installation derives unit names scoped to its own sandbox id', () => {
  expect(unitLabels(sandbox)).toEqual({ serve: `com.dbtlr.mimir.sandbox-${SANDBOX_ID}.serve` });
});

test('a sandbox id that is not a UUID never becomes part of a unit name', () => {
  for (const id of ['../escape', '', 'SANDBOX', `${SANDBOX_ID}.serve`]) {
    expect(() => unitLabels({ id, kind: 'sandbox' })).toThrow('sandbox id');
  }
});

test('an uppercase sandbox id names the same units as its lowercase form', () => {
  expect(unitLabels({ id: SANDBOX_ID.toUpperCase(), kind: 'sandbox' })).toEqual(
    unitLabels(sandbox),
  );
});

test('a live installation may drive only the live unit names', () => {
  expect(mayDrive(live, SERVE_LABEL)).toBe(true);
  expect(mayDrive(live, unitLabels(sandbox).serve)).toBe(false);
  expect(mayDrive(live, 'com.example.other')).toBe(false);
});

test('a sandbox installation may drive only its own units — never live or another sandbox', () => {
  expect(mayDrive(sandbox, unitLabels(sandbox).serve)).toBe(true);
  expect(mayDrive(sandbox, SERVE_LABEL)).toBe(false);
  expect(mayDrive(sandbox, unitLabels({ id: OTHER_SANDBOX_ID, kind: 'sandbox' }).serve)).toBe(
    false,
  );
});

test('a process without an installation may drive no unit at all', () => {
  expect(mayDrive(none, SERVE_LABEL)).toBe(false);
  expect(mayDrive(none, unitLabels(sandbox).serve)).toBe(false);
});

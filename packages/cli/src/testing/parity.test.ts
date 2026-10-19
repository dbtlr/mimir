import { expect, test } from 'bun:test';

import { createApp } from '../app';
import type { ParityDifference } from '../parity/differences';
import { boundClone } from './fixture';
import { parityProblems, underJson } from './parity';
import type { ParityCase, ParityRun } from './parity';

/** The rule's failure paths never open the store. */
const app = createApp({
  git: boundClone(undefined),
  store: () => Promise.reject(new Error('the store is not read')),
});
const c: ParityCase = { name: 'get (no id)', path: ['get'] };
const voice: ParityDifference[] = [{ case: c.name, kind: 'loom-voice', reason: 'parser' }];
const refusal: ParityDifference[] = [{ case: c.name, kind: 'loom-refusal', reason: 'strict' }];

const oldUsage: ParityRun = {
  exitCode: 2,
  failure: { code: 'usage', hints: ["run 'mimir get -h'"], message: 'get needs an id' },
  stdout: '',
};
const loomFault = (exitCode = 2): ParityRun => ({
  exitCode,
  failure: { code: 'missing-argument', hints: [], message: 'Argument "id" is required.' },
  stdout: '',
});

test('a loom-voice entry holds when Loom raises the failure in its own voice', () => {
  expect(parityProblems(app, c, oldUsage, loomFault(), voice)).toEqual([]);
});

test('a loom-voice entry over a failure Mimir raises is refused', () => {
  const mimir: ParityRun = {
    exitCode: 2,
    failure: { code: 'usage', hints: [], message: 'get needs one id' },
    stdout: '',
  };
  expect(parityProblems(app, c, oldUsage, mimir, voice)).toEqual([
    'a Loom difference entry names a failure Mimir raises (usage); the rule compares it',
  ]);
});

test('a loom-voice entry over matching failures is stale', () => {
  expect(parityProblems(app, c, loomFault(), loomFault(), voice)).toEqual([
    'a loom-voice entry names failures that match; remove it',
  ]);
});

test('a loom-voice entry still compares exit codes', () => {
  expect(parityProblems(app, c, oldUsage, loomFault(1), voice)).toEqual([
    'exit code: old 2, new 1',
  ]);
});

const scoped: ParityDifference[] = [{ case: c.name, kind: 'loom-scoped', reason: 'scoped' }];
const engine: ParityDifference[] = [{ case: c.name, kind: 'engine-refusal', reason: 'engine' }];
const oldValidation: ParityRun = {
  exitCode: 1,
  failure: {
    code: 'validation',
    hints: [],
    message: 'groomed applies only to tasks',
  },
  stdout: '',
};
const engineRefused: ParityRun = {
  exitCode: 1,
  failure: {
    code: 'validation',
    hints: [],
    message: 'content must not be blank',
  },
  stdout: '',
};

test('a loom-scoped entry holds when Loom refuses at exit 2 what the old CLI refused at exit 1', () => {
  expect(parityProblems(app, c, oldValidation, loomFault(), scoped)).toEqual([]);
});

test('a loom-scoped entry over an old success, or a new Mimir code, is refused', () => {
  expect(parityProblems(app, c, { exitCode: 0, stdout: 'x\n' }, loomFault(), scoped)).toEqual([
    'a loom-scoped entry names a case the old CLI exits 0 for, not 1',
  ]);
  expect(parityProblems(app, c, oldValidation, engineRefused, scoped)).toEqual([
    'a loom-scoped refusal exits 2, not 1',
    'a Loom difference entry names a failure Mimir raises (validation); the rule compares it',
  ]);
});

test('an engine-refusal entry holds when the Engine refuses what the old CLI accepted', () => {
  const accepted: ParityRun = { exitCode: 0, stdout: 'x\n' };
  expect(parityProblems(app, c, accepted, engineRefused, engine)).toEqual([]);
});

test('an engine-refusal entry over a case the old CLI refused, or the new one accepts, is refused', () => {
  const accepted: ParityRun = { exitCode: 0, stdout: 'x\n' };
  expect(parityProblems(app, c, oldValidation, engineRefused, engine)).toEqual([
    'an engine-refusal entry names a case the old CLI refused too (exit 1)',
  ]);
  expect(parityProblems(app, c, accepted, accepted, engine)).toEqual([
    'an engine-refusal entry needs the new CLI to refuse with a Mimir code at exit 1, not exit 0',
  ]);
});

test('a loom-refusal entry holds when Loom refuses what the old CLI accepted', () => {
  const accepted: ParityRun = { exitCode: 0, stdout: 'MMR-3\n' };
  expect(parityProblems(app, c, accepted, loomFault(), refusal)).toEqual([]);
});

test('a loom-refusal entry over a case the old CLI also refused is refused', () => {
  expect(parityProblems(app, c, oldUsage, loomFault(), refusal)).toEqual([
    'a loom-refusal entry names a case the old CLI refused too (exit 2); use loom-voice',
  ]);
});

test('a loom-refusal entry over a case the new CLI accepts is stale', () => {
  const accepted: ParityRun = { exitCode: 0, stdout: 'MMR-3\n' };
  expect(parityProblems(app, c, accepted, accepted, refusal)).toEqual([
    'a loom-refusal entry names a case the new CLI accepts (exit 0); remove it',
  ]);
});

const boardRead: ParityDifference[] = [{ case: c.name, kind: 'board-read', reason: 'one board' }];
const printed = (...ids: string[]): ParityRun => ({ exitCode: 0, stdout: `${ids.join('\n')}\n` });

test('a board-read entry holds when the new ids are a subset of the old ids', () => {
  expect(parityProblems(app, c, printed('MMR-1', 'XX-1'), printed('MMR-1'), boardRead)).toEqual([]);
});

test('a board-read entry refuses a new id the old read never showed', () => {
  expect(parityProblems(app, c, printed('MMR-1'), printed('MMR-1', 'XX-9'), boardRead)).toEqual([
    'a board-read entry needs the new ids within the old ids; extra: XX-9',
  ]);
});

const newView: ParityDifference[] = [{ case: c.name, kind: 'new-view', reason: 'jsonl' }];
const json: ParityRun = { exitCode: 0, stdout: '{\n  "id": "MMR-3"\n}\n' };

test('a new-view entry holds when each line is the compact form of the json document', () => {
  const line: ParityRun = { exitCode: 0, stdout: '{"id":"MMR-3"}\n' };
  expect(parityProblems(app, c, oldUsage, line, newView, json)).toEqual([]);
});

test('a new-view entry refuses a line that is not the json document compacted', () => {
  const other: ParityRun = { exitCode: 0, stdout: '{"id":"MMR-4"}\n' };
  expect(parityProblems(app, c, oldUsage, other, newView, json)).toEqual([
    'a new-view entry needs every output line to be the compact form of its -f json document',
  ]);
});

const stray: ParityDifference[] = [{ case: c.name, kind: 'stray-refusal', reason: 'stray words' }];
const strayCase: ParityCase = { argv: ['park', 'MMR-1', '--', 'x', 'y'], name: c.name, path: [] };
const accepted: ParityRun = { exitCode: 0, stdout: '' };
const strayRefused = (
  over: Partial<ParityRun> = {},
  message = 'unexpected argument: x y',
): ParityRun => ({
  exitCode: 2,
  failure: { code: 'usage', hints: [], message },
  stdout: '',
  ...over,
});

test('a stray-refusal entry holds when the old CLI accepted and the new one refuses the words', () => {
  expect(parityProblems(app, strayCase, accepted, strayRefused(), stray)).toEqual([]);
});

test('a stray-refusal entry refuses an old CLI that failed', () => {
  expect(parityProblems(app, strayCase, oldUsage, strayRefused(), stray)).toEqual([
    'a stray-refusal entry names a case the old CLI refused (exit 2)',
  ]);
});

test('a stray-refusal entry refuses a new exit other than 2', () => {
  expect(parityProblems(app, strayCase, accepted, strayRefused({ exitCode: 1 }), stray)).toEqual([
    'a stray-refusal exits 2 with code usage, not exit 1 code usage',
  ]);
});

test('a stray-refusal entry refuses a code other than usage', () => {
  const next = strayRefused({
    failure: { code: 'validation', hints: [], message: 'unexpected argument: x y' },
  });
  expect(parityProblems(app, strayCase, accepted, next, stray)).toEqual([
    'a stray-refusal exits 2 with code usage, not exit 2 code validation',
  ]);
});

test('a stray-refusal entry refuses a message that does not name the stray words', () => {
  expect(
    parityProblems(app, strayCase, accepted, strayRefused({}, 'unexpected argument: x'), stray),
  ).toEqual([
    'a stray-refusal message is "unexpected argument: x y", not "unexpected argument: x"',
  ]);
});

test('underJson puts --format json before the first --', () => {
  expect(underJson(['reject', 'MMR-s1', '--', '--out', 'of'])).toEqual([
    'reject',
    'MMR-s1',
    '--format',
    'json',
    '--',
    '--out',
    'of',
  ]);
  expect(underJson(['reject', 'MMR-s1', '--'])).toEqual([
    'reject',
    'MMR-s1',
    '--format',
    'json',
    '--',
  ]);
});

test('underJson rewrites a named format and appends to an argv without --', () => {
  expect(underJson(['list', '-f', 'table', '--', 'x'])).toEqual(['list', '-f', 'json', '--', 'x']);
  expect(underJson(['list'])).toEqual(['list', '--format', 'json']);
});

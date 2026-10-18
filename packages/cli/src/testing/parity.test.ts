import { expect, test } from 'bun:test';

import { createApp } from '../app';
import type { ParityDifference } from '../parity/differences';
import { boundClone } from './fixture';
import { parityProblems } from './parity';
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

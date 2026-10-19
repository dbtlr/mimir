import { expect, test } from 'bun:test';

import { Application, Command } from '@loomcli/core';
import { MimirError } from '@mimir/contract';
import type { ErrorCode } from '@mimir/contract';

import { failures, MimirUsageError } from './failures';

function throwing(error: Error) {
  return new Application('mimir', { description: 'A probe.', plugins: [failures()] }).command(
    new Command('fail', { description: 'Throw.' }).action(() => {
      throw error;
    }),
  );
}

const form = async (error: Error) => {
  const outcome = await throwing(error).invoke(['fail'], {});
  return outcome.status === 'failed' ? outcome.form : outcome;
};

test.each<[ErrorCode, string]>([
  ['not_found', 'not-found'],
  ['validation', 'validation'],
  ['conflict', 'conflict'],
  ['invariant', 'invariant'],
])('a %s refusal exits 1 with the code %s and its hint', async (code, kebab) => {
  expect(await form(new MimirError(code, 'MMR-9 refused', 'try MMR-1'))).toEqual({
    code: kebab,
    exitCode: 1,
    hints: ['try MMR-1'],
    message: 'MMR-9 refused',
  });
});

test('a refusal without a hint carries no hint line', async () => {
  expect(await form(new MimirError('not_found', "MMR-9 doesn't exist"))).toEqual({
    code: 'not-found',
    exitCode: 1,
    hints: [],
    message: "MMR-9 doesn't exist",
  });
});

test('a Mimir usage error exits 2 with the code usage', async () => {
  expect(await form(new MimirUsageError('next needs a project', 'pass -s KEY'))).toEqual({
    code: 'usage',
    exitCode: 2,
    hints: ['pass -s KEY'],
    message: 'next needs a project',
  });
});

test('a foreign throw stays an internal failure', async () => {
  expect(await form(new TypeError('boom'))).toMatchObject({ code: 'internal', exitCode: 1 });
});

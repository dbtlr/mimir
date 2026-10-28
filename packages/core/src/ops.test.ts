import { expect, test } from 'bun:test';

import type { OpFact } from '@mimir/contract';

import { specUpdateFields } from './field-spec';
import { assertOpFields, OP_SPECS } from './ops';

/**
 * The legality of an operation's extra-args fact (ADR 0026): `assertOpFields`
 * refuses what a project subject's arms would silently drop, and
 * `specUpdateFields` refuses a key the generic `update` does not own. The live
 * table can never reach either branch, so the cases use synthetic facts.
 */
const projectFact: OpFact = {
  fields: ['host'],
  reason: 'none',
  subject: 'project',
  summary: 'freeze a project',
  transition: { axis: 'archive', from: 'active', to: 'archived' },
};

test('the registry refuses extra data-plane fields on a project subject', () => {
  expect(() => assertOpFields('freeze', projectFact)).toThrow(
    /declares data-plane fields on a project subject/,
  );
  // The guard is exactly this combination: a task subject, or no fields, passes.
  expect(() => assertOpFields('claim', { ...projectFact, subject: 'task' })).not.toThrow();
  expect(() => assertOpFields('freeze', { ...projectFact, fields: [] })).not.toThrow();
});

test('the registry refuses a choice argument on a project subject', () => {
  const fact: OpFact = {
    choice: { name: 'on', summary: 'who', values: ['you', 'others'] },
    reason: 'none',
    subject: 'project',
    summary: 'freeze a project',
    transition: { axis: 'archive', from: 'active', to: 'archived' },
  };
  expect(() => assertOpFields('freeze', fact)).toThrow(
    /declares a choice argument on a project subject/,
  );
  expect(() => assertOpFields('claim', { ...fact, subject: 'task' })).not.toThrow();
});

test('every live operation passes the guard', () => {
  for (const spec of OP_SPECS) {
    expect(() => assertOpFields(spec.verb, spec)).not.toThrow();
  }
});

test('an operation may only name data-plane fields the generic update owns', () => {
  expect(() => specUpdateFields(['grooming'])).toThrow(/has no generic-update arg to derive/);
  expect(specUpdateFields(['host']).map(({ key }) => key)).toEqual(['host']);
});

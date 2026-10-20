import { expect, test } from 'bun:test';

import { inapplicableUpdateFields } from '@mimir/core';

import { foreignFields } from './update';

/** The flags core's update fields are spelled as; the rest derive as `--<kebab-key>`. */
const FLAG_OVERRIDES: Readonly<Record<string, readonly string[]>> = {
  description: ['desc'],
  externalRef: ['ref'],
  next: ['direction'],
  openEnded: ['open-ended', 'not-open-ended'],
};

const flagsOf = (field: string): readonly string[] =>
  FLAG_OVERRIDES[field] ?? [field.replaceAll(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)];

// A field core adds to the update vocabulary has no flag here until update owns or refuses it.
test.each(['artifact', 'project', 'seed'] as const)(
  'update refuses exactly the fields core says do not apply to a %s',
  (kind) => {
    const expected: string[] = inapplicableUpdateFields(kind).flatMap(flagsOf);
    const refused: string[] = foreignFields(kind);
    expect(refused).toEqual(expected);
  },
);

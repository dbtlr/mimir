import { expect, test } from 'vitest';

import { optionDetail } from '../components/decisions-walkthrough/model';

test('an option has no detail when the list is missing or short', () => {
  expect(optionDetail({}, 1)).toBeNull();
  expect(optionDetail({ option_details: [null, 'Context'] }, 2)).toBe('Context');
  expect(optionDetail({ option_details: [null] }, 2)).toBeNull();
});

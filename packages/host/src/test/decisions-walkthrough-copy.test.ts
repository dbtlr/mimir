import { expect, test } from 'vitest';

import {
  checkEffect,
  effectLine,
  reviewSetLabel,
  sendLabel,
  sendLine,
  stepButtonLabel,
} from '../components/decisions-walkthrough/copy';

test('the effect line follows the selection and the linked tasks', () => {
  expect(effectLine('confirm', [])).toBe('Confirming changes nothing.');
  expect(effectLine('confirm', ['MMR-3'])).toBe(
    'Confirming changes nothing. MMR-3 stays as built.',
  );
  expect(effectLine('confirm', ['MMR-3', 'MMR-4'])).toBe(
    'Confirming changes nothing. MMR-3, MMR-4 stay as built.',
  );
  expect(effectLine('overturn', ['MMR-3', 'MMR-4'])).toBe(
    'Overturning sends MMR-3, MMR-4 back for rework.',
  );
  expect(effectLine('overturn', [])).toBe('Overturning records this answer.');
  expect(effectLine('custom', ['MMR-3'])).toBe(
    'Your answer overturns this decision and sends MMR-3 back for rework.',
  );
  expect(effectLine('custom', [])).toBe('Your answer overturns this decision.');
});

test('the step button reads continue, review on the last decision, or send for a single one', () => {
  expect(stepButtonLabel('confirm', 'continue')).toBe('Confirm and continue');
  expect(stepButtonLabel('overturn', 'continue')).toBe('Overturn and continue');
  expect(stepButtonLabel('custom', 'continue')).toBe('Use my answer and continue');
  expect(stepButtonLabel('confirm', 'review')).toBe('Confirm and review');
  expect(stepButtonLabel('custom', 'review')).toBe('Use my answer and review');
  expect(stepButtonLabel('confirm', 'send')).toBe('Confirm and send');
  expect(stepButtonLabel('overturn', 'send')).toBe('Overturn and send');
  expect(stepButtonLabel('custom', 'send')).toBe('Send my answer');
});

test('the check step words its effect, its Send line, and its count', () => {
  expect(checkEffect('confirm', ['MMR-3'])).toBe('Nothing to redo');
  expect(checkEffect('overturn', ['MMR-3', 'MMR-4'])).toBe('Redoes MMR-3, MMR-4');
  expect(checkEffect('custom', [])).toBe('Nothing to redo');
  expect(sendLine('MMR-d3')).toBe(
    'Sending records every answer and wakes the agent on MMR-d3 once if any answer overturns.',
  );
  expect(sendLine(null)).toBe('Sending records every answer.');
  expect(sendLabel(3)).toBe('Send 3 answers');
  expect(sendLabel(1)).toBe('Send 1 answer');
});

test('the next-set link reads "Review it" for one decision and "Review them" otherwise', () => {
  expect(reviewSetLabel(1)).toBe('Review it');
  expect(reviewSetLabel(2)).toBe('Review them');
});

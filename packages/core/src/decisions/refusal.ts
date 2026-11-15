import { validation } from '../errors';
import { parseIdentity } from '../ids';

/** Refuse the decision identity before another record's write checks its fields. */
export function refuseDecisionInput(input: unknown): void {
  if (typeof input !== 'object' || input === null) {
    return;
  }
  const ids: unknown[] = [];
  if ('id' in input) {
    ids.push(input.id);
  }
  if ('ids' in input && Array.isArray(input.ids)) {
    ids.push(...input.ids);
  }
  for (const id of ids) {
    if (typeof id === 'string' && parseIdentity(id)?.kind === 'decision') {
      throw validation(
        `${id} is a decision`,
        'use get, update, confirm, or overturn; decide records a new decision',
      );
    }
  }
}

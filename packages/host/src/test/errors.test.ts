import { MimirError } from '@mimir/contract';
import { describe, expect, it } from 'vitest';

import { ApiError, isNotFound } from '../api/errors';
import { mimirErrorAdapter } from '../start';

/** A refusal as a server function delivers it: serialized on the host, rebuilt in the console. */
function acrossTheWire(error: MimirError): MimirError {
  return mimirErrorAdapter.fromSerializable(
    structuredClone(mimirErrorAdapter.toSerializable(error)),
  );
}

describe('engine refusals across a server function (MMR-537)', () => {
  it('arrive as the same MimirError, with its code, message, and hint', () => {
    const arrived = acrossTheWire(new MimirError('conflict', 'SR is taken', 'pick another key'));
    expect(arrived).toBeInstanceOf(MimirError);
    expect(arrived).toMatchObject({
      code: 'conflict',
      hint: 'pick another key',
      message: 'SR is taken',
    });
  });

  it('are the only errors the adapter claims', () => {
    expect(mimirErrorAdapter.test(new MimirError('validation', 'blank'))).toBe(true);
    // A copy of the class from another module instance is still a refusal.
    const copy = Object.assign(new Error('blank'), { code: 'validation', name: 'MimirError' });
    expect(mimirErrorAdapter.test(copy)).toBe(true);
    expect(mimirErrorAdapter.test(new Error('fetch failed'))).toBe(false);
  });

  it('count as not found when the Engine says so, as an HTTP 404 does', () => {
    expect(isNotFound(acrossTheWire(new MimirError('not_found', 'NOPE does not exist')))).toBe(
      true,
    );
    expect(isNotFound(new ApiError('GET /health → 404', 404))).toBe(true);
    expect(isNotFound(new MimirError('validation', 'blank'))).toBe(false);
    expect(isNotFound(new Error('offline'))).toBe(false);
  });
});

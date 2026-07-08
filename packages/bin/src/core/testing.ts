import { expect } from 'bun:test';

import { MimirError } from './errors';
import type { ErrorCode } from './errors';

// Mimic norn's `vault.get { section }` read of one `## <heading>` section from a
// whole body: a unit test over a hand-built body exercises the same
// `sectionBody(nornSection)` path production takes. The slicer is now production
// (the seed content read reuses it), so re-export the single implementation.
export { sliceSection } from './history-codec';

/** Assert that `run` rejects with a {@link MimirError} of the given code. */
export async function expectMimirError(
  code: ErrorCode,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (!(error instanceof MimirError)) {
      throw new Error(`expected a MimirError(${code}), got ${String(error)}`, { cause: error });
    }
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected a MimirError(${code}), but nothing was thrown`);
}

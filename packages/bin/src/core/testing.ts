import { expect } from 'bun:test';

import { MimirError } from './errors';
import type { ErrorCode } from './errors';

/**
 * Mimic norn's `vault.get { section }` read of one `## <heading>` section from a
 * whole document body — the heading line INCLUDED, through the line before the
 * next H2 (`## `) or EOF (an absent heading yields the empty string, as norn
 * warn-and-omits it). Test-only: production reads sections natively from norn and
 * strips the heading with `sectionBody`; this reproduces norn's shape so a unit
 * test over a hand-built body can exercise that same `sectionBody(nornSection)`
 * path. norn is LF-canonical, so this operates on `\n` only.
 */
export function sliceSection(body: string, heading: string): string {
  const lines = body.split('\n');
  const start = lines.indexOf(`## ${heading}`);
  if (start === -1) {
    return '';
  }
  const relEnd = lines.slice(start + 1).findIndex((line) => line.startsWith('## '));
  const through = relEnd === -1 ? lines.length : start + 1 + relEnd;
  return lines.slice(start, through).join('\n');
}

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

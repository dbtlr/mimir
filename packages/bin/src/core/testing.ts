import { expect } from "bun:test";
import { type ErrorCode, MimirError } from "./errors";

/** Assert that `run` rejects with a {@link MimirError} of the given code. */
export async function expectMimirError(
  code: ErrorCode,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(MimirError);
    expect((error as MimirError).code).toBe(code);
    return;
  }
  throw new Error(`expected a MimirError(${code}), but nothing was thrown`);
}

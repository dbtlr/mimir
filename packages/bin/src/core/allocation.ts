/**
 * Identity allocation (ADR 0006). `project.key` is the consumer-supplied scope
 * prefix; Norn allocates each immutable `node.seq` during document creation.
 * This module owns only project-key validation.
 */

const KEY_PATTERN = /^[A-Z]{2,4}$/;

/**
 * Validate a project key: every character A–Z, length 2–4. A behavioral
 * invariant the core owns.
 */
export function isValidKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

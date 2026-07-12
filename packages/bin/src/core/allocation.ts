/**
 * Allocation (ADR 0006). `project.key` is the consumer-supplied scope prefix;
 * `node.seq` is a per-project counter the core hands out — monotonic, immutable,
 * never reused. The deliberate stored value the spine allows, because it is
 * *allocation*, not derivation. The seq bump itself is a `StoreWriter` primitive
 * (`allocateSeq` / `allocateArtifactSeq`); only key validation lives here.
 */

const KEY_PATTERN = /^[A-Z]{2,4}$/;

/**
 * Validate a project key: every character A–Z, length 2–4. A behavioral
 * invariant the core owns.
 */
export function isValidKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

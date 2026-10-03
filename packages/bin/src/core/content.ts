/**
 * Body-content normalizations shared by the storage backends.
 *
 * One implementation, because the rule is a CONTRACT rather than a backend
 * detail: an artifact's frozen content reads back the same whether it came off
 * a markdown file or a text column, so the transfer document carries the same
 * bytes either way.
 */

/**
 * Strip exactly one trailing newline.
 *
 * The SQL store keeps the STRIPPED form and applies this rule at the seam, so a
 * no-trailing-newline body round-trips exactly (a trailing-newline body
 * deliberately loses that one newline — the sole content delta, benign for
 * frozen markdown) and every backend hands back the identical string for the
 * identical input.
 */
export function stripTrailingNewline(body: string): string {
  return body.endsWith('\n') ? body.slice(0, -1) : body;
}

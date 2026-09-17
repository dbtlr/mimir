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
 * Norn writes markdown with a trailing newline (POSIX convention): a body
 * lacking one gets one appended at write time, while a body already ending in
 * `\n` is written as-is. Either way the file ends in exactly one trailing `\n`,
 * so stripping one on read round-trips a no-trailing-newline body exactly (a
 * trailing-newline body deliberately loses that one newline — the sole content
 * delta, benign for frozen markdown). The Postgres backend stores the STRIPPED
 * form and applies the same rule at the seam, so both backends hand back the
 * identical string for the identical input.
 */
export function stripTrailingNewline(body: string): string {
  return body.endsWith('\n') ? body.slice(0, -1) : body;
}

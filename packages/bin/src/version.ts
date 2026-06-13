/**
 * The build's version. In CI release builds the release workflow replaces the
 * `MIMIR_BUILD_VERSION` identifier with the git tag via `bun build --define`,
 * so `--version`/`/api/health` report the exact tag the binary was built from
 * (MMR-57). Local/dev builds leave it undefined and fall back to package.json.
 * `typeof` on the (possibly undeclared) identifier is the one safe read.
 */
import pkg from "../package.json";

declare const MIMIR_BUILD_VERSION: string | undefined;

export const VERSION: string =
  typeof MIMIR_BUILD_VERSION !== "undefined" ? MIMIR_BUILD_VERSION : pkg.version;

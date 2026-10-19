/**
 * The build's version, the one source for `mimir version`, the Application's
 * `--version`, and self-update. The release workflow replaces the
 * `MIMIR_BUILD_VERSION` identifier with the git tag via `bun build --define`;
 * a source run leaves it undefined and reports the package's version.
 * `typeof` on the (possibly undeclared) identifier is the one safe read.
 */
import pkg from '../package.json';

declare const MIMIR_BUILD_VERSION: string | undefined;

export const VERSION: string =
  typeof MIMIR_BUILD_VERSION === 'undefined' ? pkg.version : MIMIR_BUILD_VERSION;

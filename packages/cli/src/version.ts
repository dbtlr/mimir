/**
 * The build's version, the one source for `mimir version`, the Application's
 * `--version`, and self-update. A release build (`loom build --release`) bakes
 * Loom's release facts into `__LOOM_RELEASE__`, whose `release.version` is the
 * package's version, which the release workflow stamps from the git tag; a
 * source or development build bakes none and reports the package's version.
 * `typeof` on the (possibly undeclared) identifier is the one safe read.
 */
import pkg from '../package.json';

declare const __LOOM_RELEASE__: { readonly release?: { readonly version: string } } | undefined;

export const VERSION: string =
  (typeof __LOOM_RELEASE__ === 'undefined' ? undefined : __LOOM_RELEASE__.release?.version) ??
  pkg.version;

/**
 * The build's version, the one source for `mimir version`, the Application's
 * `--version`, self-update, and the host bundle's fallback version. A release
 * build (`loom build --release`) bakes Loom's release facts into
 * `__LOOM_RELEASE__`, whose `release.version` is the package's version, which
 * the release workflow stamps from the git tag; a source or development build
 * bakes none and reports `developmentVersion` of the package's version.
 * `typeof` on the (possibly undeclared) identifier is the one safe read.
 */
import pkg from '../package.json';

declare const __LOOM_RELEASE__: { readonly release?: { readonly version: string } } | undefined;

/**
 * The version an untagged build reports. Between cuts package.json holds the
 * last release (`loom changelog write` sets it), so a source build names the
 * next minor's `-next` prerelease instead. That is the floor a cycle sets
 * when it raises `MIN_CLIENT` (ADR 0038), so a source CLI stays inside a
 * source host's window all cycle.
 */
export function developmentVersion(released: string): string {
  const match = /^(\d+)\.(\d+)\.\d+$/.exec(released);
  if (!match) {
    throw new Error(`package version ${released} is not a release version (MAJOR.MINOR.PATCH)`);
  }
  return `${match[1]}.${Number(match[2]) + 1}.0-next`;
}

export const VERSION: string =
  (typeof __LOOM_RELEASE__ === 'undefined' ? undefined : __LOOM_RELEASE__.release?.version) ??
  developmentVersion(pkg.version);

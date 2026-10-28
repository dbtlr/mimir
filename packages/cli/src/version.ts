/**
 * The build's version, the one source for `mimir version`, the Application's
 * `--version`, self-update, and the host bundle's fallback version. A release
 * build (`loom build --release`) bakes Loom's release facts into
 * `__LOOM_RELEASE__`, whose `release.version` is the package's version, which
 * the release workflow stamps from the git tag; a source or development build
 * bakes none and reports `developmentVersion` of the package's version.
 * `typeof` on the (possibly undeclared) identifier is the one safe read.
 */
import pkg from '../package.json' with { type: 'json' };

declare const __LOOM_RELEASE__: { readonly release?: { readonly version: string } } | undefined;

/**
 * The version an untagged build reports. Between cuts package.json holds the
 * last release (`loom changelog write` sets it), so a source build names the
 * next minor's `-next` prerelease instead. That is the floor a cycle sets
 * when it raises `MIN_CLIENT` (ADR 0038), so a source CLI stays inside a
 * source host's window all cycle. A prerelease the release workflow stamped
 * into package.json is already the build's version and passes unchanged.
 */
export function developmentVersion(packageVersion: string): string {
  if (/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(packageVersion)) {
    return packageVersion;
  }
  const release = /^(\d+)\.(\d+)\.\d+$/.exec(packageVersion);
  if (!release) {
    throw new Error(`package version ${packageVersion} is not a SemVer version`);
  }
  return `${release[1]}.${Number(release[2]) + 1}.0-next`;
}

export const VERSION: string =
  (typeof __LOOM_RELEASE__ === 'undefined' ? undefined : __LOOM_RELEASE__.release?.version) ??
  developmentVersion(pkg.version);

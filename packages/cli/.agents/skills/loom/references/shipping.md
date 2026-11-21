<!-- Managed by loom init. sha256:564f81c792048d9cd84709772d6cc03f50c13e2d5ebacaf35109d7a9c7e18ee7 -->

# Shipping a Loom application

This reference covers how to build, release, install, and update a Loom application, and which of those steps the author's own repository keeps.

## Pick the build target

`loom build` builds one target per call, under [loom build](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/toolchain/build.md#loom-build).

- **Name the target.** Without `--target`, the build compiles a binary for the host.
- **`node`** writes a JavaScript bundle: `main.js` from the entry, `application.js` from the application module, and their shared chunks. Pick it to publish to npm for operators who have Node, as the scaffold's `bin` and `build` script do. The package manager then owns updates, and self-update refuses such an install.
- **`bun`** writes the same bundle for Bun. Pick it only when the application needs Bun when it runs.
- **A compile target**, `bun-<os>-<arch>` with `-musl` on Linux, compiles a single binary that needs no runtime on the operator's machine. It is the only kind of build that `install.sh` and self-update serve. One host can compile every target. A `-baseline` or `-modern` x64 build compiles, but neither `install.sh` nor self-update fetches it.
- **`npm`** writes a launcher package and one platform package per compiled binary into `dist/npm/`, so operators install the compiled binary with their package manager, which then owns updates, under [the npm launcher packages](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/toolchain/build.md#the-npm-launcher-packages). It builds only in a package whose `loom.config.json` holds `"npm": { "launcher": true }`, compiles each binary as a release, and publishes nothing. Your workflow publishes every platform package before the launcher, which pins each one at its exact version, under [Publishing the packages](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/toolchain/build.md#publishing-the-packages).
- **Ship a distributed build.** `--build distributed` is the default. A [development build](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/release-facts.md#development-builds), such as one `--watch` writes, shows each defect's Developer Diagnostic, and a distributed one prints `<name>: Something went wrong.` instead. `service install` refuses any build that is not distributed.
- **Build through `loom build`.** A bundle built without the `__LOOM_RELEASE__` define reads as a source run, so it shows the author's detail to operators and carries no release facts. When you need another bundler, pass it the value `loom build --define` prints. Such a build carries no skills folder.
- **Ship the whole output.** A bundle includes its dependencies, `@loomcli/core` among them. A distributed bundle whose application names a skills folder also writes `loom-skills/` beside its chunks, so publish the output directory whole.

## Bake the release facts

- **Build releases with `--release`.** The build bakes `version` from `package.json`, `repository` as `owner/name` from the `repository` field or `--repository`, and `npmPackage` from the manifest's `name` when present, scope included, which `--target npm` also bakes into each platform binary. A compile target also bakes `asset` as `<name>-<platform>`, such as `notes-linux-x64-musl`. Update notices need a release build. Replacement through self-update also needs a release asset and a matching script installation record.
- **The release channel comes from the version.** Core reads the channel as the first prerelease identifier, so `1.5.0-next.2` is on `next`, and a version without one is on `stable`. Choose prerelease identifiers as the channel names operators follow with `self-update --channel <channel>`.
- **Read the facts from the host.** An action reads `host.release`, and a test supplies facts through its process handle, under [release facts](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/release-facts.md). Never import or pass them yourself.
- **Make `--version` agree.** The version plugin prints the Application's declared `version`, which is `0.0.0` unless the Application sets one, while self-update and update notices compare `host.release.version`, the `package.json` version. Set the Application's `version` from `package.json`, such as through a JSON import, so the two agree.
- **Let a bug report say which copy ran.** `version({ extended: true })` prints, under the version line, the release channel, the build, the asset, how the copy was installed, the runtime, and the platform, and one JSON object under `--format json` at a group or on a Command that declares a result, with the formatter listed ahead of it, under [Extended output](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/plugins/version.md#extended-output).

## Keep one name

The application's name appears four times. The Application's name, the `bin` key, and the name `install.sh` records under must match, and the asset prefix follows the release name when one is set:

- the Application's name, under which core reads the [installation record](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/installation-record.md);
- the `bin` key in `package.json`, which `loom build` names the binary and its asset after, unless `--name` or `loom.config.json`'s `name` key sets a release name. With the key set, the asset and the formula use the release name, while `install.sh` installs and records under the `bin` key's name, so the `bin` key must still equal the Application's name. Set the key rather than passing `--name` alone, and run `loom init --only install` after setting it, so `install.sh` requests the renamed asset;
- the asset prefix, which `install.sh` and self-update download;
- the name `loom init` renders into `install.sh`, under which the script writes `install.json`.

When the Application's name differs from the `bin` key, a binary that `install.sh` installed finds no installation, and self-update reports that it was installed some other way. Keep `bin` an object with one key equal to the Application's name, as the scaffold writes it.

## Cut the version from fragments

- Add a change fragment for each consumer-visible change, and run `loom changelog check` in CI.
- Cut with `loom changelog write` before you build a release, because `--release` bakes the `package.json` version, and the release tag is `v<version>`.
- Print the release page's body with `loom changelog notes <version>`.
- A prerelease cut, `loom changelog write --target 1.5.0-next.1`, sets the version and keeps the fragments pending until the stable cut.
- One cut can set several binaries' versions through `sharedVersion`, so they ship from one tag.
- Follow the loom-changelog skill, at `.agents/skills/loom-changelog/SKILL.md`, for the steps, and the [changelog reference](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/toolchain/changelog.md) for the rules.

## Publish the release shape

`install.sh` and self-update read one [release shape](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/toolchain/install.md#the-release-shape), which your release workflow publishes. A workflow for version 1.4.0 of `notes`, run after the cut is committed, looks like this:

```sh
for platform in darwin-arm64 linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl; do
  npx loom build --release --target "bun-$platform" --out "dist/notes-$platform"
done
(cd dist && sha256sum notes-* > SHA256SUMS)
gh release create v1.4.0 dist/notes-* dist/SHA256SUMS --notes "$(npx loom changelog notes 1.4.0)"
```

- **Name each file for its asset.** A binary's default output is `dist/<name>`, so each call would overwrite the last. The uploaded file's name must be the asset the binary baked, because self-update requests that name.
- **List every asset in `SHA256SUMS`.** A release without the file, or without a line for an asset, installs nothing.
- **Mark what is not the latest stable.** Publish a prerelease version as a GitHub prerelease, and an older line's release with `--latest=false`, so `releases/latest` stays the highest stable version.
- **Publish the platforms you support.** An operator on a platform the release lacks, such as a musl Linux without a `-musl` asset, cannot install.

## Publish a Homebrew formula

`loom release formula --checksums dist/SHA256SUMS --output <tap>/Formula/<name>.rb` writes a Homebrew formula for a published release, under [Publish a Homebrew formula](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/toolchain/install.md#publish-a-homebrew-formula). Run it at the release's tag after the GitHub Release is published, then commit the formula to your tap repository.

- **It needs four assets.** The formula uses the macOS and glibc Linux binaries on arm64 and x64, so the release publishes those four with their `SHA256SUMS`.
- **It reads `package.json`.** The repository, version, description, homepage, and license come from the manifest, and the name comes from where `loom build` reads it: `--name`, the `name` key, or the `bin` key.
- **Its test runs `--version`.** `brew test` passes only for an application that installs the version plugin.

## Install with install.sh

- **It needs a GitHub repository.** `loom init` renders the [installer script](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/toolchain/install.md) only when the `package.json` `repository` names GitHub. Otherwise it warns and writes none. Set `repository`, then run `loom init --only install`.
- **Commit it and serve it.** Give operators its raw URL to pipe into `sh`. A monorepo places it with `paths.installer`, such as at the repository root.
- **What it installs.** With no version argument, it installs the latest stable release into `$HOME/.local/bin`, never a prerelease. It verifies the asset against `SHA256SUMS` and then writes `install.json` with the method `script`, which is what lets self-update replace the binary later.
- **It is a managed file.** Do not edit it. A re-run of init re-renders it for the installed toolchain.
- **A side copy.** `install.sh --unmanaged --dir <directory>`, with a directory other than the live install's, installs a verified binary and writes no `install.json`, prints no PATH advice, and runs no post-install command, so it leaves a live install's record and self-update as they were. Run `loom init` to render it, under [A side copy](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/toolchain/install.md#a-side-copy).

## Run after install

- **Declare it in `loom.config.json`.** `postInstall.command` is the argument words the script runs the installed binary with, such as `["setup"]`, and `postInstall.message` is the text it prints last, under [the post-install command](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/toolchain/install.md#the-post-install-command). Init renders both into `install.sh` without loading the application, so run `loom init` again after changing them.
- **Nothing checks the words.** Words that route to no Command fail on the operator's install, so run them against a built binary before you release.
- **It is not fatal.** A failing command prints how to run it again, and the install still succeeds. An operator can skip it with `--skip-post-install`.
- **Self-update never runs it.** Do work that must follow an update in `afterReplace`.
- **Keep what it records in a file of your own.** Call `applicationDirectory('installation', name, host)`, under [the installation record](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/installation-record.md). It returns `{ path }` or `{ variable }`. With `path`, write the file under that directory, under a name no Loom writer uses, such as `<name>.json`. With `variable`, the directory cannot be found, so fail and name that variable, which is unset, empty, or not absolute. Self-update leaves that file in place. Never write `install.json` or a plugin's file, such as `service.json`.

## Update in place

`selfUpdate()` from `@loomcli/plugins/self-update` adds the `self-update` Command and, unless `notices: false`, update notices, under [the self-update plugin](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/plugins/self-update.md).

- **It replaces only what `install.sh` placed.** The binary must be a compile target built with `--release`, installed by the script, and unchanged since. For a Homebrew install or a global npm, pnpm, Bun, or Yarn install, which core derives from the binary's real path, the notice and the refusal name that package manager's upgrade command. A `--release` build bakes the npm package name the command needs, and without it the notice is skipped. A changed script installation says to install it again with `install.sh`.
- **Verify where the asset was built.** `selfUpdate({ attestation: attestation({ workflow: '.github/workflows/release.yml' }) })`, with `attestation` from `@loomcli/plugins/self-update/attestation`, refuses an asset without a GitHub artifact attestation from that workflow at the release tag. The application then depends on the `@sigstore/*` peers, and your release workflow adds the attestation job, under [Attestation](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/plugins/self-update.md#attestation).
- **A root that declares arguments can install it.** The `self-update` Command is a child like any other, so a word that names it routes there, and `--` passes that word as an argument.
- **`afterReplace` runs the old code.** The hook runs in the replaced process, so anything that needs the new version runs the binary at `path`. The completion, man page, and skills plugins each export a refresh that does this. Compose them in one hook:

```ts
import { Application } from "@loomcli/core";
import { completion, refreshCompletion } from "@loomcli/plugins/completion";
import { manpage, refreshManpages } from "@loomcli/plugins/manpage";
import { selfUpdate } from "@loomcli/plugins/self-update";

export const notes = new Application("notes", {
  description: "Keep notes.",
  plugins: [
    completion(),
    manpage(),
    selfUpdate({
      afterReplace: async (context) => {
        await refreshCompletion(context);
        await refreshManpages(context);
      },
    }),
  ],
});
```

- **Restart a service unit after a replace.** A [service unit](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/plugins/service.md) runs `host.program` and keeps the replaced process running, so run `path` with `service restart` from `afterReplace`. The unit runs the copy that installed it, so install the service from the installed binary.
- **A failing hook fails the run after the update line.** The new binary and its record stay.

## What your repository keeps

Loom ships no release workflow, and init writes none. Your repository owns:

- when to cut, and the commit of the cut with the refreshed lockfile;
- the build matrix and its attestation job, `SHA256SUMS`, the tag, and the GitHub Release;
- publishing to npm, and any PR guards;
- where operators fetch `install.sh` from.

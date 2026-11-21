---
name: loom-changelog
description: Use when finishing a consumer-visible change to this package or cutting its version. Add a change fragment in .changes/ for every consumer-visible change, validate it with loom changelog check, cut a version or a prerelease with loom changelog write, and print a version's release notes with loom changelog notes.
---

<!-- Managed by loom init. sha256:79392f9199177b84d92c9db7e112442d40c691966be76abc6ec8bc817d43b00e -->

# Keep the changelog

This package cuts its version from change fragments in `.changes/`. The fragment guide, `.changes/README.md`, holds the naming rules, the body grammar, and the version table. Read it before writing a fragment.

The `loom` bin is installed in the package, so run it through the package manager, such as `pnpm loom changelog check` or `npx loom changelog check`, and the package's `check` script runs `tsc --noEmit`, the linter, and the test runner.

## Record a change

1. Decide whether a consumer can see the change: a new or removed option, command, or export, changed output or errors, or a changed runtime requirement. A refactor, a test, or a chore that changes no behavior needs no fragment.
2. Pick the kind. A change that makes a consumer change their code or requirements is breaking, a compatible addition is a feature, and anything else is a fix.
3. Name the fragment `breaking.<slug>.md`, `feature.<slug>.md`, or `<slug>.md` with a unique slug, directly in `.changes/`.
4. Write one Markdown bullet per result, starting with a verb. A breaking fragment adds one `### Migration` section with the five labels the guide shows.
5. When a later change alters what an earlier pending fragment says, edit or delete that fragment instead of adding a contradicting one.
6. Run `loom changelog check` and fix each fragment it names.

## Cut a version

1. Make sure the clone has full git history, because the cut orders entries by the commit that added each fragment.
2. Run `loom changelog write --dry-run` and read the section and the next version it prints.
3. Run `loom changelog write`, with `--date YYYY-MM-DD` or `--narrative FILE` when the release needs them. Add `--target VERSION` to cut a chosen version, such as `--target 0.11.0`; its release part must meet or exceed the minimum the pending fragments need (a target equal to the computed version is accepted, and `0.11.0-rc.1` ranks below `0.11.0`), and the cut fails and names the minimum otherwise.
4. Run the package manager's install, because the cut refreshes no lockfile.
5. Commit `CHANGELOG.md`, `package.json`, each file `sharedVersion` lists in `loom.config.json`, the lockfile, and the deleted fragments together.

## Cut a prerelease

1. Run `loom changelog write --target VERSION-PRERELEASE`, such as `--target 0.11.0-rc.1`. It sets the version, writes no changelog section, and keeps every fragment pending. A package at a stable version other than `0.0.0` needs that version's `## v<version> - <date>` section in `CHANGELOG.md` first.
2. Run `loom changelog notes VERSION-PRERELEASE` to print the pending fragments as the candidate's release notes.
3. Cut the next candidate with a higher prerelease, such as `--target 0.11.0-rc.2`, or finalize with `loom changelog write`, which cuts the release part, `0.11.0`, writes its section, and consumes the fragments. When a fragment added since raises the minimum past that release part, the cut fails and asks for `--target`.
4. Run the package manager's install after a cut that sets versions, because the cut refreshes no lockfile.
5. Commit the changed manifests and the lockfile, as in a version cut. A prerelease changes no fragment and no changelog.

## Read a version's notes

Run `loom changelog notes VERSION`. A cut version prints the body of its section in `CHANGELOG.md`, and the package's current prerelease prints its pending fragments. Any other version fails.

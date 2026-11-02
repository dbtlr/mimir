<!-- Managed by loom init. sha256:be7d87cd0f008510beafa079704d47a74f4479e8e5354f35f8d379c0c13f6707 -->

# Change fragments

This directory holds the package's pending changelog entries, one fragment per change. `loom changelog write` cuts the next version from them into `CHANGELOG.md`.

## Name the fragment

- `breaking.<slug>.md` is a breaking change, `feature.<slug>.md` a feature, and `<slug>.md` a fix.
- Choose a unique, nonempty slug, such as `feature.list-by-tag.md`. A bare `feature.md` or `breaking.md` is invalid.
- Keep fragments directly in `.changes/`. A subdirectory or a file that is not Markdown is invalid. A hidden entry, one whose name starts with `.`, is ignored.
- This `README.md` is the guide, not a fragment.

## Write the entry

Write one or more Markdown bullets. Start each with a verb, such as `Add`, `Fix`, `Change`, or `Remove`, and state what a consumer can now do or what behavior changed. Keep implementation history out. A fragment has no frontmatter and no headings, except the migration section of a breaking change.

```markdown
- Add the `--tag` option to `notes list`, which lists only the notes with that tag.
```

## Explain a breaking change

A change is breaking when a consumer must change their code or requirements to update. After the bullets, add one `### Migration` section with these five labels:

````markdown
- Rename the `--out` option to `--output`.

### Migration

**Affected surface.** Scripts that pass `--out`.

**Why.** Every other command spells it `--output`.

**Before and after.**

```sh
notes export --out notes.json
notes export --output notes.json
```

**Steps.**

1. Replace `--out` with `--output` in each script.

**Validation.** Run each script and check that it writes its file.
````

## The next version

The highest kind present decides the next version.

| Current version | Highest kind present | Next version |
| --------------- | -------------------- | ------------ |
| `0.0.0`         | Any                  | `0.1.0`      |
| `0.4.7`         | Breaking             | `0.5.0`      |
| `0.4.7`         | Feature or fix       | `0.4.8`      |
| `1.4.7`         | Breaking             | `2.0.0`      |
| `1.4.7`         | Feature              | `1.5.0`      |
| `1.4.7`         | Fix                  | `1.4.8`      |

`loom changelog write --target VERSION` cuts a chosen version, such as `0.11.0` or the prerelease `0.11.0-rc.1`. Its release part, the version without its prerelease part, must meet or exceed the version the table gives from the last release, and a fragment keeps its kind whatever version ships it. A prerelease cut sets the version and keeps every fragment pending. From a prerelease, `loom changelog write` cuts the release part when it meets the table's version. A current version in any other form, such as `v1.2.0`, cannot be cut.

## Check and cut

- `loom changelog check` validates every fragment, exits 1 for an invalid one, and names it. It needs no git history, so CI can run it.
- `loom changelog write` prepends the release section to `CHANGELOG.md`, sets `version` in `package.json`, and deletes the consumed fragments. It orders entries by the commit that added each fragment, so it needs full git history. `--date YYYY-MM-DD` dates the release, `--narrative FILE` copies prose above the entries, and `--dry-run` prints the section and the next version and writes nothing.
- `loom changelog notes VERSION` prints a cut version's section from `CHANGELOG.md`, or the pending fragments for the package's current prerelease.
- `write` refreshes no lockfile, so run your package manager after a cut.

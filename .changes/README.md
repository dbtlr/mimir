# Changelog fragments

Pending changelog entries, one file per PR ([ADR 0022](../docs/decisions/0022-changelog-fragments-compiled-at-cut.md)).
Each build-affecting PR adds a fragment here instead of editing `CHANGELOG.md`;
the release cut compiles the pending set into the new release section and
deletes the compiled fragments in the same commit.

- **Filename:** any unique slug ending in `.md` — the task id is the
  convention (`mmr-267.md`). This `README.md` is excluded from compilation.
- **Content:** the Keep-a-Changelog grammar, exactly as it should appear in
  the release section — `### Added` / `### Changed` / `### Deprecated` /
  `### Removed` / `### Fixed` / `### Security` headings (H3 only) with `- `
  bullets beneath them (`- ` only, not `*`). Multiple headings per fragment
  are fine. No other content parses.
- **Links are repo-root-relative** (`docs/decisions/…`, not `../docs/…`): the
  entry's final home is `CHANGELOG.md` at the repo root, so a link that
  resolves from this directory would break once compiled.

```markdown
### Fixed

- **Board drag misorders siblings** (MMR-999). One-to-three sentences in the
  repo's entry voice: bolded lead, task id, prose body.
```

Preview the pending release section anytime:

```sh
bun run changelog:compile
```

The `changelog-guard` CI check enforces the contract: a PR touching
build-affecting paths must touch a fragment (or carry the `skip-changelog`
label), and every fragment remaining on head must parse — the guard runs the
compiler's own parser (`bun run changelog:compile --check`), so what passes
the guard is exactly what compiles at the cut. (A delete-only touch is the
release-cut PR: nothing left to parse, gate satisfied.) Fragments live flat
in this directory; subdirectories are not scanned.

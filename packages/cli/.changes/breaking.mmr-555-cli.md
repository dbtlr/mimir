- **Failures print Loom's envelope** (MMR-555). With `-f json` or `-f jsonl`, a
  failure is `{"error":{"code","exitCode","message","hints"}}`, where `hints` is
  an array and `code` is kebab case (`not-found`, `usage`, `unknown-option`).
  Human formats print `mimir: <message>` and then each hint. Usage errors exit 2
  and domain refusals exit 1, as before.
- **`mimir version` replaces `--version`** (MMR-555). It prints the bare version.
- **`mimir skills install` replaces `mimir skill install`** (MMR-555). It installs
  into your home folder for every supported agent; `--agent claude|agents`
  chooses one and `--project` installs into the current repository.
  `--global`, `--local`, and `--agent codex` are gone.
- **A stricter parser** (MMR-555). Options go after the verb: `mimir -s MMR list`
  now fails, so write `mimir list -s MMR`. A single-value option given twice
  (`list -s A -s B`) and an extra positional (`get A-1 B-2`) now fail with exit 2
  instead of being ignored. Board reads name exactly one project, so `-s all` and
  `-p all` are retired; loop over `mimir projects -f ids`. Under `-f jsonl`,
  `status` and `overview` print one compact JSON document, not rows.

### Migration

**Affected surface.** Scripts that parse `-f json` or `-f jsonl` failures, pass options before the verb, repeat a single-value option, pass an extra positional, use `-s all` or `-p all`, read `status` or `overview` rows under `-f jsonl`, call `mimir --version`, or call `mimir skill install`.

**Why.** The CLI is now built on Loom, which fixes the parser, the error envelope, and the command names.

**Before and after.**

```sh
mimir -s MMR list
mimir --version
mimir skill install
mimir list -s MMR
mimir version
mimir skills install
```

**Steps.**

1. Move options after the verb, and remove repeated single-value options and extra positionals.
2. Replace `-s all` and `-p all` with a loop over `mimir projects -f ids`.
3. Read a failure as `{"error":{"code","exitCode","message","hints"}}`, with `hints` as an array and `code` in kebab case.
4. Read `status` and `overview` under `-f jsonl` as one compact JSON document.
5. Use `mimir version`, and `mimir skills install` with `--agent claude|agents` or `--project` in place of `--global`, `--local`, and `--agent codex`.

**Validation.** Run each script and check that no command exits 2 for a usage error.

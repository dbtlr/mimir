- **Stage a task whose code is accepted on its branch but not yet on `main`** (MMR-675). `mimir stage <id>` and the MCP `stage` tool move a task from `under_review` to the new `staged` status; any other task is refused with a pointer to `submit`. A staged task keeps its handles, leaves `next`, counts as work in flight, and is chased by `stale`. It finishes with `done`, goes back to `in_progress` with `return`, or ends with `abandon`. `list --status staged` selects it. In a phase or initiative, `staged` reads just below `under_review`, so a phase whose remaining tasks are all staged reads `staged`. A dependent of a staged task still reads `awaiting`. The console shows a green `staged` badge, offers **Stage** on a task in review, and lists a staged task in _Now_ as _Staged · submitted 2h ago_, timed from its latest submit like a review.
- **Schema version 14 admits the `staged` status** (MMR-675). A SQLite store, a local CLI's included, migrates to schema 14 when it is opened, and the host's Postgres store migrates at host startup. Older binaries then refuse the store, so rolling back past this release needs a restore from a backup taken before the upgrade. `mimir store export` writes transfer version 8, which carries staged tasks and which older releases refuse; this release still imports versions 1 to 7.

### Migration

**Affected surface.** Engine clients and scripts that read a task's `lifecycle` or status word, and a host serving clients of this release.

**Why.** The Engine contract gains the `stage` method and the `staged` value in the lifecycle and status vocabularies. A reader that switches over a closed list of statuses meets a value it does not know. Earlier CLIs are such readers: their table output fails on a `staged` task. `MIN_CLIENT` rises to `0.29.0-next`, so a host of this release refuses them with the update to run. From this release on, the CLI renders a status word it does not know instead of failing.

**Before and after.**

```json
{ "lifecycle": "under_review", "status": "under_review" }
{ "lifecycle": "staged", "status": "staged" }
```

**Steps.**

1. Update the host before its clients, as for every Engine change.
2. Update every CLI paired with that host to this release; the host refuses an older one and names the update.
3. In scripts that branch on a task's status, treat `staged` as live, non-terminal work.

**Validation.** Run `mimir stage <id>` on a task under review, then `mimir get <id>` and check that it reads `staged`.

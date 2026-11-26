- Change the Engine's `review` report to carry Home's counts on each project instead of building rows Home only counts (MMR-763). Each `projects` entry adds `runnable`, `untriaged`, and `findings` beside its existing counts, and the report drops its top-level `runnable`, `goingCold`, `triage`, and `lastFinished`. Home's When you have a minute rows read the per-project counts, so a console poll no longer builds a view of every ready or going-cold task, nor reads the history of recent abandons. The store does not change.

### Migration

**Affected surface.** Clients of the Engine's `review` method, the console among them. No CLI or MCP command reads the `review` report, so the minimum client version does not change.

**Why.** Home shows only how many tasks are ready to start or going cold, and how many seeds and doctor findings wait, so building and sending every row on each poll was wasted work.

**Before and after.** Before, the `review` report had `runnable` and `goingCold` row lists, `triage` groups with each project's untriaged seeds, and `lastFinished`. After, those four fields are gone, and each `projects` entry has `runnable`, `untriaged`, and `findings` counts. `needsYou`, `needsYouFacts`, `queue`, `now`, `shipped`, and the existing project counts do not change.

**Steps.** Update the host before its clients. A client that reads the removed fields reads the `projects` counts instead. A client that builds `review` reports, such as a test fixture, drops the four fields and adds the three counts to each project.

**Validation.** Open the console against the updated host and check that Home's When you have a minute rows show the same counts as before and open the same lists.

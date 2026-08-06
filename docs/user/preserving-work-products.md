# Preserve work products as Artifacts

Artifacts are frozen records of what work produced: a specification, plan,
decision note, investigation, review, or session summary. They remain readable
after the originating file, branch, or conversation disappears.

## Attach a file

```sh
mimir attach AUR-8 --file recovery-plan.md --tag plan \
  --summary "Retry boundary and rollout checks for account recovery."
```

The positional work ID anchors the Artifact. Use `--link` for additional work
in the same project, or `--project AUR` for a project-level record.

Artifacts receive stable IDs such as `AUR-a3`. Their content is immutable.
Correct a record by attaching a successor rather than editing history. Titles
and short summaries may be updated when their presentation needs correction.

## Make the feed useful

Tags classify Artifacts without imposing one global type system:

```sh
mimir artifacts -t plan
mimir artifacts -s all -t session_summary
mimir artifacts -q recovery
mimir get AUR-a3 --col content
```

Use a specific title even when tags are present. The optional summary is the
lede shown in feeds and `overview`; it should say what the Artifact establishes,
not repeat the title.

## Close a work session

A session summary is an Artifact tagged `session_summary`. Keep it short and
recoverable without the chat transcript. Include:

- outcomes and decisions;
- deviations from the expected path;
- verification performed;
- follow-up work that was created or deliberately deferred.

Attach it to every materially touched task in the project:

```sh
mimir attach AUR-8 --file session-summary.md \
  --title "Session summary — recovery timeout" \
  --summary "Isolated the retry boundary and verified the mobile fix." \
  --tag session_summary --link AUR-11
```

Artifacts cannot span projects. Write one project-local summary for each
project when a session crosses project boundaries.

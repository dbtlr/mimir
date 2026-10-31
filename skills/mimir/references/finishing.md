# Finishing: settle, re-orient, remember

Three records describe finished work. Each is independent, and the session's
process decides which ones a boundary gets:

1. **Transition** — the task's state.
2. **Groom-next** — re-author owned `## Next` prose against the now-current board.
   This is the direction rewrite, not the `groom` verb, which sets a task's
   grooming state (`references/status-model.md`).
3. **Summarize** — freeze the session retrospective with a lede and task anchors.

## Transition

Use the lifecycle or hold verb at the moment its claim becomes true:

```sh
mimir unqueue KEY-9 "Run cancelled before dispatch"  # release an unstarted reservation
mimir submit KEY-9                 # ready for its review gate
mimir done KEY-9                   # verified complete; no review gate remains
mimir park KEY-9 "reason"          # deliberately deferred
mimir block KEY-9 --on you "reason"          # obstructed; --on you or --on others names who can clear it
```

This piece stands alone: a state change does not wait for prose grooming or a
retrospective. In a repository with its own completion gate, that gate decides
whether the truthful action is `submit` or `done`.

## Groom-next

Groom-next rewrites a container's direction when a transition or discovery
changes it, whether or not a task finished:

1. Read `mimir overview -s KEY`, then inspect each project, initiative, or phase
   whose direction may have changed with `mimir get <id>`.
2. Decide what non-derivable sequencing rationale is still true. Do not restate
   the ready queue, statuses, or dependency rollups.
3. Replace the complete owned section with
   `mimir update <KEY|container> --direction "…"`; run
   `mimir update <KEY|container> --clear-direction` when no editorial direction
   remains. An empty `--direction` value is refused, so a script that reads a
   missing file cannot clear the section.
4. Read it back. If the CAS guard refuses because another write landed, discard
   the stale draft, re-read the board and current prose, merge the new facts,
   and re-author. Never replay the old command unchanged.

This piece stands alone: direction can be groomed at any planning or handoff
boundary without transitioning a task or writing a retrospective.

## Summarize

A session summary is a short markdown retrospective frozen as a
`session_summary` artifact. `overview` lists it beside the session it records:

```sh
mimir attach KEY-9 --file retro.md --title "Session summary" \
  --summary "Shipped the parser and captured the remaining migration risk." \
  --tag session_summary --link KEY-12,KEY-14
```

- Make `--summary` a concrete lede (256 characters maximum), not a duplicate of
  the title. It is what `overview` shows beside the session.
- Anchor the artifact to every task the session materially touched: use the
  primary positional id plus `--link` for additional same-project task ids.
- Keep the body useful after the chat disappears: outcomes, decisions,
  deviations, verification, and follow-ups. Do not copy a transcript.
- Artifacts cannot span projects. If a session touched several projects, write
  one project-local artifact per project, each with only that project's anchors
  and a lede/body that describes its share of the session.
- **If the session ran on a Scratchpad, freeze it instead of attaching a
  parallel file** — `mimir scratch freeze <uuid> --summary "…" -t
  session_summary --expected-updated-at <ts>` turns the episode's own Journal
  and Agenda into the retrospective artifact (`references/scratchpad.md`); the
  same lede discipline applies. The anchoring rule above still binds: the
  artifact inherits the **Scratchpad's linked work** as its anchors, and
  linked-task overlap is what joins it to the session in `overview` — so
  before freezing, link every task the session materially touched
  (`scratch update <uuid> --link … --expected-updated-at <ts>`), or the
  retrospective lands unjoined. That update's receipt returns the fresh
  token the freeze then takes — tokens move on every write. Two records of one session drift; the
  episode's memory is the retrospective. `attach --file` remains the path for
  sessions that ran without one.

This piece stands alone: it may record planning, review, or investigation even
when no lifecycle transition or direction edit occurred.

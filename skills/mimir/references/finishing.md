# Finishing: settle, re-orient, remember

Finishing has three independently invocable pieces. Run only the piece a work
boundary needs; when completing a task, compose all three in this order:

1. **Transition** — make the task state true.
2. **Groom-next** — re-author owned `## Next` prose against the now-current board.
3. **Summarize** — freeze the session retrospective with a lede and task anchors.

## Transition

Use the lifecycle or hold verb at the moment its claim becomes true:

```sh
mimir submit KEY-9                 # shippable; awaiting human review
mimir done KEY-9                   # verified complete; no review gate remains
mimir park KEY-9 "reason"          # deliberately deferred
mimir block KEY-9 "reason"         # externally obstructed
```

This piece stands alone: a state change does not wait for prose grooming or a
retrospective. Follow the transition contract in `SKILL.md`; in a repository
with its own completion gate, that gate decides whether the truthful terminal
action is `submit` or `done`.

## Groom-next

Groom after a transition or discovery changes the board's direction, even when
no task finished:

1. Read `mimir overview -s KEY`, then inspect each project, initiative, or phase
   whose direction may have changed with `mimir get <id>`.
2. Decide what non-derivable sequencing rationale is still true. Do not restate
   the ready queue, statuses, or dependency rollups.
3. Replace the complete owned section with
   `mimir update <KEY|container> --direction "…"`; pass `""` when no editorial
   direction remains.
4. Read it back. If the CAS guard refuses because another write landed, discard
   the stale draft, re-read the board and current prose, merge the new facts,
   and re-author. Never replay the old command unchanged.

This piece stands alone: direction can be groomed at any planning or handoff
boundary without transitioning a task or writing a retrospective.

## Summarize

At task completion, always summarize: completing the task is itself durable
context worth recovering. At another work boundary, summarize when the session
produced durable context. Write a short markdown retrospective, then freeze it
as a `session_summary` artifact:

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
- At a standalone non-completion boundary that produced no durable
  retrospective, omit this piece rather than manufacturing activity.
- **If the session ran on a Scratchpad, freeze it instead of attaching a
  parallel file** — `mimir scratch freeze <uuid> --summary "…" -t
  session_summary` turns the episode's own Journal and Agenda into the
  retrospective artifact (`references/scratchpad.md`); the same lede
  discipline applies. Two records of one session drift; the episode's memory
  is the retrospective. `attach --file` remains the path for sessions that
  ran without one.

This piece stands alone: it may record planning, review, or investigation even
when no lifecycle transition or direction edit occurred.

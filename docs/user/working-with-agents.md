# Work with agents

Mimir gives an agent a stable work contract instead of asking each session to
reconstruct project state. Repository binding supplies identity, `overview`
supplies orientation, lifecycle verbs keep claims honest, and Artifacts retain
the useful result.

## Install the workflow

Mimir ships its own agent skill:

```sh
mimir skill install --global --agent codex
# or
mimir skill install --global --agent claude
```

Use `--local` when the skill should live with one repository. Configure
`mimir mcp` as an MCP server to expose the tool surface directly. Both the CLI
and MCP server honor the clone's git config binding (the MCP server reads the
directory it was started in).

## Orient once

At session start, the agent should read:

```sh
mimir overview
mimir triage
```

`overview` composes project direction, in-flight work, the ready head,
dependency-gated work, recent sessions, active Scratchpads, and hygiene.
`triage` reconciles the Seed queue and upstream resolutions. An agent should
drill into `get`, `tree`, or `list` only when the composite points there.

## Claim and transition at the moment

```sh
mimir start AUR-8 --host workstation --harness codex \
  --session recovery-fix --branch fix/aur-8-recovery
```

The optional handles answer where the work is happening and how another session
can resume it. They are pointers, not telemetry.

Use lifecycle and hold verbs when their claims become true. Do not save all
status updates for session close. A task should be `in_progress` while an agent
owns it, `under_review` while it awaits review, and `blocked` or `parked` as soon
as work stops for those reasons.

## Keep transient and durable context separate

- Use **annotations** for short, append-only facts on existing work.
- Use a **Scratchpad** for temporary reasoning that needs to survive context
  loss while it is still changing.
- Use an **Artifact** for a frozen plan, specification, investigation, or
  session summary.
- Use a **Seed** for an uncommitted idea or a request owned by another board.

This separation keeps the agent's active context small without discarding the
record needed by a future session.

## Finish with proof

Before completion, verify the work, transition the task, update non-derivable
direction when it changed, and attach a concise session summary. The chat
transcript is not the work-state record; Mimir is.

## Hand a whole task to another session

The main session is the user conversation or workflow coordinating the work.
A worker is a separate session entrusted with the whole task lifecycle,
including any helper agents it uses. Helpers are not attached to the task.
When the main agent works a task itself, a separate worker identity is absent.

Reserve with the main session, then identify the worker explicitly:

```bash
mimir queue AUR-8 --harness codex --session workflow-session
mimir start AUR-8 --worker-harness claude --worker-session task-session
```

Starting the task preserves the main session and an explicitly preassigned
worker. Supply both worker flags to identify a handoff; the CLI does not infer
worker identity from the invoking shell. The worker manages task state
through review and completion. Explicit reassignment through update retains
previous identities in history.

Park, block, cancellation, and settlement clear both identities and preserve
them in history. Releasing a hold restores nothing; the next session sets
its identity explicitly when it resumes the task.

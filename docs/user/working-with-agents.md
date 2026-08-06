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
and MCP server honor the nearest `.mimir.toml` binding.

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

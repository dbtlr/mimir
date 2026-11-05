---
description: Canonical terms for Mimir’s client/host boundary and task session ownership.
---

# Mimir glossary

This glossary defines the client and host boundary terms used in
[ADR 0034](decisions/0034-engine-interface-and-trpc-wire.md),
[ADR 0035](decisions/0035-tanstack-start-container-host.md),
[ADR 0038](decisions/0038-device-pairing-and-the-version-window.md), and
[ADR 0041](decisions/0041-agent-runtime-on-the-host.md).

**Host**: The Mimir server that serves the operator console and remote clients
and owns their shared store.

**Store owner**: The sole Mimir authority for a store, either a local CLI or
one host. Remote clients access a host-owned store through that host.

**Pairing**: The one-time exchange in which a named device asks to join a host
and an operator approves it there, after which that device holds a revocable
credential for it.
Pairing identifies a device; it is not an access boundary.

**Version window**: The range of client versions a host accepts: none older
than its minimum supported client, and none whose minor version is newer than
the host's.

**Main session**: The user conversation or workflow coordinating a task. Its
`harness` and `session` remain the primary return point during an assignment.

**Worker session**: An optional distinct session entrusted with the whole task
lifecycle. It owns implementation, task-state updates, review, and completion,
and may delegate smaller pieces to helper agents. A main session working its
own task has no separate worker identity.

**Helper agent**: An agent delegated a piece of a task by its responsible worker.
Its identity is not attached to the task.

**Agent run**: One execution of an agent by the host on behalf of a task, such
as a grooming run, recorded as a host-owned row with its state, usage, and
outcome ([ADR 0041](decisions/0041-agent-runtime-on-the-host.md)). An agent
run is not a task's session and changes none of its handles.

**Capability**: The board access an agent run is given: the reads its kind
needs within its project, and writes limited to its own task. A run reaches
the board only through its capability, never through the Engine directly.

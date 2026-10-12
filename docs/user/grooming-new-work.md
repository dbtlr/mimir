# Groom new work with Seeds

A Seed captures something that deserves triage before it becomes committed
work. Use Seeds for ideas, bugs, features requested from another project, and
own-project observations whose solution is not yet clear.

If the fix is already known on a board you own, create a task instead.

This page is about triaging Seeds. Whether a task is understood well enough to
run is a separate judgment, set with `mimir groom` (see
[Plan and run work](planning-and-running-work.md#groom-tasks)).

## File without interrupting current work

```sh
mimir seed "Recovery emails can arrive twice" -k bug
mimir seed "Expose delivery traces" -k feature -p BCN
```

The first command files against the bound project. `-p` targets another board.
Mimir allocates a stable ID such as `AUR-s4`.

## Read the queue

```sh
mimir seeds --grouped
mimir seeds -p all --status live
mimir get AUR-s4
```

The grouped view separates untriaged, promoted, ready-to-resolve, and settled
Seeds. The console provides the same grooming lanes; each Seed opens on its own page.

## Settle the question

Promote a Seed when it has become committed work:

```sh
mimir promote AUR-s4 --parent AUR-2
```

Promotion creates a linked task unless `--link` points at existing work. When
the promoted work settles, triage identifies the Seed as ready to resolve.

Reject a proposal that should not become work:

```sh
mimir reject AUR-s5 "migration cost outweighs the benefit"
```

Resolve a Seed when the question has been answered without new work, or after
its promoted work has delivered the outcome:

```sh
mimir resolve AUR-s4 "fixed by AUR-12"
```

The reason or resolution is part of the durable record. Seeds are settled, not
deleted.

## Handle cross-project blockers

When another board's Seed blocks your task, record both sides:

```sh
mimir update AUR-8 --upstream BCN-s3
mimir block AUR-8 "waiting for BCN-s3"
```

Set the upstream first: a block with no `--on` is owned by `others` when the
task has an upstream, so the wait stays out of your needs-you count.

The explicit upstream pointer lets triage notice when the owning board settles
the request.

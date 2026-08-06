# Capture temporary work with Scratchpads

A Scratchpad keeps temporary, resumable context while an episode is still
changing. Use one for shaping, investigation, planning, or another thread that
may outlive the current agent context but does not yet belong in a durable work
product.

A Scratchpad belongs to one project and may link to work. It contains:

- an append-only **Journal** of checkpoints;
- a numbered **Agenda** whose items can be completed or superseded;
- an optimistic concurrency token, `updated_at`, required by every mutation.

## Create and resume

```sh
mimir scratch create "Investigate recovery timeouts" --link AUR-8 -f json
mimir scratch list
mimir scratch get <uuid> -f json
```

Keep the returned `updated_at`. Pass the latest value to the next mutation so a
stale writer cannot overwrite newer work.

## Checkpoint reasoning

```sh
mimir scratch checkpoint <uuid> \
  "The timeout starts after token exchange, not during authentication." \
  --expected-updated-at <timestamp>
```

Checkpoints preserve how the episode moved forward. They should capture a
settled observation or decision, not a transcript.

## Track the open agenda

```sh
mimir scratch agenda add <uuid> "Compare mobile and web traces" \
  --expected-updated-at <timestamp>
mimir scratch agenda complete <uuid> 1 \
  --expected-updated-at <new-timestamp>
mimir scratch agenda supersede <uuid> 2 --reason "covered by AUR-11" \
  --expected-updated-at <newer-timestamp>
```

Agenda numbers remain stable. Completing or superseding an item records its
outcome instead of rewriting history.

## Freeze or discard

Freeze useful temporary context into a normal, immutable Artifact:

```sh
mimir scratch freeze <uuid> --summary "Recovery timeout investigation" \
  --tag investigation --expected-updated-at <timestamp>
```

The Artifact contains the complete Scratchpad and retains its project and linked
work. Freeze is safe to retry after a staged failure.

Discard an episode when no durable record is needed:

```sh
mimir scratch discard <uuid> --expected-updated-at <timestamp>
```

Discard refuses an open Agenda. `--force --reason` is available when abandoning
the episode is intentional.

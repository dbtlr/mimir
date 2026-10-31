# Seeds: the grooming queue

Contents: [Filing](#filing) · [Reading the queue](#reading-the-queue) ·
[Triage verbs](#triage-verbs-the-triagers-surface) ·
[Cross-board asks](#cross-board-asks-upstream) · [The triage pass](#the-triage-pass)

A **seed** is a record filed against a board that implies **no committed work —
only triage** (`kind` ∈ `idea|bug|feature`, ids `KEY-sN`). A seed either
germinates into work or it doesn't; the **owning board's** triage decides what
gets cultivated. Seeds are project-anchored records (artifact-model siblings),
never tree nodes — they have their own lifecycle, verbs, and queue.

Seeds carry two kinds of record:

1. **An ask against another board**: a bug report, feature ask, or capability
   need in a surface that board owns. The owning board's triage decides what
   work it commits, so the ask arrives as a seed however fully shaped the fix
   is.
2. **Own-board work not yet committed**: an idea or observation whose
   existence is still a decision ("should X?", "prove it or delete it"). It
   may or may not germinate into tasks.

Committed own-board work is a task (`create task`), including work whose
design is still open.

## Filing

```sh
mimir seed "append collapses the boundary
repro: empty target section; found while building MMR-156" -k bug -p NRN   # first line title, rest body
mimir seed "should capture parse a title from the first line?" -k idea   # own board: whether to do it is still open
```

- Target board **and** requester default from the bound board. Filing onto
  **another** board records your board as `requester`; self-filing (or filing
  unbound) leaves requester null. `mimir projects` lists the board keys `-p`
  takes.
- **Capture is one blob** (commit-message semantics): the **first line is the
  title** (the lede), everything after the first newline is the
  `## Seed Description` body — repro steps, context, links. The first line has
  a hard **120-char cap** that **errors** (put the body on the next line).
  `--desc` still works and **wins** over the blob split; `update --title`
  inherits the cap.
- Filing is low-ceremony **by design**: one line is a complete seed.

## Reading the queue

```sh
mimir seeds                       # the bound board: live seeds, oldest-first
mimir seeds -p NRN --grouped      # lanes: UNTRIAGED · READY TO RESOLVE · PROMOTED · SETTLED
mimir seeds --status all --grouped   # adds the PARKED lane
mimir seeds --status parked       # the seeds set aside for later
mimir seeds -p NRN --requester MMR   # what my board has asked of NRN
mimir get NRN-s3                  # one seed, resolved view
```

- Default shows **live** seeds (`new`+`promoted`) **oldest-first** — the
  longest-waiting seed is the triage priority. Parked seeds are left out;
  `--status parked` or `all` lists them. `--status <word>|all`,
  `--sort asc|desc`, `-p KEY` for another board, and the shared date ops over
  `created_at` (`--at-or-after created_at:2026-07-01`, `--tz <IANA>`).
- `seed` captures and `seeds` queries. For tasks and other nodes, `list` is the
  query verb.

## Triage verbs (the triager's surface)

```sh
mimir promote NRN-s3 --parent NRN-42 --desc "…"   # germinate: creates the task via the normal create path
mimir promote NRN-s3 --link NRN-55                # record EXISTING work as spawned (no create)
mimir resolve NRN-s6 "shipped in v0.45.0"         # terminal: satisfied  (reason required)
mimir reject  NRN-s4 "covered by NRN-102"         # terminal: declined   (reason required)
mimir park    NRN-s7 "after the sync rewrite"     # keep it, stop triaging it (reason optional)
mimir unpark  NRN-s7                              # back to untriaged
mimir update  NRN-s2 --title "…" --kind idea      # patch a LIVE seed; terminal seeds refuse
```

- Lifecycle: `new → promoted → resolved | rejected`, with `new ⇄ parked` beside
  it — and both terminals are reachable straight from `new` or `parked` ("already fixed" is a **resolve**, not a reject;
  the reason string carries the nuance).
- **Park** an untriaged seed the board owner wants to keep but not decide on
  now. A parked seed leaves the untriaged count in `overview` and `triage`,
  which report only how many are parked. `unpark` returns it to `new`; a
  parked seed can also be promoted, resolved, or rejected directly. Parking is
  a triage call on the seed; a deferred task is parked with `park <task-id>`.
- `promote` is **repeatable** while promoted — further germination appends
  `spawned` links. `--link` records work that already exists.
- **Terminal states are set only by these explicit verbs.** All spawned work
  settling never auto-closes a seed — it only flags it _ready to resolve_; the
  triager disposes (the spawned tasks could all have been abandoned without
  satisfying the ask).

## Cross-board asks: `upstream`

When your task waits on another board's seed, record the edge as data before
you block, so triage can follow it and the block defaults to `others` (the
other board owns it):

```sh
SID=$(mimir seed "accept plans without vault_root" -k feature -p NRN -f ids)
mimir update MMR-157 --upstream "$SID"
mimir block MMR-157 "waiting on $SID"
```

Set `--upstream` first: a task with an upstream blocks as `others` without
`--on` (`block --on others` says the same thing outright). The triage pass
annotates your task when the upstream settles and suggests `unblock`. Reference-only: no dependency rollup crosses boards.

Clearing the pointer takes the literal `none` sentinel — nothing else clears:

```sh
mimir update MMR-157 --upstream none    # edge recorded in error, or obsolete
```

A blank or omitted `--upstream` never clears (a deliberate refusal — an empty
value is far likelier a scripting slip than an intent), and `none` is
collision-free because a real seed id is always `KEY-sN`.

## The triage pass

```sh
mimir triage            # the bound board
mimir triage NRN        # another board
mimir triage --dry-run  # preview; writes nothing
```

One board per run, self-contained. Three checks: **(a)** surfaces untriaged
seeds (parked seeds are only counted); **(b)** flags promoted seeds whose spawned work has all settled —
_ready to resolve_; **(c)** for the board's **own** tasks whose `upstream` seed
went terminal, appends the resolution annotation
(`upstream KEY-sN resolved: <reason>`) and suggests unblock.

- It **writes the check-(c) annotations by default** — running triage is the
  intent — and **never transitions any status**; resolve/unblock stay yours.
- Idempotent across serial re-runs (the annotation marker is
  machine-recognized), so it is safe to repeat.
- A task the pass cannot reconcile (a flaky read, a refused write) lands in a
  `failures` section instead of aborting the pass. Always a report, never a
  gate — exit 0.

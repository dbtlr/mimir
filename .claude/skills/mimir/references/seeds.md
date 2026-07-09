# Seeds: the grooming queue

A **seed** is a record filed against a project that implies **no work — only
triage**: an idea, a bug report, or a feature ask (`kind` ∈ `idea|bug|feature`).
Ids: `KEY-sN`. A seed either germinates into work or it doesn't; triage decides
what gets cultivated. Seeds are project-anchored records (artifact-model
siblings), never tree nodes — they have their own lifecycle, verbs, and queue.

## Filing

```sh
mimir seed "vault.get should take a section arg" -k feature      # onto the bound board
mimir seed "append collapses the boundary" -k bug -p NRN \
    --desc "repro: empty target section; found while building MMR-156"
```

- Target board **and** requester default from the bound board. Filing onto
  **another** board records your board as `requester`; self-filing (or filing
  unbound) leaves requester null.
- The title is the capture; `--desc` is body prose (`## Seed Description`) —
  repro steps, context, links.
- Filing is low-ceremony **by design**: prefer a seed over a mental note, a
  prose TODO, or a task nobody committed to.

## Reading the queue

```sh
mimir seeds                       # the bound board: live seeds, oldest-first
mimir seeds -p NRN --grouped      # lanes: UNTRIAGED · READY TO RESOLVE · PROMOTED · SETTLED
mimir seeds -p all --requester MMR   # everything my board has asked of others
mimir get NRN-s3                  # one seed, resolved view
```

- Default shows **live** seeds (`new`+`promoted`) **oldest-first** — the
  longest-waiting seed is the triage priority. `--status <word>|all`,
  `--sort asc|desc`, `-p all` for every board.

## Triage verbs (the triager's surface)

```sh
mimir promote NRN-s3 --parent NRN-42 --desc "…"   # germinate: creates the task via the normal create path
mimir promote NRN-s3 --link NRN-55                # record EXISTING work as spawned (no create)
mimir resolve NRN-s6 "shipped in v0.45.0"         # terminal: satisfied  (reason required)
mimir reject  NRN-s4 "covered by NRN-102"         # terminal: declined   (reason required)
mimir update  NRN-s2 --title "…" --kind idea      # patch a LIVE seed; terminal seeds refuse
```

- Lifecycle: `new → promoted → resolved | rejected` — and both terminals are
  reachable straight from `new` ("already fixed" is a **resolve**, not a reject;
  the reason string carries the nuance).
- `promote` is **repeatable** while promoted — further germination appends
  `spawned` links. `--link` records work that already exists.
- **Terminal states are set only by these explicit verbs.** All spawned work
  settling never auto-closes a seed — it only flags it _ready to resolve_; the
  triager disposes (the spawned tasks could all have been abandoned without
  satisfying the ask).

## Cross-board asks: `upstream`

When your task waits on another board's seed, record the edge — never a
prose-only hold:

```sh
SID=$(mimir seed "accept plans without vault_root" -k feature -p NRN -f ids)
mimir update MMR-157 --upstream "$SID"
mimir block MMR-157 "waiting on $SID"
```

The triage pass annotates your task when the upstream settles and suggests
`unblock`. Reference-only: no dependency rollup crosses boards.

## The triage pass

```sh
mimir triage            # the bound board
mimir triage NRN        # another board
mimir triage --dry-run  # preview; writes nothing
```

One board per run, self-contained. Three checks: **(a)** surfaces untriaged
seeds; **(b)** flags promoted seeds whose spawned work has all settled —
_ready to resolve_; **(c)** for the board's **own** tasks whose `upstream` seed
went terminal, appends the resolution annotation
(`upstream KEY-sN resolved: <reason>`) and suggests unblock.

- It **writes the check-(c) annotations by default** — running triage is the
  intent — and **never transitions any status**; resolve/unblock stay yours.
- Idempotent across serial re-runs (the annotation marker is
  machine-recognized), so it is safe at every orientation.
- Corrupt docs and flaky reads land in a `failures` section (repair via
  `mimir doctor`) instead of aborting the pass. Always a report, never a gate —
  exit 0.

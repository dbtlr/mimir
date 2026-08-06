# Scratchpads: temporary episode state

A **Scratchpad** is project-anchored working memory for an **unsettled
episode** — shaping, grilling, planning, an investigation, or a task execution
whose conversation may compact before the work settles (ADR 0027). It holds an
append-only numbered **Journal** (checkpoints) and a numbered **Agenda** (open
questions and follow-ups), and it appears in `mimir overview` so a fresh agent
can recover the episode without the chat scroll. It is temporary by contract:
**every episode ends in `freeze` or `discard`** — an active Scratchpad is
staging state, never the durable record.

Scratchpads are the deliberate exception to the flat-verb grammar (ADR 0028):
they are UUID-addressed, not `KEY-seq`, so their whole lifecycle groups under
`mimir scratch <operation>` (MCP: `scratch_*` tools). The UUID is a handle,
not an id you compose with — no other verb accepts it.

## When a Scratchpad — and when not

| The state you hold…                                              | Home                            |
| ---------------------------------------------------------------- | ------------------------------- |
| An unsettled episode that must survive compaction                | **Scratchpad**                  |
| A decision/surprise on an existing task or seed                  | `annotate <id>`                 |
| Work your board commits to (fix is statable)                     | `create task`                   |
| Intake for another board, or an own-board idea with no fix       | `mimir seed`                    |
| Settled, self-contained content worth keeping                    | artifact (`attach` or `freeze`) |

The gap Scratchpads fill: an episode may start **before any task or seed
exists** and may span several pieces of linked work. Do not stretch the other
primitives to cover it — and do not use a Scratchpad as a second board:
the moment work is statable, it becomes a task; the Scratchpad only records
that the episode produced it.

## The lifecycle

```sh
mimir scratch create "shape the watcher" --link MMR-331   # → uuid + updated_at token
mimir scratch checkpoint <uuid> "settled the API shape" --expected-updated-at <ts1>
mimir scratch agenda add <uuid> "verify recovery path" --expected-updated-at <ts2>
mimir scratch agenda complete <uuid> 1 --expected-updated-at <ts3>
mimir scratch agenda supersede <uuid> 2 --reason "covered by MMR-377" --expected-updated-at <ts4>

# then ONE of the two endings — never both (freeze deletes the document):
mimir scratch freeze <uuid> --summary "Watcher plan" --expected-updated-at <ts5>   # episode settled
mimir scratch discard <uuid> --expected-updated-at <ts5>                           # episode dead
```

(`<ts1>`…`<ts5>` are different values: every write moves the token, and each
`update`/`checkpoint`/`agenda` receipt carries the next one. Freeze and
discard are terminal — their receipts return an Artifact and a discard
confirmation, no further token.)

- `create` takes a title, an optional `-s KEY` (defaults to the bound project —
  a Scratchpad belongs to exactly one project), and repeatable `--link KEY-seq`
  anchors to related work.
- `checkpoint` appends one numbered Journal entry — inline text or `--file`.
  Checkpoint at the same moments you would `annotate`: a decision landed, a
  surprise, a direction change. The Journal is append-only; nothing edits or
  reorders it.
- `agenda` tracks what the episode still owes: `add` opens an item,
  `complete`/`supersede <number>` settle it (supersede requires a reason).
  Open Agenda is what `discard` refuses over — settle items when they settle.
- `update` replaces title or linked work (`--link …` replaces the set;
  `--clear-links` empties it; the two together is a usage error).

## The concurrency token — echo, never guess

Every mutation on an existing Scratchpad **requires `--expected-updated-at`**
and refuses a stale value. `create` returns the first token; `update`,
`checkpoint`, and `agenda` receipts each return the next one — capture it from
the receipt and thread it forward, exactly like composing with an echoed id.
On a stale-token refusal, another writer landed: `scratch get <uuid>`, re-read
what changed, then re-apply your intent against the fresh token — never replay
the old command unchanged. The token is a raw canonical timestamp: echo it
back byte-for-byte; it is a guard, not a reading.

## Resume: the recovery surface

`mimir overview` lists **active scratchpads** (true count; first 5 shown) —
`uuid · project · title · N open Agenda · age · linked KEY…`, with a
`freezing ·` flag on any interrupted freeze. Drill down:

```sh
mimir scratch list             # active + freezing, freezing first (-s all for every project)
mimir scratch get <uuid>       # the full Journal and Agenda, plus the current token
```

Starting a session against a board that shows an active Scratchpad? Read it
before planning anything — it is the episode's memory, and it may be the very
work you were about to redo.

## Ending the episode

**Freeze** when the episode settled into something worth keeping:
`freeze --summary "…"` (required lede, ≤256 chars; `-t` adds artifact tags)
snapshots the complete Journal + Agenda into a normally allocated, immutable
Artifact — `scratchpad` tag and `source_scratch` provenance included — then
deletes the temporary document. Freeze is a staged, **retryable** recovery
protocol, not a transaction: interrupted, the Scratchpad shows `freezing` and
rejects further writes — and the staging write itself moved the token, so
`scratch get <uuid>` for the fresh one, then re-run `freeze` with it. The
Artifact is created at most once; retry until its receipt lands.

**Discard** when the episode is dead and produced nothing durable. It refuses
while Agenda items are open; `--force --reason "…"` overrides. The reason is
demanded to make the override a deliberate act, not a reflex — it is **not
recorded anywhere**: discard deletes the document and leaves no trace. An
episode whose ending deserves a trace freezes instead.

The end-of-session sweep includes Scratchpads: for each one you drove, freeze
it if it settled, checkpoint it honestly if it continues, discard it if it is
dead. Leaving one active is a handoff, not a default — its Journal must let a
stranger resume.

| Rationalization                          | Reality                                                     |
| ---------------------------------------- | ----------------------------------------------------------- |
| "I'll keep notes in the chat"            | The chat compacts. The Scratchpad is the episode's memory.  |
| "I'll make a task to hold my notes"      | Tasks are commitments, not notebooks. Unsettled → scratch.  |
| "I'll freeze it later"                   | Later never comes. Settle the episode at its boundary.      |
| "Discard refused — I'll just leave it"   | Settle or supersede the Agenda, then end it honestly.       |
| "I'll reuse the last token"              | Tokens move per write. Read the receipt; thread it forward. |

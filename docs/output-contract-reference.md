---
title: 'mimir Output Contract Reference'
status: accepted
date: 2026-06-04
last-updated: 2026-06-10
---

# mimir Output Contract Reference

The external-facing shape of Mimir's **intent envelope** — the surface both the **CLI** and **MCP** render (see glossary **Envelope**, **Output contract**). Mimir's binding of the Norn output standard adopted in [ADR 0009](decisions/0009-adopt-norn-output-and-selection-contract.md); the _why_ is there, this note holds the concrete _shape_.

> **Maintained reference, not a frozen artifact.** Seeded during design with what's locked; the build completes it (exit-code table, full verb list, error envelope, worked per-format examples) and keeps it honest. Prefer the ADRs over this note where they conflict.

## Selection vs. projection (the spine)

Commands differ in **one axis only — how they identify rows.** Everything downstream is one shared contract.

- **Set selection** (broad): `next` / `list` — `--status` universe + `--is` verdicts + field operators (§Selection & filter surface).
- **Identity selection** (targeted): `get <id>…` — by rendered id (grammar below).
- **Identical capabilities, selection-appropriate defaults** (below).

## Selection & filter surface (groomed 2026-06-10 — `MMR-33`/`MMR-37`; built, shipped in v0.2.0)

Supersedes `--predicate`. Three orthogonal pieces, AND-composed; **no OR** (accepted — `--in` covers within-field any-of). The DTO field renames `state` → **`status`** in the same stroke (one word on every surface; ADR 0008 Refinement).

- **`--status <word>`** — the selection **universe**. Vocabulary = the closed status words (`ready` `awaiting` `in_progress` `blocked` `parked` `done` `abandoned`) + unions: **`live`** (the default — today's misnamed `all`), **`terminal`**, **`all`** (now honestly everything). Terminal selections order by `completed_at` desc (no rank outside the rankable set).
- **`--is <verdict>` / `--not-is`** — the derived verdicts that aren't statuses: `stale`, `blocking`, `orphaned` (future `buried`). Repeatable.
- **Field operators** — Norn's dogfooded `find` dialect, ported verbatim: `--eq`/`--not-eq FIELD:VALUE` · `--in`/`--not-in FIELD:V1,V2` (ANY-of) · `--has`/`--missing FIELD` · `--before`/`--on`/`--after FIELD:DATE` (+ `--not-before`/`--not-after` for inclusive bounds). Repeatable, AND-ed. **Queryable fields = the projection's bare fields** (no second vocabulary). **`tag` is a multi-valued pseudo-field**: `eq` = contains, `in` = any, `not-in` = none, `missing` = untagged.
- **Composition rule:** `--status` picks the universe; operators filter within it. No mode-switching on flag presence.

**Value faults warn, structural faults fail.** A well-formed request matching nothing is an _empty set_, not an error: enum miss (`priority:p9`) or unparseable literal (`created_at:notadate`) → **exit 0, empty result, warning**. Unknown field or operator-on-incompatible-type → **usage, exit 2** (the caller's program is wrong). Warnings are the non-fatal member of the diagnostic family — stderr, mirroring the error envelope, with zod-style correction info:

```json
{
  "warning": {
    "code": "no_match_value",
    "field": "priority",
    "value": "p9",
    "message": "p9 is not a priority",
    "expected": ["p0", "p1", "p2", "p3"]
  }
}
```

Human formats render a `⚠` note line on stderr next to the `0 tasks` count. MCP (no stderr, no exit codes) folds `warnings` into the response payload beside the result.

**The transition log is deliberately not a query surface.** It exists as carved-out substrate (ADR 0003); consolidation runs read it raw and shape it themselves. "What got done since X" is a stored-fact query: `list --status done --after completed_at:<ts>`.

## Identity grammar (addressability contract)

_Groomed 2026-06-10 from dogfood findings; implementation: `MMR-32`._

Every entity has **exactly one rendered id**, and every surface speaks it — echoes, errors, facets, deps, history, JSON DTOs, MCP envelopes. Internal integer ids never cross the surface.

| entity                            | rendered id                           | example  |
| --------------------------------- | ------------------------------------- | -------- |
| project                           | bare `KEY`                            | `MMR`    |
| tree node (initiative/phase/task) | `KEY-seq`                             | `MMR-22` |
| artifact                          | `KEY-aN` (project-scoped, like tasks) | `MMR-a1` |

- **Any id-position accepts the full grammar; the _verb_ rejects types it can't act on** as a behavioral error (`done MMR` → "MMR is a project, not a task"). No per-verb parser carve-outs.
- **Selector flags are not id-positions** — `--scope` takes a project `KEY`, `--parent` a container id; their narrowness is behavioral too.
- Supersedes the Phase-3 `#N` artifact echo (global integer, shell-hostile `#`) — a pre-release contract fix, no external consumers.

## Projection vocabulary (`--col`)

One **flat, closed** vocabulary on every selection front-end — _the dot-facet prefix is dropped_ (groomed 2026-06-10, `MMR-38`). The dot was a Norn carryover whose justifying condition doesn't travel: Norn fences structural facets from a _dynamic, user-defined_ frontmatter namespace; Mimir's schema is closed, so no collision exists and the punctuation only taxed callers. Some columns return sets — the heavy/cheap distinction lives in **defaults** and help grouping, not syntax.

### Bare fields

| field                                        | on    | notes                                                                                                                                                       |
| -------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                         | all   | rendered `KEY-seq`; always-present identity (the `records` header — Mimir's analog of Norn's `.path`). Surrogate int never exposed (ADR 0006).              |
| `type`                                       | all   | `task` \| `phase` \| `initiative` \| `project`                                                                                                              |
| `title`                                      | all   |                                                                                                                                                             |
| `status`                                     | all   | the single derived **status word** (ADR 0008 + Refinement; field renamed from `state` 2026-06-10, `MMR-37`); for a non-leaf it is `interpret(distribution)` |
| `parent`                                     | all   | parent's `id`, or null                                                                                                                                      |
| `description`                                | all   |                                                                                                                                                             |
| `priority`                                   | task  | `p0`–`p3` or null (signal, ADR 0007)                                                                                                                        |
| `size`                                       | task  | `small` \| `medium` \| `large` or null                                                                                                                      |
| `lifecycle`                                  | task  | raw axis — `todo` \| `in_progress` \| `done` \| `abandoned`                                                                                                 |
| `hold`                                       | task  | raw axis — `none` \| `blocked` \| `parked`                                                                                                                  |
| `hold_reason`                                | task  | or null                                                                                                                                                     |
| `target`                                     | phase | the milestone the phase aims at                                                                                                                             |
| `external_ref`                               | task  | GitHub issue/PR linkage, or null                                                                                                                            |
| `upstream`                                   | task  | the requester-side seed pointer (`KEY-sN`, MMR-244/245), reference-only, or null                                                                            |
| `created_at` / `updated_at` / `completed_at` | all   | ISO-ms-`Z` UTC; rendered local only at the edge                                                                                                             |

**`status` and the raw axes deliberately coexist.** `status` is the glance; `lifecycle`/`hold` are the detail a script automating a _transition_ must read (it can't reliably parse the collapsed word back into axes). `next` shows only `status`; `get` shows both.

**`rank` is not a field.** Per ADR 0007 the numbers are core-owned; array _order_ carries the intent. A consumer wanting another order filters/sorts by signals (`priority`, `size`), never rank.

### Set-valued columns (heavier — same flat vocabulary)

- `deps` — what this node depends on, plus the derived `blocking` reverse set.
- `annotations` — freeform in-flight notes.
- `artifacts` — attached artifacts: **`id` (`KEY-aN`), required `title`, tags, `created_at`** (groomed 2026-06-10, `MMR-34`: title is a required column — CLI defaults to the `--file` basename, MCP requires it; `attach` grows `--tag`; classification stays tags per ADR 0004, never a kind enum). **Bodies** via `get KEY-aN --col content` — realigning with this note's original `get <artifact-id>` intent, which Phase 3 under-delivered (the `#N` echo was unaddressable).
- `content` — an **artifact's** frozen body. The one deliberately heavy column; opt-in always.
- `history` — the transition log (`kind`, from→to, `at`, `reason`). Heavy; opt-in even on `get`.
- `tags` — tags on this node.
- `children` — child nodes (`id` + `status`) for tree navigation.
- `distribution` — a non-leaf's rollup breakdown (`{done:3, ready:1}`); pairs with the `status` label (ADR 0008).
- `verdicts` — the non-status derived predicates in one read: `{stale, blocking, orphaned}` booleans (the `--is` vocabulary; the status word carries everything else). Added at Phase 4 (`MMR-14`) for the API record's always-on derivation; opt-in via `--col verdicts` on the CLI/MCP.

## Selection-appropriate defaults

- **`next` / `list`** (broad) → lean: **`id, status, priority, parent, title`** — `parent` is the row's hierarchy anchor (added `MMR-87`; `description` stays out, it's one `get` away once a row is picked).
- **`get <id>`** (targeted) → full record: all scalar fields + cheap set columns (`deps`, `tags`, `children`, `distribution`, `annotations`, `artifacts`); heavy `history`/`content` stay opt-in.
- A broad "full structured dump" modifier (`--all-cols`) includes every bare field + cheap facet, excludes heavy/expensive facets (Norn's `--all-cols` semantics).

## Formats (two-layer split)

_Layout style_ — the styled formats `records` + `table` (colors, icons, spacing) — is **evolvable and never parsed**; the _structural contract_ (`ids`/`json`/`jsonl`) is a **versioned promise**. Structured formats never emit ANSI; set-returning commands lead with a count.

**`isTTY` governs _decoration_ only, never _information_ (`MMR-87`).** The default is `table` for a set, `records` for a single node — **the same fields whether interactive or piped**; a pipe only drops the ANSI (color is already suppressed by `plain = NO_COLOR || !isTTY`). `ids`/`json`/`jsonl` are **explicit `-f` opt-ins**: `ids` for a genuine shell pipeline, `json`/`jsonl` to parse the embedded facet arrays. The non-TTY consumer is overwhelmingly an agent reading to decide (the ADR 0011 skill path), for whom bare ids carry no decision information; the old "pipe → `ids`" default optimized for a `| xargs` consumer that barely exists. (`status` is json everywhere; the `service`/`self-update` **report** keeps its split — prose in a terminal, json piped — see `MMR-59`.)

| format    | role                                                                                                                                   | stable?                     |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `table`   | **set-view default** (`next`/`list`, piped or TTY) — one task per line; icon+color highlight `state` (TTY only); rank order, count-led | no — styled, never parse it |
| `records` | **detail default** (`get`, piped or TTY) — bold `id` header + aligned `label  value` rows                                              | no — styled, never parse it |
| `ids`     | **explicit opt-in** (`-f ids`) — one `KEY-seq` per line; the composable pipeline / id-capture form                                     | yes                         |
| `json`    | one-shot — tight wrapper `{ total, returned, starts_at, tasks: [ … ] }` (array key = unit)                                             | yes, versioned              |
| `jsonl`   | streaming — one object per line, no wrapper                                                                                            | yes                         |

Wrapper carries nothing derivable (`truncated = returned < total`). Array key names the unit (`tasks`; other units as verbs are added).

### The `table` format (set-view rendering)

One task per line — `id`, a `state` cell, `priority`, `parent`, `title` — scannable top-to-bottom in rank order, led by a count line. State is highlighted by an **icon + color**, but the state **word** is always present in the cell: color/icon only _highlight_, so `--ascii` and NO*COLOR fallbacks lose nothing ([ADR 0009](decisions/0009-adopt-norn-output-and-selection-contract.md) / Norn's "color is decoration, never information"). The \_roles* — a distinct icon + color per **State word** — are fixed; the exact glyph set and palette are a **brand-pass deferral** (Mimir's own identity, not Norn's).

```
8 tasks

MMR-16   ● ready      p1   MMR-2    write the first migration
MMR-23   ● ready      p2   MMR-2    core rollup functions
MMR-09   ◔ awaiting   p0   MMR-5    mcp read tools
```

(glyphs illustrative — pending the brand pass.)

## Layout style — adopted, brand deferred

Adopt Norn's tool-agnostic **primitives** (count line, record block, table rows, separator, glyph set, ≤4-space indentation) and **house principles**: counts-before-contents; color is decoration, never information; structured formats never carry style; quiet by default (no banners/celebration); lowercase house style; NO_COLOR/`--ascii` lose nothing. **Mimir's brand** (palette, voice, identity glyphs) is a deferred branding pass — not a permanent inheritance of Norn's.

## Write contract (mutations)

Mutations are high-level verbs (never a raw `status` patch — glossary **Lifecycle verb**). Canonical names are `*_task`/`*_node`; the CLI renders them tersely.

| concern          | verb(s)                                                   | notes                                                                                                          |
| ---------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| lifecycle        | `start` · `done` · `abandon(reason?)`                     | `done` stamps `completed_at`; `abandon` reason → transition log                                                |
| hold             | `park(reason?)` · `unpark` · `block(reason?)` · `unblock` | sets/clears the `hold` overlay; never touches lifecycle                                                        |
| dependency edges | `depend(id, --on ids)` · `undepend`                       | **not** `block` — edges produce derived `awaiting`/`blocking`; the spec's `block_task`-for-edges is superseded |
| structural       | `move(id, --to parent)`                                   | validates cycle/type                                                                                           |
| data             | `update(id, fields)`                                      | dumb scalar patch; `status` excluded                                                                           |

- **Every mutation echoes the affected node** in the **lean projection** (`id, title, state, priority, size`) — a write needs no follow-up `get` (Norn's "prevent the extra turn"). In `--json` it returns the bare node object, **not** the set wrapper. (`attach` echoes the artifact id `{"artifact":{"id"}}`; `create project` echoes `{"project":{"key","name"}}` — the two echo exceptions.)
- Every status-bearing verb appends a `transition_log` row in the same transaction (ADR 0003).

### Verb surface (Phase 3 — CLI; MCP mirrors with named args)

| verb                                        | CLI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| start · done                                | `mimir done <id>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| abandon                                     | `mimir abandon <id> [reason]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| park/unpark · block/unblock                 | `mimir park <id> [reason]` · `mimir unpark <id>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| depend · undepend                           | `mimir depend <id> --on <ids>` (comma-sep)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| move                                        | `mimir move <id> --to <parent>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| reorder                                     | `mimir reorder <id> --top\|--bottom\|--before <id>\|--after <id>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| update                                      | `mimir update <id> [--title --desc --priority --size --target --ref]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| annotate                                    | `mimir annotate <id> <text>` (or stdin)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| create                                      | `create project --key K --name N [--repo --path]` · `create <initiative\|phase\|task> "title" --parent <KEY\|id> [signals] [--tag <t>…]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| attach                                      | `mimir attach <id> --file <path> [--title <t>] [--tag <t>…] [--link <ids>]` → echoes `KEY-aN`; `title` required (CLI defaults to the file basename; MCP requires it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| tag · untag _(`MMR-31`, shipped in v0.2.0)_ | `mimir tag <ids> <tag>… [--note <text>]` · `mimir untag <ids> <tag>…` — ids comma-list × tags variadic; reaches all three entity types per the identity grammar; `untag` is a plain row delete, **not** transition-logged (membership is a fact-about-now); vocabulary free-text, conventions live in consumers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| seed · seeds _(`MMR-245`)_                  | `mimir seed "<title>" -k <kind> [-p KEY] [--desc …]` files a grooming-queue seed (`KEY-sN`; target + requester default from the bound board; an empty requester self-files) · `mimir seeds [-p KEY\|all] [--requester KEY] [--status <s>] [--sort asc\|desc] [--grouped]` reads the queue (live + oldest-first by default; `-p all` = every active board; `--grouped` = the lane view). Echoes the seed record (`-f ids` prints the `KEY-sN`). The wire carries `lane` (untriaged/ready/promoted/settled) so consumers derive nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| get KEY-sN _(`MMR-245`)_                    | `mimir get KEY-sN` reads one seed (the resolved view + `## Seed Description` prose) — the id grammar routes s-ids to the seed reader, matching MCP `get_seed` / HTTP `GET /api/seeds/:id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| promote _(`MMR-245`)_                       | `mimir promote KEY-sN --parent <node> [--priority --size --desc --title --tag…]` creates a task from the seed (or `--link KEY-seq` records existing work), appends the `spawned` link, and moves `new → promoted` (repeatable while promoted; `--parent`/`--link` are mutually exclusive). The echo carries the seed plus a sibling `created` (the spawned task id) in create mode — on MCP + HTTP too                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| reject · resolve _(`MMR-245`)_              | `mimir reject KEY-sN "<reason>"` · `mimir resolve KEY-sN "<resolution>"` — the terminal seed transitions; reason **required**; both reachable from `new` or `promoted`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| update KEY-sN _(`MMR-245`)_                 | `mimir update KEY-sN [--title --kind --desc]` patches a live seed (the id grammar routes s-ids to the seed store); `resolved`/`rejected` seeds refuse patches. A node-only flag (`--priority`, `--size`, …) on a seed update is a **usage error (exit 2)**, not a validation error. `--upstream KEY-sN` on `create task` / `update KEY-seq` sets the requester-side seed pointer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| triage _(`MMR-246`)_                        | `mimir triage [KEY] [--dry-run] [--format …]` — the explicit-run reconciliation pass over ONE board (bare = the bound board). Three checks: (a) untriaged seeds, (b) ready-to-resolve seeds, (c) the board's own tasks whose `upstream` seed went terminal → an **idempotent** annotation (`upstream KEY-sN resolved\|rejected: <reason>`, the marker head `upstream <KEY-sN> <resolved\|rejected>` is the machine-recognizable idempotency key) + an unblock **suggestion**. **Writes by default** (running it is the intent); **never transitions**; `--dry-run` previews with no writes. A **report, never a gate** — always **exit 0** (like `doctor`). Format is the `report` split (human in a terminal, `json` piped; `--format json`/`jsonl` for the machine shape — `jsonl` is the composite report on one line, not a per-record stream; `ids` prints the check-(c) task ids). MCP `triage` mirrors 1:1; **HTTP is out of scope** (the report is operator/agent-facing; the console's triage surface is the seeds queue UI, MMR-247). Timer/eventual-consistency mode is **deferred** |

- **IDs** are `KEY-seq` (nodes) / bare `KEY` (projects), resolved in the transport; **`--parent` is polymorphic** (bare KEY = project; KEY-seq = node). Lists are comma-separated (CLI) / arrays (MCP). MCP mirrors these as **named args** — no positionals, no files/stdin (`content` is a required arg).
- **`create`** takes an explicit type (not inferable from parent). **`attach`** is node-first (infers the owning project) and enforces the **project-consistency rule**: all node refs (primary + links) must share one project, validated _before_ any write.

## Exit codes

Adopted from Norn — keyed to selection mode:

- **Identity selection** (`get`) and **any mutation** → **non-zero** on a missing named target or an invariant violation (a real failure).
- **Predicate selection** (`next` / `list`) → **exit 0 on empty** — a predicate matching nothing is not an error.

**Concrete taxonomy (Phase 3):** coarse `0` / `1` / `2` — `0` success (incl. an empty predicate set) · `2` usage (bad invocation: arg parse, unknown command/flag/value) · `1` operational (any core `MimirError`). The precise category lives **only** in the envelope `code`; the exit status stays coarse. Source = _where_ the failure arises: the transport's arg layer → 2; a core `MimirError` → 1.

## Error rendering (two families)

Errors flow through the same selection→format pipeline as success, but **stream is orthogonal to format**: success → stdout, error → stderr (always); stdout stays empty on failure.

- **Machine (`json` / `jsonl`):** `{"error":{"code","message","hint?"}}`. `hint` present only when remediation is offered.
- **Human (`records` / `table` / `ids`):** the Norn line `✗ <message>` (`[err]` when `--ascii` / `NO_COLOR`) + optional `note: <hint>` line — the glyph carries severity, the code is omitted.
- **MCP:** the same envelope as the `isError` text content (no exit codes).
- **Envelope `code` vocabulary:** `usage · not_found · validation · conflict · invariant` — the four core `MimirError` codes plus the transport-level **`usage`** (CLI-only; the same semantic _invocation_ fault surfaces as `validation` over MCP, which has no `usage`/exit-code concept).

## Help tiers

`-h` terse (synopsis + flags); `--help` fuller, **with usage examples**.

## Resolved (Phase 3)

The former build-time TBDs are settled and implemented (merged 2026-06-05; mimir-build-roadmap Phase 3): the **error envelope** + stream discipline (§Error rendering), the **exit-code taxonomy** (§Exit codes), and the **per-verb argument shapes** (§Verb surface). The intent verb list is the verbs in the Write contract. The CLI `--json` _input_ form was declined (YAGNI) — MCP is the structured-input path; the CLI takes flags/positionals (with stdin for `annotate`/`attach` content only). Known minor debt carried forward: an empty/blank required flag token (e.g. `--on ""`) resolves to `not_found`/exit 1 rather than `usage`/exit 2.

- **Per-format worked examples** for each command.

/** Two help tiers: `-h` terse (synopsis + flags), `--help` fuller with examples. */

export const TERSE_HELP = `mimir — query and manage work state

usage: mimir <command> [options]

read commands:
  next            ready tasks in rank order ("what's next")
  list            broad selection by predicate/scope/tag
  get <id>        full record: node (KEY-seq), project (KEY), artifact (KEY-aN)
  status <id>     rollup distribution + status (node KEY-seq or project KEY)

manage commands:
  lifecycle:
    start <id>              begin a task (todo → in_progress)
    done <id>               complete a task
    abandon <id> [reason]   abandon a task (kept, not deleted)

  holds:
    park <id> [reason]      put a task on hold
    unpark <id>             clear the parked hold
    block <id> [reason]     mark as externally blocked
    unblock <id>            clear the blocked hold

  structure:
    depend <id> --on <ids>              add dependency edges
    undepend <id> --on <ids>            remove dependency edges
    move <id> --to <parent>             re-parent a node
    reorder <id> --top|--bottom|        change rank within parent
             --before <id>|--after <id>

  data:
    update <id> [--title …] [--priority …] [--size …] …   patch fields
    annotate <id> <text>                append a freeform note
    tag <ids> <tag>… [--note <text>]    tag entities (ids comma-separated)
    untag <ids> <tag>…                  remove tags (plain delete, unlogged)

  create/attach:
    create <type> <name> […]            create project/initiative/phase/task
                                        (repeatable --tag <t> tags at creation)
    attach <id> --file <path>           freeze an artifact onto a node

options:
  -s, --scope <KEY>       limit to a project
  -p, --priority <p0..p3> filter by priority (signal, not sort)
      --size <s|m|l>      filter by size
      --predicate <name>  list: all|ready|awaiting|blocked|stale|blocking|orphaned
  -t, --tag <tag>         list: filter by tag
  -n, --limit <n>         cap the result count
      --col .<facet>      add a facet (.deps .tags .children .distribution
                          .annotations .artifacts .history)
  -f, --format <fmt>      table|records|ids|json|jsonl (default by destination)
      --ascii             no color/icons
  -h, --help              -h terse, --help with examples

  write-verb flags:
      --on <ids>          depend/undepend: comma-separated dependency ids
      --to <parent>       move: destination parent (KEY or KEY-seq)
      --before <id>       reorder: insert before this sibling
      --after <id>        reorder: insert after this sibling
      --top               reorder: move to first position
      --bottom            reorder: move to last position
      --parent <KEY|id>   create: parent node for initiative/phase/task
      --key <KEY>         create project: short identifier key
      --name <name>       create: display name (project)
      --title <text>      create/update: title text
      --desc <text>       create/update: description
      --target <text>     create/update: target date or milestone
      --ref <ref>         create/update: external reference
      --file <path>       attach: path to artifact file
      --link <ids>        attach: additional node links (comma-separated)
      --project <KEY>     attach: associate artifact with a project key
      --note <text>       tag: note stored with each tag application
      --tag <t>           create: tag at creation (repeatable)

other: mimir migrate [status] · mimir mcp
`;

export const FULL_HELP = `${TERSE_HELP}
examples:
  mimir next --scope MMR              # what to work on next in project MMR
  mimir next -p p0                    # highest-priority ready tasks
  mimir list --predicate stale        # tasks that have gone quiet
  mimir get MMR-16                    # full record (cheap facets included)
  mimir get MMR-16 --col .history     # add the transition log
  mimir status MMR-3                  # rollup of an initiative/phase
  mimir next --format json | jq .     # structured output for scripts

  mimir create task "wire the API" --parent MMR-2 --priority p1
  mimir start MMR-3                   # begin work
  mimir done MMR-3                    # complete it
  mimir depend MMR-4 --on MMR-3       # MMR-4 waits on MMR-3
  mimir attach MMR-3 --file plan.md   # freeze an artifact onto a task
  mimir tag MMR-3,MMR-a1 spec v2      # tag a task and an artifact
  mimir untag MMR-3 v2                # remove a tag

notes:
  - ids: project = bare KEY, node = KEY-seq, artifact = KEY-aN; any id
    position takes the full grammar — the verb rejects what it can't act on.
  - identity selection (get/status) exits non-zero on a missing id;
    predicate selection (next/list) exits 0 on an empty result.
  - mutations exit non-zero on a missing id or invariant violation and
    echo the affected node on success.
  - rank is never shown — array order is the order (ADR 0007).
  - structured formats (ids/json/jsonl) never carry color; pipe-safe.
`;

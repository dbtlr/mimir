/** Two help tiers: `-h` terse (synopsis + flags), `--help` fuller with examples. */

export const TERSE_HELP = `mimir — query and manage work state

usage: mimir <command> [options]

read commands:
  next            ready tasks in rank order ("what's next")
  list            broad selection by predicate/scope/tag
  get <id>        full record for one node (KEY-seq)
  status <id>     a node's rollup distribution + state

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

notes:
  - identity selection (get/status) exits non-zero on a missing id;
    predicate selection (next/list) exits 0 on an empty result.
  - rank is never shown — array order is the order (ADR 0007).
  - structured formats (ids/json/jsonl) never carry color; pipe-safe.
`;

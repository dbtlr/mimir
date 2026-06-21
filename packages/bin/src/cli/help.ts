/** Two help tiers: `-h` terse (synopsis + flags), `--help` fuller with examples. */

export const TERSE_HELP = `mimir — query and manage work state

usage: mimir <command> [options]

read commands:
  next            ready tasks in rank order ("what's next")
  list            broad selection by predicate/scope/tag
  get <id>        full record: node (KEY-seq), project (KEY), artifact (KEY-aN)
  status <id>     rollup distribution + status (node KEY-seq or project KEY)
  tree <id>       full subtree rooted at any node (KEY-seq) or project (KEY)
                  compact indented view: id · status · title; use after get/status
                  to drill into a container's hierarchy

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
    update <id> [--title …] [--priority …] [--size …] …   patch fields (KEY-aN: --title only)
    annotate <id> <text>                append a freeform note
    tag <ids> <tag>… [--note <text>]    tag entities (ids comma-separated)
    untag <ids> <tag>…                  remove tags (plain delete, unlogged)

  create/attach:
    create <type> <name> […]            create project/initiative/phase/task
                                        (repeatable --tag <t> tags at creation)
    attach <id> --file <path>           freeze an artifact onto a node

  binding:
    bind <KEY>              bind this directory to a project — writes
                            .mimir.toml, the default --scope from then on

options:
  -s, --scope <KEY>       limit to a project (default: the .mimir.toml
                          binding if present; "all" = every project)
  -p, --priority <p0..p3> filter by priority (signal, not sort)
      --size <s|m|l>      filter by size
  -t, --tag <tag>         list: filter by tag
  -n, --limit <n>         cap the result count

  selection (list/next — AND-composed):
      --status <word>     list: the universe — ready|awaiting|in_progress|
                          blocked|parked|done|abandoned, or unions
                          live (default) | terminal | all
      --is <verdict>      verdicts: stale|blocking|orphaned (repeatable)
      --not-is <verdict>  negated verdict (repeatable)
      --eq F:V            field equals (also --not-eq); --in F:V1,V2 any-of
                          (also --not-in); --has F / --missing F presence
      --before F:DATE     date fields (also --on, --after, --not-before,
                          --not-after); DATE = YYYY-MM-DD or ISO timestamp
                          fields = the bare projection fields; tag is multi-valued
                          (eq=contains, in=any, not-in=none, missing=untagged)
      --col <col>         add a column (deps tags children distribution
                          annotations artifacts history; content on KEY-aN —
                          set-valued columns are heavier, opt-in)
  -f, --format <fmt>      table|records|ids|json|jsonl (default: table for a
                          set, records for a node — piped or not; -f ids for
                          bare ids, -f json to parse)
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
  -y, --yes               create project: confirm the immutable key
                          (required when not at a TTY)
      --name <name>       create project: display name (or positional)
      --title <text>      create/update: title text
      --desc <text>       create/update: description
      --target <text>     create/update: target date or milestone
      --ref <ref>         create/update: external reference
      --file <path>       attach: path to artifact file
      --link <ids>        attach: additional node links (comma-separated)
      --project <KEY>     attach: associate artifact with a project key
      --note <text>       tag: note stored with each tag application
      --tag <t>           create: tag at creation (repeatable)

other:
  skill install [--global|--local] [--agent claude|codex]
                          install the agent skill (default: --global, claude;
                          claude → .claude/skills, codex → .agents/skills)
  serve [--port <n>] [--no-hunt]
                          HTTP API + console (loopback-only; port: --port >
                          config [serve] port > 64647; a taken port hunts
                          upward unless --no-hunt — the startup line names
                          the bound URL)
  service <sub>           supervise serve under launchd (macOS):
                          install [--port <n>] · uninstall · start · stop ·
                          restart · status (--port writes the global config,
                          ~/.config/mimir/config.toml)
  self-update [--next] [--tag <tag>]
                          download + verify a release, replace this binary,
                          restart the service if loaded. default: latest
                          official; --next: latest incl. prereleases; --tag:
                          an exact tag (e.g. v0.6.0-next.5)
  migrate [status] · mcp
`;

export const FULL_HELP = `${TERSE_HELP}
examples:
  mimir next --scope MMR              # what to work on next in project MMR
  mimir next -p p0                    # highest-priority ready tasks
  mimir list --is stale               # tasks that have gone quiet
  mimir list --status done --after completed_at:2026-06-01
  mimir list --eq priority:p1 --missing size
  mimir get MMR-16                    # full record (cheap facets included)
  mimir get MMR-16 --col history      # add the transition log
  mimir get MMR-a1 --col content      # an artifact's frozen body
  mimir status MMR-3                  # rollup of an initiative/phase
  mimir tree MMR                      # full hierarchy under the project
  mimir tree MMR-3                    # subtree rooted at a phase/initiative
  mimir next --format json | jq .     # structured output for scripts

  mimir create task "wire the API" --parent MMR-2 --priority p1
  mimir start MMR-3                   # begin work
  mimir done MMR-3                    # complete it
  mimir depend MMR-4 --on MMR-3       # MMR-4 waits on MMR-3
  mimir attach MMR-3 --file plan.md   # freeze an artifact onto a task
  mimir tag MMR-3,MMR-a1 spec v2      # tag a task and an artifact
  mimir untag MMR-3 v2                # remove a tag
  mimir bind MMR                      # .mimir.toml: default scope for this repo
  mimir list -s all --is stale        # cross-project, ignoring the binding

notes:
  - ids: project = bare KEY, node = KEY-seq, artifact = KEY-aN; any id
    position takes the full grammar — the verb rejects what it can't act on.
  - identity selection (get/status) exits non-zero on a missing id;
    set selection (next/list) exits 0 on an empty result. A value miss
    (--eq priority:p9) warns on stderr and returns an empty set (exit 0);
    an unknown field or wrong-type operator is a usage error (exit 2).
  - mutations exit non-zero on a missing id or invariant violation and
    echo the affected node on success.
  - rank is never shown — array order is the order (ADR 0007).
  - structured formats (ids/json/jsonl) never carry color; pipe-safe.
  - scope default: the nearest .mimir.toml walking up from cwd (mimir bind);
    explicit -s overrides, -s all queries every project.
`;

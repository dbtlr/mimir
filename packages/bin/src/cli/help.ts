/** Two help tiers: `-h` terse (synopsis + flags), `--help` fuller with examples. */
import { DEFAULT_PORT } from '../env';

export const TERSE_HELP = `mimir — query and manage work state

usage: mimir <command> [options]

read commands:
  next            ready tasks in rank order ("what's next")
  list            broad selection by predicate/scope/tag
  get <id>        full record: task/phase/initiative (KEY-seq), project (KEY), artifact (KEY-aN), seed (KEY-sN)
  status <id>     rollup distribution + status (KEY-seq or project KEY)
  tree <id>       full subtree rooted at any KEY-seq or project (KEY)
                  compact indented view: id · status · title; use after get/status
                  to drill into a container's hierarchy

manage commands:
  lifecycle:
    start <id>              begin a task (todo → in_progress)
    submit <id>             submit for review (in_progress → under_review)
    return <id> [reason]    send back for changes (under_review → in_progress)
    done <id>               complete a task (approves a review)
    abandon <id> [reason]   abandon a task (kept, not deleted)
    reopen <id> [reason]    reopen a terminal task (done/abandoned → in_progress)

  holds:
    park <id> [reason]      put a task on hold
    unpark <id>             clear the parked hold
    block <id> [reason]     mark as externally blocked
    unblock <id>            clear the blocked hold

  structure:
    depend <id> --on <ids>              add dependency edges
    undepend <id> --on <ids>            remove dependency edges
    move <id> --to <parent>             re-parent a task or phase
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
    attach <id> --file <path>           freeze an artifact onto a task or phase

  seeds (grooming queue):
    seed "<title>" -k <kind> [-p KEY]   file a seed (idea|bug|feature)
    seeds [--grouped] [-p all] [--status …]   the queue — live, oldest-first (-p all = every board)
    get <KEY-sN>                        read one seed (resolved view + description)
    promote <KEY-sN> --parent <node>    germinate into work (or --link existing); echoes created task id
    reject <KEY-sN> "<reason>"          terminal — reason required
    resolve <KEY-sN> "<resolution>"     terminal — resolution required
    update <KEY-sN> [--title/--kind/--desc]   patch a live seed
    triage [KEY] [--dry-run]            reconcile a board — untriaged / ready-to-resolve / upstream resolutions

  project:
    archive <KEY> [reason]  archive a project — freeze + hide it and its whole
                            subtree (reversible; --status archived lists them)
    unarchive <KEY>         restore an archived project

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
                          under_review|blocked|parked|done|abandoned, or
                          unions live (default) | terminal | all
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
                          set, records for a single result — piped or not; -f ids for
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
      --parent <KEY|id>   create: parent for initiative/phase/task
      --key <KEY>         create project: short identifier key
  -y, --yes               create project: confirm the immutable key
                          (required when not at a TTY)
      --name <name>       create project: display name (or positional)
      --title <text>      create/update: title text
      --desc <text>       create/update: description
      --summary <text>    create/update: summary (all-node; 256 chars max)
      --target <text>     create/update: target date or milestone
      --ref <ref>         create/update: external reference
      --file <path>       attach: path to artifact file
      --link <ids>        attach: additional links — KEY-seq, comma-separated
      --project <KEY>     attach: associate artifact with a project key
      --note <text>       tag: note stored with each tag application
      --tag <t>           create: tag at creation (repeatable)
      -k, --kind <kind>   seed: idea|bug|feature (required)
      --requester <KEY>   seeds: filter to a requesting board
      --status <s>        seeds: new|promoted|resolved|rejected|live|all
      --sort <asc|desc>   seeds: age order (default asc)
      --grouped           seeds: lane view (untriaged/ready/settled)
      --upstream <KEY-sN> create/update task: requester-side seed pointer

other:
  setup [--vault <path>] [--install-service] [--install-snapshot]
        [--port <n>] [--snapshot-interval <s>] [--upstream <url>] [-y]
                          interactive first-install + reconfiguration wizard:
                          converge the vault, write the config, install the
                          launchd units. Prefills current values; re-runnable.
                          Non-interactively takes flags + -y.
  skill install [--global|--local] [--agent claude|codex]
                          install the agent skill (default: --global, claude;
                          claude → .claude/skills, codex → .agents/skills)
  serve [--port <n>] [--no-hunt]
                          HTTP API + console (loopback-only; port: --port >
                          MIMIR_PORT > config [serve] port > ${DEFAULT_PORT}; a
                          taken port hunts upward unless --no-hunt — the
                          startup line names the bound URL)
  service <sub> [unit]    supervise the launchd units (macOS): install
                          [--port <n>] · uninstall · start · stop · restart ·
                          status. unit is serve | snapshot | all; install
                          defaults to serve (snapshot is opt-in), uninstall +
                          the lifecycle verbs sweep whatever is installed.
                          --port writes ~/.config/mimir/config.toml.
                          dev/from-source runs refuse the mutating verbs
                          (status stays open); MIMIR_ALLOW_REAL_SERVICE=1
                          opts in to managing the real launchd
  self-update [--next] [--tag <tag>]
                          download + verify a release, replace this binary,
                          restart the service if loaded. default: latest
                          official; --next: latest incl. prereleases; --tag:
                          an exact tag (e.g. v0.6.0-next.5)
  vault snapshot          commit the vault's working tree (commit-if-dirty),
                          then push + reconcile when an upstream is configured;
                          the cadence behind the scheduled snapshot unit
  doctor                  run vault diagnostics and report problems for a human
                          to fix (nonzero exit on error findings). scoped by -s
  mcp                     the agent envelope over stdio (MCP transport)
`;

// ─── Per-command help (MMR-118) ────────────────────────────────────────────
// A single descriptor per verb drives both tiers: `-h` renders usage + summary
// + args + flags; `--help` adds the examples. Authoring one structured record
// (not two prose strings) keeps the two tiers in lock-step and consistent with
// the top-level help's shape.

type Row = readonly [string, string];

export type CommandHelp = {
  /** One-line synopsis, `mimir <verb> …` form. */
  usage: string;
  /** What the verb does (the `-h` lede). */
  summary: string;
  /** Positional arguments, in order. */
  args?: readonly Row[];
  /** Flags the verb reads. */
  flags?: readonly Row[];
  /** Worked invocations — the `--help` tier only. */
  examples?: readonly string[];
};

// Rows shared across verbs so the wording stays identical everywhere.
const F_SCOPE: Row = [
  '-s, --scope <KEY>',
  'limit to a project (default: the .mimir.toml binding; "all" = every project)',
];
const F_FORMAT: Row = ['-f, --format <fmt>', 'table|records|ids|json|jsonl'];
const F_LIMIT: Row = ['-n, --limit <n>', 'cap the result count'];
const F_COL: Row = ['--col <col>', 'add a column (deps tags children distribution …)'];
const F_PRIORITY: Row = ['-p, --priority <p0..p3>', 'filter by priority (signal, not sort)'];
const F_SIZE: Row = ['--size <s|m|l>', 'filter by size'];
const SELECTION_NOTE: Row = [
  '--is / --eq / …',
  'verdict + field selection (see `mimir --help` for the full grammar)',
];
const A_ID: Row = ['<id>', 'KEY-seq (task/phase/initiative), KEY (project), or KEY-aN (artifact)'];
const A_REASON: Row = ['[reason]', 'optional note recorded in the transition log'];

// Grouped by concern to mirror the top-level help (read → lifecycle → holds →
// structure → data → create/attach → binding), not alphabetical — the reader
// scans it the same way as `mimir --help`.
/* oxlint-disable sort-keys */
export const COMMAND_HELP: Record<string, CommandHelp> = {
  // ── read ──
  next: {
    examples: [
      'mimir next -s MMR              # what to work on next in project MMR',
      'mimir next -p p0               # highest-priority ready tasks',
      'mimir next --format json | jq  # structured output for scripts',
    ],
    flags: [F_SCOPE, F_PRIORITY, F_SIZE, SELECTION_NOTE, F_LIMIT, F_COL, F_FORMAT],
    summary: 'ready tasks in rank order ("what\'s next").',
    usage: 'mimir next [selection]',
  },
  list: {
    examples: [
      'mimir list --is stale                       # tasks that have gone quiet',
      'mimir list --status done --after completed_at:2026-06-01',
      'mimir list --eq type:phase                  # filter to phases',
      'mimir list -s all --is stale                # cross-project, ignoring the binding',
    ],
    flags: [
      ['--status <word>', 'the universe: ready|in_progress|…|done|all (default: live)'],
      F_SCOPE,
      ['-t, --tag <tag>', 'filter by tag'],
      SELECTION_NOTE,
      F_PRIORITY,
      F_SIZE,
      F_LIMIT,
      F_COL,
      F_FORMAT,
    ],
    summary: 'broad selection by predicate, scope, or tag.',
    usage: 'mimir list [selection]',
  },
  get: {
    args: [A_ID],
    examples: [
      'mimir get MMR-16               # full record (cheap facets included)',
      'mimir get MMR-16 --col history # add the transition log',
      "mimir get MMR-a1 --col content # an artifact's frozen body",
      'mimir get MMR-s1               # a seed (resolved view + description)',
    ],
    flags: [F_COL, F_FORMAT],
    summary:
      'full record: task/phase/initiative (KEY-seq), project (KEY), artifact (KEY-aN), or seed (KEY-sN).',
    usage: 'mimir get <id>',
  },
  status: {
    args: [A_ID],
    examples: ['mimir status MMR-3             # rollup of an initiative/phase'],
    flags: [F_FORMAT],
    summary: 'rollup distribution + status (KEY-seq or project KEY).',
    usage: 'mimir status <id>',
  },
  tree: {
    args: [A_ID],
    examples: [
      'mimir tree MMR                 # full hierarchy under the project',
      'mimir tree MMR-3               # subtree rooted at a phase/initiative',
    ],
    flags: [F_FORMAT],
    summary: 'full subtree rooted at any KEY-seq or project (KEY).',
    usage: 'mimir tree <id>',
  },
  // ── lifecycle ──
  start: {
    args: [A_ID],
    examples: ['mimir start MMR-3'],
    summary: 'begin a task (todo → in_progress).',
    usage: 'mimir start <id>',
  },
  submit: {
    args: [A_ID],
    examples: ['mimir submit MMR-3'],
    summary: 'submit for review (in_progress → under_review).',
    usage: 'mimir submit <id>',
  },
  return: {
    args: [A_ID, A_REASON],
    examples: ['mimir return MMR-3 "needs tests"'],
    summary: 'send back for changes (under_review → in_progress).',
    usage: 'mimir return <id> [reason]',
  },
  done: {
    args: [A_ID],
    examples: ['mimir done MMR-3'],
    summary: 'complete a task — approves a review, stamps completed_at.',
    usage: 'mimir done <id>',
  },
  abandon: {
    args: [A_ID, A_REASON],
    examples: ['mimir abandon MMR-3 "superseded by MMR-9"'],
    summary: 'abandon a task (kept, not deleted).',
    usage: 'mimir abandon <id> [reason]',
  },
  reopen: {
    args: [A_ID, A_REASON],
    examples: ['mimir reopen MMR-3'],
    summary: 'reopen a terminal task (done/abandoned → in_progress).',
    usage: 'mimir reopen <id> [reason]',
  },
  // ── holds ──
  park: {
    args: [A_ID, A_REASON],
    examples: ['mimir park MMR-3 "waiting on design"'],
    summary: 'put a task on hold (parked overlay; lifecycle untouched).',
    usage: 'mimir park <id> [reason]',
  },
  unpark: {
    args: [A_ID],
    examples: ['mimir unpark MMR-3'],
    summary: 'clear the parked hold.',
    usage: 'mimir unpark <id>',
  },
  block: {
    args: [A_ID, A_REASON],
    examples: ['mimir block MMR-3 "upstream API down"'],
    summary: 'mark as externally blocked (blocked overlay; lifecycle untouched).',
    usage: 'mimir block <id> [reason]',
  },
  unblock: {
    args: [A_ID],
    examples: ['mimir unblock MMR-3'],
    summary: 'clear the blocked hold.',
    usage: 'mimir unblock <id>',
  },
  // ── structure ──
  depend: {
    args: [A_ID],
    examples: ['mimir depend MMR-4 --on MMR-3        # MMR-4 waits on MMR-3'],
    flags: [['--on <ids>', 'comma-separated dependency ids (KEY-seq)']],
    summary: 'add dependency edges — <id> waits on each of <ids>.',
    usage: 'mimir depend <id> --on <ids>',
  },
  undepend: {
    args: [A_ID],
    examples: ['mimir undepend MMR-4 --on MMR-3'],
    flags: [['--on <ids>', 'comma-separated dependency ids (KEY-seq)']],
    summary: 'remove dependency edges.',
    usage: 'mimir undepend <id> --on <ids>',
  },
  move: {
    args: [A_ID],
    examples: ['mimir move MMR-4 --to MMR-2'],
    flags: [['--to <parent>', 'destination parent (KEY or KEY-seq)']],
    summary: 're-parent a task or phase (validates cycle/type).',
    usage: 'mimir move <id> --to <parent>',
  },
  reorder: {
    args: [A_ID],
    examples: ['mimir reorder MMR-4 --top', 'mimir reorder MMR-4 --after MMR-3'],
    flags: [
      ['--top', 'move to first position'],
      ['--bottom', 'move to last position'],
      ['--before <id>', 'insert before this sibling'],
      ['--after <id>', 'insert after this sibling'],
    ],
    summary: 'change rank within the parent.',
    usage: 'mimir reorder <id> --top|--bottom|--before <id>|--after <id>',
  },
  // ── data ──
  update: {
    args: [A_ID],
    examples: [
      'mimir update MMR-3 --priority p1 --size m',
      'mimir update MMR-3 --desc "clarified scope"',
      'mimir update MMR --name "Mimir core"        # rename a project',
    ],
    flags: [
      ['--title <text>', 'title text'],
      ['--desc <text>', 'description'],
      ['--summary <text>', 'summary (all-node; 256 chars max)'],
      ['--priority <p0..p3>', 'priority signal'],
      ['--size <s|m|l>', 'size'],
      ['--target <text>', 'target date or milestone'],
      ['--ref <ref>', 'external reference'],
      ['--name <name>', 'project only (KEY): rename it'],
    ],
    summary: 'patch scalar fields (a dumb patch — status is excluded; use the lifecycle verbs).',
    usage:
      'mimir update <id> [--title …] [--desc …] [--summary …] [--priority …] [--size …] [--target …] [--ref …]',
  },
  annotate: {
    args: [A_ID, ['<text>', 'note body (or stdin when omitted)']],
    examples: [
      'mimir annotate MMR-3 "spun out the edge case to MMR-9"',
      'echo "note" | mimir annotate MMR-3',
    ],
    summary: 'append a freeform note (text positional, or piped on stdin).',
    usage: 'mimir annotate <id> <text>',
  },
  tag: {
    args: [
      ['<ids>', 'comma-separated entity ids (task/phase/initiative/project/artifact)'],
      ['<tag>…', 'one or more tag values'],
    ],
    examples: ['mimir tag MMR-3,MMR-a1 spec v2       # tag a task and an artifact'],
    flags: [['--note <text>', 'note stored with each tag application']],
    summary: 'tag entities — ids comma-separated, one or more tags.',
    usage: 'mimir tag <ids> <tag>… [--note <text>]',
  },
  untag: {
    args: [
      ['<ids>', 'comma-separated entity ids'],
      ['<tag>…', 'one or more tag values'],
    ],
    examples: ['mimir untag MMR-3 v2'],
    summary: 'remove tags (a plain delete — not transition-logged).',
    usage: 'mimir untag <ids> <tag>…',
  },
  // ── create / attach ──
  create: {
    args: [['<type>', 'project | initiative | phase | task']],
    examples: [
      'mimir create task "wire the API" --parent MMR-2 --priority p1',
      'mimir create project "Mimir" --key MMR',
    ],
    summary: "create an entity. Run `mimir create <type> --help` for the type's own flags.",
    usage: 'mimir create <project|initiative|phase|task> …',
  },
  'create project': {
    args: [['<name>', 'display name (or --name)']],
    examples: ['mimir create project "Mimir" --key MMR -y'],
    flags: [
      ['--key <KEY>', 'short immutable identifier key (required)'],
      ['-y, --yes', 'confirm the immutable key (required when not at a TTY)'],
      ['--desc <text>', 'description'],
      ['--tag <t>', 'tag at creation (repeatable)'],
    ],
    summary: 'create a project — the tree root. The key is immutable.',
    usage: 'mimir create project <name> --key <KEY> [-y] [--desc <text>] [--tag <t>…]',
  },
  'create initiative': {
    args: [['<title>', 'initiative title']],
    examples: ['mimir create initiative "v1 build" --parent MMR'],
    flags: [
      ['--parent <KEY>', 'the owning project (required)'],
      ['--desc <text>', 'description'],
      ['--summary <text>', 'summary (256 chars max)'],
      ['--tag <t>', 'tag at creation (repeatable)'],
    ],
    summary: 'create an initiative under a project.',
    usage:
      'mimir create initiative <title> --parent <KEY> [--desc <text>] [--summary <text>] [--tag <t>…]',
  },
  'create phase': {
    args: [['<title>', 'phase title']],
    examples: ['mimir create phase "read surface" --parent MMR-1'],
    flags: [
      ['--parent <KEY-seq>', 'the owning initiative (required)'],
      ['--desc <text>', 'description'],
      ['--summary <text>', 'summary (256 chars max)'],
      ['--target <text>', 'target date or milestone'],
      ['--tag <t>', 'tag at creation (repeatable)'],
    ],
    summary: 'create a phase under an initiative.',
    usage:
      'mimir create phase <title> --parent <KEY-seq> [--desc <text>] [--summary <text>] [--target <text>] [--tag <t>…]',
  },
  'create task': {
    args: [['<title>', 'task title']],
    examples: ['mimir create task "wire the API" --parent MMR-2 --priority p1'],
    flags: [
      ['--parent <id>', 'the owning phase or initiative (KEY-seq, required)'],
      ['--priority <p0..p3>', 'priority signal'],
      ['--size <s|m|l>', 'size'],
      ['--desc <text>', 'description'],
      ['--summary <text>', 'summary (256 chars max)'],
      ['--ref <ref>', 'external reference'],
      ['--upstream <KEY-sN>', 'requester-side seed pointer (reference-only)'],
      ['--tag <t>', 'tag at creation (repeatable)'],
    ],
    summary: 'create a task under a phase or initiative.',
    usage:
      'mimir create task <title> --parent <id> [--priority …] [--size …] [--desc …] [--summary …] [--ref …] [--upstream <KEY-sN>] [--tag <t>…]',
  },
  attach: {
    args: [['<id>', 'the primary node (KEY-seq) the artifact attaches to']],
    examples: ['mimir attach MMR-3 --file plan.md   # freeze an artifact onto a task'],
    flags: [
      ['--file <path>', 'artifact file (or piped stdin)'],
      ['--title <t>', 'artifact title (defaults to the file basename)'],
      ['--link <ids>', 'additional links — KEY-seq, comma-separated (one project)'],
      ['--project <KEY>', 'associate with a project key (when no node link)'],
      ['--tag <t>', 'tag at creation (repeatable)'],
    ],
    summary: 'freeze an artifact onto a task or phase → echoes the new KEY-aN.',
    usage:
      'mimir attach <id> --file <path> [--title <t>] [--tag <t>…] [--link <ids>] [--project <KEY>]',
  },
  // ── seeds (MMR-245) ──
  seed: {
    args: [['<capture>', 'the capture blob — the first line is the title, the rest is the body']],
    examples: [
      'mimir seed "apply retries forever on lock timeout" -k bug -p OTHER   # their board, their triage',
      String.raw`mimir seed "dark mode\nrequested by two users on the forum" -k feature -p OTHER   # first line title, rest body`,
      'mimir seed "should captures allow multi-line bodies?" -k idea   # own board: undecided, no statable fix',
    ],
    flags: [
      ['-k, --kind <k>', 'idea | bug | feature (required)'],
      ['-p, --project <KEY>', 'target board (default: the bound board)'],
      ['--desc <text>', 'explicit ## Seed Description body — wins over the blob split'],
    ],
    summary:
      'file a seed — an ask against another board, or an own-board idea with no statable fix. Own-board statable fix → create task. Capture is one blob: first line is the title, rest is the body.',
    usage: 'mimir seed "<title>[\\n<body>]" -k <kind> [-p KEY] [--desc <text>]',
  },
  seeds: {
    examples: [
      "mimir seeds                          # the bound board's live queue, oldest-first",
      'mimir seeds --grouped                # the lane view (untriaged / ready to resolve / settled)',
      'mimir seeds -p all                   # every active board',
      'mimir seeds --status all --sort desc # every seed, newest-first',
      'mimir seeds --requester MMR          # seeds MMR filed on other boards',
    ],
    flags: [
      [
        '-p, --project <KEY>',
        'the board whose queue (default: the bound board; "all" = every board)',
      ],
      ['--requester <KEY>', 'filter to seeds a board requested'],
      ['--status <s>', 'new|promoted|resolved|rejected, or live (default) | all'],
      ['--sort <asc|desc>', 'age order (default asc = oldest-first)'],
      ['--grouped', 'render the lane view with counts'],
      F_FORMAT,
    ],
    summary: 'the grooming queue — live seeds oldest-first (FIFO triage priority).',
    usage: 'mimir seeds [-p KEY] [--requester KEY] [--status <s>] [--sort asc|desc] [--grouped]',
  },
  promote: {
    args: [['<KEY-sN>', 'the seed to promote']],
    examples: [
      'mimir promote MMR-s1 --parent MMR-2 --priority p1   # spawn a task from the seed',
      'mimir promote MMR-s1 --link MMR-7                    # record existing work as spawned',
    ],
    flags: [
      ['--parent <id>', 'create a task under this phase/initiative (KEY-seq)'],
      ['--link <KEY-seq>', 'record an EXISTING node as spawned (no create); excludes --parent'],
      ['--priority <p0..p3>', 'created task: priority'],
      ['--size <s|m|l>', 'created task: size'],
      ['--desc <text>', "created task: description (defaults to the seed's)"],
      ['--title <text>', "created task: title (defaults to the seed's)"],
      ['--tag <t>', 'created task: tag at creation (repeatable)'],
    ],
    summary:
      'germinate a seed into work — creates a task (or records existing work), appends the spawned link, and moves new → promoted (repeatable). Echoes the seed plus the created task id.',
    usage: 'mimir promote <KEY-sN> --parent <node> [task args] | --link <KEY-seq>',
  },
  reject: {
    args: [
      ['<KEY-sN>', 'the seed to reject'],
      ['<reason>', 'why (required)'],
    ],
    examples: ['mimir reject MMR-s1 "out of scope"'],
    summary: 'reject a seed (terminal) — reachable from new or promoted; reason required.',
    usage: 'mimir reject <KEY-sN> "<reason>"',
  },
  resolve: {
    args: [
      ['<KEY-sN>', 'the seed to resolve'],
      ['<resolution>', 'how (required)'],
    ],
    examples: ['mimir resolve MMR-s1 "shipped in MMR-9"', 'mimir resolve MMR-s2 "already fixed"'],
    summary: 'resolve a seed (terminal) — reachable from new or promoted; resolution required.',
    usage: 'mimir resolve <KEY-sN> "<resolution>"',
  },
  triage: {
    args: [['[KEY]', 'the board to reconcile (default: the bound board)']],
    examples: [
      "mimir triage                 # reconcile the bound board's queue",
      'mimir triage MMR             # reconcile a specific board',
      'mimir triage --dry-run       # preview; write no annotations',
      'mimir triage -f json | jq    # machine-readable report',
    ],
    flags: [
      ['--dry-run', 'preview only — report what WOULD be annotated, write nothing'],
      ['--format <fmt>', 'json (pretty) | jsonl (one-line); table/records render a human report'],
    ],
    summary:
      "an explicit-run reconciliation pass over ONE board (MMR-246): (a) surfaces new/untriaged seeds, (b) flags promoted seeds whose spawned work has all settled (ready to resolve — never auto-closed), and (c) over the board's own tasks whose upstream seed went terminal, appends an idempotent annotation recording the resolution and suggests unblock. WRITES the check-(c) annotations by default (running it is the intent); NEVER transitions anything (unblock/resolve stay suggestions); --dry-run previews. A report, never a gate — always exits 0. Idempotent: a re-run recognizes its own annotations and is a no-op. Self-contained per board (timer/eventual-consistency mode deferred).",
    usage: 'mimir triage [KEY] [--dry-run] [--format <fmt>]',
  },
  // ── project ──
  archive: {
    usage: 'mimir archive <KEY> [reason]',
    summary:
      'archive a project — freeze (no mutation under it) + hide it, its subtree, and its artifacts from default reads. Reversible.',
    args: [
      ['<KEY>', 'the project to archive (bare project key)'],
      ['[reason]', 'optional note recorded on the archive transition'],
    ],
    examples: [
      'mimir archive SAGA "superseded by SAGA2"',
      'mimir list --status archived        # the archived projects (the one door)',
    ],
  },
  unarchive: {
    usage: 'mimir unarchive <KEY>',
    summary: 'restore an archived project (archived → active) — unfreezes and unhides it.',
    args: [['<KEY>', 'the archived project to restore (bare project key)']],
    examples: ['mimir unarchive SAGA'],
  },
  // ── setup wizard (MMR-145) ──
  setup: {
    examples: [
      'mimir setup                          # interactive first install / reconfigure',
      'mimir setup --vault ~/.local/share/mimir/vault --install-service -y',
      'mimir setup --install-snapshot --snapshot-interval 900 --upstream git@host:me/vault.git -y',
    ],
    flags: [
      [
        '--vault <path>',
        'vault location (~ expanded; default: current config, else the build default)',
      ],
      ['--install-service', 'install/update the serve launchd unit (macOS)'],
      ['--port <n>', 'serve port to persist (honored by serve even without the unit)'],
      ['--install-snapshot', 'install/update the auto-snapshot launchd unit (macOS)'],
      [
        '--snapshot-interval <s>',
        'snapshot cadence in seconds (requires --install-snapshot; default 900)',
      ],
      ['--upstream <url>', 'snapshot upstream (requires --install-snapshot; omit to clear)'],
      ['-y, --yes', 'run non-interactively from flags (required when not a TTY)'],
    ],
    summary:
      'first-install + reconfiguration wizard — converge the vault, write the global config, install/update the launchd units you opt into (removal is `service uninstall`). Prefills current values; safe to re-run.',
    usage:
      'mimir setup [--vault <path>] [--install-service] [--install-snapshot] [--port <n>] [--snapshot-interval <s>] [--upstream <url>] [-y]',
  },
  // ── vault cadence (MMR-146) ──
  vault: {
    examples: [
      'mimir vault snapshot                 # commit the vault; push if an upstream is set',
    ],
    summary:
      "snapshot the vault's git working tree (commit-if-dirty), then push and reconcile a diverged upstream (fetch + merge). Quiet on success; the scheduled unit calls it on an interval.",
    usage: 'mimir vault snapshot',
  },
  // ── vault diagnostics (MMR-166) ──
  doctor: {
    examples: [
      'mimir doctor                         # check the bound scope; always exits 0 (findings are output)',
      'mimir doctor -s all --format json    # every project, machine-readable findings',
    ],
    flags: [
      [
        '-s, --scope <KEY>',
        'limit to a project (default: the .mimir.toml binding; "all" = every project)',
      ],
      [
        '--format <fmt>',
        'json (pretty array) | jsonl (one finding per line); table/records render a human report',
      ],
    ],
    summary:
      'run the vault diagnostics registry and report problems for a human to fix. Non-gating (ADR 0017): a successful run always exits 0 — findings are output, not status — and each finding carries an informational severity label (error = a record the reader drops; warn = a heading-shaped line the reader still reads as content). Checks body-section record integrity plus referential validity (dangling refs, missing projects, cycles, node fields).',
    usage: 'mimir doctor [-s <KEY>] [--format <fmt>]',
  },
  // ── binding ──
  bind: {
    args: [['<KEY>', 'an existing project key']],
    examples: ['mimir bind MMR'],
    summary:
      'bind this directory to a project — writes .mimir.toml, the default --scope from then on.',
    usage: 'mimir bind <KEY>',
  },
};
/* oxlint-enable sort-keys */

/**
 * Render one command descriptor at the requested tier. `-h` (full=false) stops
 * after usage/args/flags; `--help` (full=true) appends the examples.
 */
export function renderCommandHelp(h: CommandHelp, full: boolean): string {
  const lines: string[] = [h.usage, `  ${h.summary}`];
  const section = (title: string, rows: readonly Row[] | undefined): void => {
    if (rows === undefined || rows.length === 0) {
      return;
    }
    lines.push('', `${title}:`);
    const width = Math.max(...rows.map(([label]) => label.length));
    for (const [label, desc] of rows) {
      lines.push(`  ${label.padEnd(width)}  ${desc}`);
    }
  };
  section('arguments', h.args);
  section('flags', h.flags);
  if (full && h.examples !== undefined && h.examples.length > 0) {
    lines.push('', 'examples:');
    for (const example of h.examples) {
      lines.push(`  ${example}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Per-command help text, or undefined when the command has no descriptor (the
 * caller falls back to the top-level help). `create` dispatches on its type
 * subcommand (`create task` → the task descriptor) when one is given.
 */
export function helpForCommand(
  command: string,
  sub: string | undefined,
  full: boolean,
): string | undefined {
  const key =
    command === 'create' && sub !== undefined && `create ${sub}` in COMMAND_HELP
      ? `create ${sub}`
      : command;
  const descriptor = COMMAND_HELP[key];
  return descriptor === undefined ? undefined : renderCommandHelp(descriptor, full);
}

export const FULL_HELP = `${TERSE_HELP}
examples:
  mimir next --scope MMR              # what to work on next in project MMR
  mimir next -p p0                    # highest-priority ready tasks
  mimir list --is stale               # tasks that have gone quiet
  mimir list --status done --after completed_at:2026-06-01
  mimir list --eq priority:p1 --missing size
  mimir list --eq type:phase                  # filter to phases (use --in type:phase,task for multi-type)
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
  - ids: project = bare KEY, task/phase/initiative = KEY-seq, artifact = KEY-aN;
    any id position takes the full grammar — the verb rejects what it can't act on.
  - identity selection (get/status) exits non-zero on a missing id;
    set selection (next/list) exits 0 on an empty result. A value miss
    (--eq priority:p9) warns on stderr and returns an empty set (exit 0);
    an unknown field or wrong-type operator is a usage error (exit 2).
  - mutations exit non-zero on a missing id or invariant violation and
    echo the affected record on success.
  - rank is never shown — array order is the order (ADR 0007).
  - structured formats (ids/json/jsonl) never carry color; pipe-safe.
  - scope default: the nearest .mimir.toml walking up from cwd (mimir bind);
    explicit -s overrides, -s all queries every project.
`;

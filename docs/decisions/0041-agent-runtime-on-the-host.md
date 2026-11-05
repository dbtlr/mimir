---
title: 'ADR 0041: The agent runtime runs on the host'
description: The host runs Mimir's agents itself through the Claude Agent SDK, on the operator's own subscription, as personal automation. A run's configuration is code only, a fail-closed PreToolUse hook is its one gate, its board access is a run grant, it reads host-synced clones, and a host-owned runs table backs its budget and its one-at-a-time limit.
status: accepted
date: 2026-11-05
---

# ADR 0041: The agent runtime runs on the host

Console phase 5 (MMR-441) gives the host agents that act on its board. The
first is **Groom with agent**: from a `todo` task's page, an agent reads the
task and the project's code, writes notes on that task, sets its grooming
state, and leaves its recommendation and evidence when it stops on a question.
Until now, every Mimir program has run only code its authors wrote. An agent
run is a model that reads untrusted repository content and calls tools, inside
the process that owns the store. This record settles where agents run, how
they authenticate, how a run is confined, what a run may write, and how a run
is recorded and bounded.

A phase 0 spike (MMR-628, report MMR-a383) tested every load-bearing
assumption below in the host image on arm64, with
`@anthropic-ai/claude-agent-sdk` 0.3.318 and Claude Code 2.1.318, and repeated
the authentication, configuration, gate, subagent, and run-grant checks on
amd64. Where this record says a behavior was observed, the spike observed it.

## The decision

### The host owns the runtime

Agents run in the host's process tree through the Claude Agent SDK, against
the host's Engine, on clones the host keeps. No other program runs Mimir's
agents, and a run needs no agent harness on any client. The runtime is an
optional host feature in ADR 0040's pattern: one enabling setting, absent
(`unconfigured`) when it is unset, and `misconfigured` (logged, never refusing startup) when it or a
prerequisite is wrong.

### The credential is the operator's subscription, read from a file

`MIMIR_AGENT_TOKEN_FILE` names a mounted file that holds a token made by
`claude setup-token`. It is the feature's one enabling setting. A missing or
unreadable file reads `misconfigured`, and so do an unset `MIMIR_HOSTS`
(ADR 0040's Host filtering) and a `MIMIR_DATA_DIR` the host cannot write. A token the API rejects reads `disconnected`, and
the console says to replace the file. The console shows the file's age and
never accepts a token. Rotation is replacing the file.

The token authenticates the Agent SDK with the operator's own Claude
subscription. The Agent SDK documentation says: "Unless previously approved,
Anthropic does not allow third party developers to offer claude.ai login or
rate limits for their products, including agents built on the Claude Agent
SDK." (code.claude.com/docs/en/agent-sdk/overview). Mimir's agent runtime is
therefore **personal automation for the operator
who deploys it**. Mimir builds no login flow and offers no subscription access
to anyone. The operator generates the token and mounts it into their own
deployment. Offering agents to people who deploy Mimir for others needs a new
decision: API keys, a dollar budget, or Anthropic's approval.

### A run's configuration is code, never discovery

The runner passes every option the SDK would otherwise discover:

- `settingSources: []` and `strictMcpConfig: true`;
- an explicit `tools` list, and its own in-process MCP server and no others;
- `cwd` at the clone, and the `dontAsk` permission mode;
- a `CLAUDE_CONFIG_DIR` and `TMPDIR` in the host's working directory;
- auto memory off (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`);
- a minimal subprocess environment. It holds the token, `HOME`, `PATH`, and the
  variables above, plus the subagent limits below. It holds no other host
  credential: not the secret key, the database URL, the git credentials, or
  any host secret (ADR 0040).

The SDK's `env` option replaces the subprocess environment, so a setting left
out takes the SDK's default.

Managed policy settings load whatever `settingSources` says. In the spike, a
planted `/etc/claude-code/managed-settings.json` ran its SessionStart hook
despite `settingSources: []`. The image carries no managed settings, and the
runner refuses to start a run while any managed-settings path exists.

Under these options, a clone carrying a `.claude/settings.json` with command
hooks and broad allow rules, a `.mcp.json`, and a `CLAUDE.md` changed nothing.
Under the SDK's defaults, all three took effect.

### One gate, deny by default, failing closed

A `PreToolUse` hook is the only gate. It sees every tool call:

- calls the SDK would approve on its own, such as reads inside `cwd`;
- calls made by subagents, which carry an `agent_id`;
- the subagent tool itself, which reaches the hook as `Agent` (the session's
  init message lists it as `Task`).

It denies anything it does not allow. It is registered with
`onFailure: "block"`, so a hook that throws, returns nothing, or returns
invalid output blocks the call. In the spike, a hook that threw or returned invalid output under
`onFailure: "continue"` let a read through and leaked a canary, under `dontAsk`
and a `canUseTool` that denied everything: reads inside `cwd` never reach
`canUseTool`. `canUseTool` stays as a deny-all backstop. The hook's code is the
whole policy.

The gate allows:

- **Read, Grep, and Glob** whose path arguments resolve, through every
  symlink, to real paths inside the clone;
- **the subagent tool**, from the main agent only;
- **the run grant's tools**, from the main agent only.

There are no shell, write, edit, web, or git tools. The container holds no push
credentials.

### Subagents read; they never write

A run may send read-only subagents out, so a grooming agent can survey code in
parallel. The runner sets `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` (subagents
cannot start subagents) and `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` to a small
limit. It turns off forked subagents (`CLAUDE_CODE_FORK_SUBAGENT=0`) and the
SDK's built-in agents (`CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1`), and
defines its own reader agent. Subagents inherit the main agent's MCP tools by default (the
Agent SDK's subagent documentation), so the gate denies the run grant's tools to any call with an `agent_id`. In the spike,
a launch past the concurrency limit was rejected, not queued.

### Board access is a run grant

The agent never calls the Engine. It reaches the board through an in-process
MCP server whose tools call Engine verbs on its behalf, and which exposes only
the run's **run grant**: the reads the run's kind needs, scoped to the run's
project, and writes scoped to the run's own task. A grooming run's only
writes are `annotate` and `groom` on its own task. A call that names any other
id is refused whole, including a batch with one stray id. Structural and
lifecycle verbs are never exposed.

The grant's `groom` refuses a task that has left `todo`. The check reads the
task before the write, and the core's `groom` mutation, which accepts any
lifecycle (ADR 0033), is unchanged. If the operator starts or queues the task
between the check and the write, the run sets a grooming state that no view
reads, because grooming state is read only for `todo` tasks (ADR 0033). The
state surfaces only if `unqueue` later returns the task to `todo`, and then
it is visible beside the run's own note, so the operator can correct it. The
check therefore needs no compare-and-set in the core. A grooming run never changes
a task's status.

### The host syncs clones; the agent never runs git

A project with a `remote` gets one clone, keyed by its project key, in the
host's working directory. ADR 0036 stores a remote as `host/path` with the
scheme, credentials, and port dropped, so the fetch location is
`https://<host/path>.git`. A remote that needs SSH or a non-default port is
not supported. Credentials for a private repository come from
`MIMIR_GIT_CREDENTIALS_FILE`, a mounted file in git's credential-store format,
read with `credential.useHttpPath` so a credential applies to one repository.

Before each run, the host's own code:

1. checks that the clone's `origin` still normalizes to the project's
   `remote`, and clones again when it does not;
2. fetches, refreshes `origin/HEAD` with `git remote set-head origin --auto`,
   and fails the run when the remote reports no default branch;
3. hard-resets to `origin/HEAD`;
4. removes untracked files;
5. refuses the run when any symlink in the clone resolves outside it.

A project without a remote cannot use Groom with agent, and the control says
why.

### A run is a host-owned record

Migration 0013 adds a `runs` table in both dialects:

| Column | Meaning |
| --- | --- |
| `id` | Run id |
| `project`, `task` | The record the run acts on |
| `kind` | What the run does: `groom` first |
| `trigger` | `console`; `schedule` is reserved for the daily briefing (MMR-442) |
| `state` | `running`, `succeeded`, `failed`, `cancelled`, or `interrupted` |
| `runner` | The host process instance that owns the run |
| `heartbeat_at` | Updated by the owning runner while it runs |
| `model` | The model the run asked for |
| `reserved_tokens` | The run's admission reservation |
| `input_tokens`, `cache_read_tokens`, `cache_write_tokens`, `output_tokens` | Usage, updated as messages stream and settled at the end |
| `cost_estimate_usd` | The SDK's client-side estimate, at the end |
| `started_at`, `ended_at` | Times |
| `outcome` | One line from the runner: what the run did, or why it failed |

A partial unique index on running rows makes the concurrency limit the insert
itself: two simultaneous starts cannot both succeed. Every runner write and
every write through the run grant first checks that the row still belongs to its runner
and is still `running`. A runner that finds its row gone aborts its SDK run.
At boot and at every admission, a host marks a running row `interrupted` once
its heartbeat is older than a stale window. Boot alone never interrupts a run,
so the old container's live run keeps its row during an overlapping deploy.

`runs` is host transport data, like `host_secrets` and device tokens. It never
enters the work-state export or import, and only host server functions read
it; the contract, the wire, the CLI, and MCP gain no run verbs.

### The budget is a token count Mimir keeps

A daily budget bounds what the console can spend of the operator's
subscription. It counts tokens processed (input, cache reads, cache writes,
and output) across every model a run uses. That includes subagents and the
CLI's own background calls on a model the run never names, which in the spike
were about 1.5k Haiku tokens a run.

- **Admission.** A start reserves a per-run ceiling. It is refused unless the
  day's settled and reserved tokens plus the ceiling fit the budget.
- **In flight.** The runner sums the main agent's streamed usage, deduplicated
  by message id. Streamed output counts are placeholders, so it adds a per-turn
  output allowance. Streamed subagent usage is only a lower bound (one spike
  run matched the total, and two covered 81–91% of it), so the gate also charges a fixed per-subagent allowance
  when it admits a spawn, and denies the spawn when the allowance does not fit.
  The spike measured a survey subagent at about 0.33–0.35M tokens processed on
  Opus 5.5, which puts the allowance at about 400k. The runner aborts the run
  when it reaches its ceiling, and `maxTurns` bounds every run.
- **Settlement.** The result message's `modelUsage`, summed over every model,
  replaces the reservation; its `usage` field covers only the main loop. An
  overrun past the allowances still counts against the day and is recorded in
  the run's outcome. An interrupted run, or a failed run with no valid total
  (an aborted run ends with no result message), counts its reservation or its
  streamed usage, whichever is larger.

A `setup-token` cannot read the plan's own limits, so the budget is Mimir's
own count.

### Who may start a run

A run starts from a console server function under Start's CSRF check. The
console stays unauthenticated on a single-user tailnet, as ADR 0035 and ADR
0040 accept, and agents require `MIMIR_HOSTS`. The budget and one run at a
time bound what a client that reaches the console can spend. Optional console
authentication (MMR-456) stays parked.

### The SDK is pinned

The host pins the Agent SDK and its Claude Code executable to a version
release-tested against this record's guarantees: the gate's coverage,
`onFailure: "block"`, the managed-settings check, the subagent limits, and the
usage fields. 0.3.318 and 2.1.318 are the first such pair. The executable is a
native binary for each architecture, installed in the image's runtime stage
for each published platform, amd64 and arm64.

## Why

- **The host already owns the store and the console.** A runtime anywhere else
  would need its own credentials to the board, its own deployment, and its own
  answer to who may start a run. On the host, a run uses the same Engine, the
  same Host filtering, and the same store as every other console action.
- **The SDK gives both reach and confinement.** It brings subagents, a
  full tool loop, and per-model usage. It also exposes enforcement points that
  run before any tool executes: `PreToolUse` hooks with a failure policy, an
  explicit tool list, and `settingSources`. The spike showed each one holding
  in the host image, and showed what breaks without it.
- **One gate is reviewable.** With nothing pre-allowed and everything
  discoverable switched off, the gate's code and the run grant's code are the
  whole of what a run may do.
- **Clones need nothing from the agent.** The host's own code keeps them
  current and safe before the agent starts, so the agent needs no shell and no
  git.
- **Records outlive processes.** The budget, the concurrency limit, the work
  page's Now section, and crash recovery all read the run row, so a restart or
  an overlapping deploy cannot lose a run or start a second one.

## Considered and rejected

- **T3 Code threads as the runtime.** The console already launches T3 threads
  for tasks (ADR 0040). As a runtime, T3 would make T3 the operator's
  interface, and it cannot confine a run: a launch takes no tool allow or deny
  list, a Claude thread has no sandbox, and a permission request cannot be
  approved over MCP.
- **API keys.** An API key is the SDK's documented method for products. Mimir's
  runtime is personal automation, and runs draw on the subscription the
  operator already uses. A deployment for others revisits this.
- **A separate runner container, or a separate OS user.** Either would keep the
  store and secrets out of the agent's reach even if the gate failed. The
  runner container needs its own image, pairing, and orchestration across
  containers. The OS user needs root in an image that runs as `bun` on a
  read-only root. The gate inside the host, with the spike's evidence, was
  preferred.
- **`canUseTool` as the gate.** Calls the SDK approves on its own, such as
  reads inside `cwd`, never reach it.
- **Run records as artifacts and notes.** The budget needs a durable count,
  and Now needs live state that survives a restart.
- **Taking the token in the console.** The console is unauthenticated, so any
  client that reaches it could replace the operator's credential. A one-year
  token does not have the 30-day expiry that led ADR 0040 to keep T3's token
  out of configuration. A `setup-token` lasts one year (Claude Code's
  authentication documentation).


## Relation to other records

- **ADR 0002 (no baked-in semantics).** A run row is host execution state, not
  work state or a consumer's processing state. It never enters the work-state
  model, the contract, or the export, as host secrets and device tokens do not.
- **ADR 0010 (transport-only consumption).** The in-process MCP server is part
  of the host, not a Mimir transport: it is the run grant's tool surface,
  built by the host for one run, and never offered to another client. Agents
  outside the host still reach Mimir through MCP or the CLI, which stay 1:1.
- **ADR 0012 (capabilities land in core).** The run grant adds no core
  capability. It narrows existing Engine verbs for one caller, and the CLI and
  MCP keep the verbs as they are. "Capability" keeps ADR 0012's meaning; a
  run's board access is called a run grant.
- **ADR 0026 (resume handles).** Decision 3 keeps model and token counts out of
  a task's handles. A run row is not an assignment handle: it records the
  host's own execution, which Mimir performs, and a task's handles are
  unchanged. `annotate` and `groom` carry no handles, so the run row, by its
  task and time window, is the provenance of what a run wrote. See ADR 0026's
  2026-11-05 refinement.
- **ADR 0033 (grooming state).** The core's `groom` keeps setting grooming
  state at any lifecycle for every caller. Only a grooming run's grant refuses
  a task that left `todo`. ADR 0033 §2 bars the core from inferring a grooming
  state from a description; a grooming agent is a caller that reads the task
  and the code and decides, as a person or an outside agent does, and its
  decision is recorded with its note.
- **ADR 0035 (the host container).** The image gains `git` and the Claude Code
  executable, and `MIMIR_DATA_DIR` becomes the host's working directory for
  every backend. See ADR 0035's 2026-11-05 addendum.
- **ADR 0036 (project remotes).** Clone locations derive from the stored
  `host/path` form.
- **ADR 0040 (outbound integrations and host secrets).** The runtime follows
  its enabling-setting pattern and its Host-filtering requirement. Its
  credentials do not use host secrets: a host secret holds a credential a
  console flow obtains at runtime, such as T3's OAuth token, while the agent
  token and git credentials are supplied by the operator and ride mounted
  files, like `MIMIR_SECRET_KEY_FILE` and `MIMIR_DATABASE_URL_FILE`. ADR 0040
  says the core gains only generic host-secret storage. The runs table extends
  that boundary: it lives in the store's migrations, but nothing outside the
  host reads or writes it, and the core gains no Engine verb or contract type for agents. See ADR
  0040's 2026-11-05 refinement.

## Consequences

- Migration 0013 adds `runs`, and the schema moves to version 13. Rolling the host
  image back past it needs a database restore, as with any migration.
- A deployment that enables agents sets `MIMIR_AGENT_TOKEN_FILE` and
  `MIMIR_HOSTS`, gives `MIMIR_DATA_DIR` a writable directory, and, for private
  repositories, sets `MIMIR_GIT_CREDENTIALS_FILE`. Without a persistent
  `MIMIR_DATA_DIR`, clones and SDK state are rebuilt after each deploy, at the
  cost of a fresh clone.
- Runs draw on the operator's subscription limits, which interactive work
  shares. A one-subagent grooming run on Opus 5.5 processed about 0.36M tokens
  in the spike.
- Prompt injection from repository content can steer a run. With no write
  tools and a one-task run grant, the worst outcome is wrong notes or a wrong
  grooming state on that task, which the operator sees and corrects.
- A project's remote is board data that any client of the host can change, and
  it decides which repository the host clones. Credentials are scoped per
  repository, so they do not follow a changed remote.
- Updating the Agent SDK is a release-tested change: the guarantees above are
  re-checked before the pin moves.
- The daily briefing (MMR-442) and the agent panel (MMR-443) build on this
  runtime as new run kinds with their own run grants.

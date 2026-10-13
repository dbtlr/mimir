# Use the operator console

The console is the operator's view across agent-driven work. It shows current
state from the same core used by the CLI and MCP server, then provides focused
authoring and lifecycle controls.

```sh
mimir serve
```

Open the URL printed at startup. The installed production profile defaults to
`http://127.0.0.1:64647/`. The server binds to loopback unless `[serve] bind`
says otherwise. For access from another device, pick a
[network mode](../guides/port-and-proxy.md): `tailscale serve` keeps HTTPS and
the installable PWA, and a reverse proxy does too.

![Mimir project board grouped into phase bands](../assets/console-project.png)

## Route attention from the overview

The overview groups projects by attention state and shows the signals behind
each reading. Use it to find work awaiting review, active projects, blocked or
stale work, and projects at rest. Archived projects remain available in a
separate shelf.

From the overview you can create a project, open a project's page, or jump into
a task's page.

## Work within a project

Every project, initiative, phase, task, seed, and artifact has its own page at
its own address: `/p/MMR` for the project, `/p/MMR/417` for `MMR-417`,
`/p/MMR/s41` for the seed `MMR-s41`, and `/p/MMR/a219` for the artifact
`MMR-a219`. Typing a bare ID such as `/MMR-417`, `/mmr-s41`, `/mmr-a219`, or
`/mmr` redirects to its page.

- **A project, initiative, or phase opens as its work page.** The main column
  answers five questions in order: _Now_ (what is running, with when it
  started, where, and its latest note), _Needs you_ (reviews, blocks you can
  clear, and tasks that need answers, each with its reason), _Frontier_ (what
  is runnable now, what is next to unlock, what is left to groom, and what is
  waiting on others, folded), _Shipped_ (the last seven days, grouped by day),
  and _Going cold_ (stale work). Every row opens its record page. The rail
  holds the direction in full, the structure of initiatives and phases, About
  (the description, artifacts, and details), and links to the board and the
  project's tasks. New task is in the page head, and a project's settings sit
  beside it. An initiative or phase adds its path above the title and keeps its
  notes under a Timeline tab, at `?tab=timeline`.
- **A task page** shows the path above the task, its description, a timeline
  with a note field, and a rail with actions, agent context, dependencies,
  artifacts, and details.
- **A seed page** reads as a request: which board asks which, the description,
  and what came of it, meaning the tasks promoted from the seed and the tasks
  on any board that name it as upstream. A decision block offers the verbs the
  seed needs next: promote, reject, or leave a new seed for later; promote
  again or reject while its work is under way; and resolve, promote again, or
  reject once that work has settled. Its rail holds Edit, Copy link, and
  details.
- **An artifact page** shows the frozen body under the work it is attached to.
  The path runs through that task, a card for the task sits above the body,
  and the rail lists the task's other artifacts. An artifact attached to
  several records lists each in the card, and its path stops at the nearest
  container that holds them all; one attached to none sits under its project.
  The rail holds Copy link, Download .md, and details.

On a phone, the rail folds into chips that open bottom sheets.

The board is an optional view at `/p/MMR/board`, linked from the work page's
rail. It groups tasks into status lanes, banded by phase or release, and rank
within Ready is the queue. Card titles and the container names in its bands are
links to their pages, so they open in a new tab or copy as links like any other
link.

## Browse portfolio records

Portfolio-wide surfaces include:

- **Tasks** for every task across projects, grouped by status (or by project),
  with **Live** and **Finished** views and a search over titles and IDs;
- **Artifacts** for frozen work products, grouped by the day they were frozen,
  each showing the records it is attached to;
- **Seeds** for the grooming queue, grouped by lane: untriaged, ready to
  resolve, and promoted, with settled seeds folded behind **Show settled
  seeds**;
- **Record health** for `mimir doctor` findings: rows the store holds in an
  inconsistent state, each with its table, key, and evidence.

The tasks, artifacts, and seeds browsers show a one-line preview of each
record's description or summary under its title, and every row opens the
record's own page. On a phone the previews are hidden, and the groups stay.

Routes and filters are encoded in the URL, so a specific view can be bookmarked
or shared.

## Understand offline behavior

The console is an installable PWA. It keeps the last synchronized reads and
shows an explicit offline banner when the server cannot be reached. Offline
data is for inspection only: writes are disabled and never queued for later.

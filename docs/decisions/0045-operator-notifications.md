---
title: 'ADR 0045: Operator notifications — events from entries to the needs-you set'
status: accepted
date: 2026-11-18
---

# ADR 0045: Operator notifications — events from entries to the needs-you set

An agent can record a provisional decision and keep building
([ADR 0043](0043-the-decision-record.md)), and a stopped delivery waits for
the operator ([ADR 0042](0042-the-delivery-record.md)). The console lists both
under "Needs you", but only an operator who is looking at the console sees
them. This record settles how the host turns a write into a **notification
event**: what counts as news, who is told, and what an event carries. How an
event reaches a device is a **channel**, and each channel is recorded as a
refinement of this ADR.

## Decision

### The notifier compares sets and knows no verbs

The **needs-you set** is the set that
[ADR 0019](0019-meridian-console-design-system.md)'s MMR-694 refinement
defines: stopped deliveries, provisional decisions, tasks blocked with owner
`you`, and unheld `todo` tasks whose grooming state is `needs_answers`. The
notifier uses the unscoped set across every active project, which
`console.review` returns.

A member's identity is its entry in that read's `queue`: one of the three
kinds `delivery`, `decision`, and `task`, with the record's id.

The **notifier** is a module of the console server (`packages/host/src/server`).
It remembers the last set of identities it read. A **check** reads the set
again and compares:

- An identity in the new set and not in the remembered set is an **entry**.
- An identity that was absent at one check and is present at a later one is
  an entry again.
- An identity that stays in the set is never an entry, whatever changed on the
  record. A task that needs answers and is then blocked on the operator keeps
  its identity, so it is not an entry.

After every successful check the new set replaces the remembered one. The
notifier has no rule for any verb. A new way for a record to enter the set
notifies with no change to the notifier, and a new kind of member fails to
compile until it has an event kind, a text, and a target below.

A check calls `console.review` with the current instant and the fixed zone
`UTC`. The read requires a zone ([ADR 0034](0034-engine-interface-and-trpc-wire.md)),
and neither `queue` nor the needs-you rows depend on it. The read computes
more than the notifier uses. Its cost is bounded to one read per window
(below). A narrower read would change the Engine contract and takes its own
record, once this one is measured to be slow.

The contract, the wire, the CLI, and the core gain nothing. The notifier
reaches work state only through Engine reads and writes nothing.

### Each caller's view marks its mutations

The host hands each caller its own **view** of the one Engine. A view calls
the Engine unchanged. Around each mutation it tells the notifier three things:
the mutation **began**, with the view's actor (below), before the Engine is
called; then that it **succeeded** or **failed**. A query tells the notifier
nothing. The Engine contract's `kind` field says which methods are mutations.

A mutation that fails is forgotten at once. A mutation that succeeds is a
**signal**. A cause (below) is only an actor, so the notifier keeps, for each
actor, the number of mutations in flight and the instant of the latest
success. Its memory does not grow with the number of writes.

### A signal opens a window, and a window ends in one check

- A **window** opens at the first signal that arrives when no window is open.
- It closes 2 seconds after its latest signal, or 10 seconds after it opened,
  whichever comes first.
- When a window closes, a check is due. It runs at once when no check is
  running, and otherwise when the running check ends. At most one check waits:
  a window that closes while a check already waits adds nothing.
- A signal that arrives while a check runs or waits opens the next window.

A check is several store reads, not one instant, and a write can commit before
its signal exists. So a check does not ask which window a write belonged to:

- A check's **causes** are the actors of every mutation that had begun and was
  not yet retired when the check's read returned. That includes a mutation
  still in flight and one that succeeded while the check was reading.
- A successful check **retires** the mutations that had succeeded before its
  read began. A later mutation stays, and counts again as a cause of the next
  check. So an actor is a cause when it has a mutation in flight, or when its
  latest success is not earlier than the instant the last successful check
  began its read.

A check succeeds only when its read and the building of its events both
succeed. Its reads have 30 seconds; a check that takes longer fails, and
whatever the late read returns is ignored. A check that fails is logged as
`needs_you_check_fault`. It replaces nothing and retires nothing, so its
causes carry to the next check, which the next window brings.

**Boot.** The notifier reads the set once before the host serves any request,
remembers it, and emits nothing. That read has the same 30 seconds. A failure
of it is logged as `needs_you_check_fault` and never refuses startup. Boot
runs once: a second call does nothing. A notifier with no remembered set treats its next successful
read as the first and emits nothing for it.

**Close.** Closing the host cancels an open window and a waiting check. The
result of a running check is discarded and logs nothing. Close does not wait
for a delivery in flight. After close the notifier ignores everything a view
tells it.

The window and the marks are timed on a monotonic clock, so a step of the
wall clock changes neither a window's length nor which mutations a check
retires. Only the instant handed to the review read comes from the wall clock.

The remembered set, the marks, and the window live in memory only. Every
member enters the set through a write, and none enters because time passed,
so the notifier has no timer besides the window and the limit on a check's
reads.

### An event reaches a recipient unless they caused it

An **actor** is who made a write. A **recipient** is who receives events. The
events of a check reach a recipient unless the check has at least one cause
and every cause is that recipient. A check with no causes reports its
entries.

There are two actors today:

| Actor      | Writes                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------ |
| `operator` | The console's server functions, and the T3 adapter's writes for a console action           |
| `other`    | The `/trpc` handler (a paired CLI or MCP server), and an agent run's grant ([ADR 0041](0041-agent-runtime-on-the-host.md)) |

There is one recipient today, the operator. So a check that has causes, all
of them `operator`, emits no event, and any other check emits an event for
each entry it found. The remembered set is replaced either way, so an entry the operator
caused is never reported later. A check that withholds its entries logs
`needs_you_withheld` with their ids.

The rule errs toward notifying: one `other` cause is enough to report every
entry of the check.

The wake ([ADR 0040](0040-outbound-integrations-and-host-secrets.md)) covers
the other direction. It tells a delivery's agent when the operator acts on the
delivery or its decisions in the console.

### The event

| Field       | Shape                                                                    |
| ----------- | ------------------------------------------------------------------------ |
| `kind`      | `delivery_stopped`, `decisions`, `task_blocked`, or `task_needs_answers` |
| `ids`       | The members' ids. More than one only for `decisions`                     |
| `project`   | The project key                                                          |
| `title`     | One line of text (below)                                                 |
| `body`      | One line of text (below)                                                 |
| `target`    | The console path that opens the record                                   |
| `needs_you` | The size of the needs-you set at this check                              |

The event kind and the text come from the member's row in the read's
`needsYou`, which carries a task's reason and each record's text.

Each entry becomes one event, except decisions. The decision entries one check
finds that name the same delivery form one event, and those with no delivery
form one event per project. A check emits its events in `queue` order, and a
`decisions` event takes the place of its first member.

`kind` and `target` together identify what an event is about. A channel can use
them to replace an earlier notification about the same record, where its
platform supports that. A `decisions` event counts the entries of its own
check, not every provisional decision of the delivery or project.

`needs_you` is for a channel that shows a count. It is the size at the check
that emitted the event. No event is emitted when a member leaves the set, so
the count a channel last showed can be too high.

| Kind                 | Title carries                                           | Body carries                                         | Target                     |
| -------------------- | ------------------------------------------------------- | ---------------------------------------------------- | -------------------------- |
| `delivery_stopped`   | The delivery's title                                    | The hold reason, or the delivery's id when it has none | `/p/KEY/dN`              |
| `decisions`          | The count when above one, and the delivery or project   | The first member's question                          | `/p/KEY/dN?mode=decisions`, or `/p/KEY?mode=decisions` with no delivery |
| `task_blocked`       | The task's title                                        | The hold reason, or the task's id when it has none   | `/p/KEY/SEQ`               |
| `task_needs_answers` | The task's title                                        | The open question, or the task's id when it has none | `/p/KEY/SEQ`               |

- The table names what each line carries. The words around those parts belong
  to the implementation and can change without a new decision.
- A `decisions` title names its delivery by title. The decision row carries
  only the delivery's id, so the notifier reads the delivery; when that read
  fails, the title uses the id. With no delivery, the title names the project
  by its key.
- Text is plain. Runs of whitespace collapse to one space. A title is at most
  100 characters and a body at most 240; a longer text is cut so that it ends
  in an ellipsis inside that limit.
- `?mode=decisions` opens the decisions walkthrough over the delivery's page,
  or over the project's page for decisions that name no delivery
  ([ADR 0019](0019-meridian-console-design-system.md), MMR-703 refinement).

### Channels

A **channel** delivers events: `deliver(event)` returns a promise. The notifier
hands each event to every channel once and does not retry; a channel owns its
own retries. The notifier does not wait for a delivery before its next check.
A channel that rejects, or throws, is logged as `needs_you_channel_fault`, and
the other channels still receive the event.

The notifier runs on every host, with or without a channel. It logs each event
as `needs_you_event` with the kind, the ids, the target, and the count, and
never the title or the body. Each of its log lines is one JSON object with
`event` and `time`, the form of the host's other named events. With no channel, its log lines are its only
output.

### The notifier never touches the write

What a view tells the notifier is synchronous, does no I/O, and cannot throw.
A view returns the mutation's own result or error, and never waits for the
notifier.

## Known limits

- A command the operator types into a paired CLI is an `other` write, because
  the host cannot tell it from an agent's. It notifies.
- A check with one `other` cause reports every entry it found, the operator's
  own included. That happens, for example, when console writes and other
  writes share a window, when a write lands or is still in flight while a
  check is reading, when two windows share one waiting check, and when an
  earlier check failed and left its causes for this one.
- An event follows its write by up to 10 seconds plus the check, and by longer
  when a check is already running.
- Only decisions group. A write that puts several deliveries or tasks into the
  set at once produces one event each.
- An entry is lost when the host stops before its check runs, when its check
  fails and no later write follows, and when it enters before the first
  successful read of a host whose boot read failed.
- A mutation that commits and then fails while building its answer counts as
  failed, so it opens no window. Its entry is found by the next check and
  reported or withheld by that check's causes.
- A member that enters and leaves before its check is never reported. A member
  that leaves and returns between two checks is not an entry: a task whose
  question is answered and asked again inside one window is not reported
  again.
- The notifier sees only the writes made through its own host process:
  - `mimir-host store import --apply` writes the store with no Engine call.
    Imported members are found by the next check, and reported or withheld by
    that check's causes.
  - During an overlapping deploy two host processes serve one store, each with
    its own remembered set. An entry made through one can be reported again by
    the other, or taken into its set unreported.

## Why

- **The set is already derived.** A task enters it through `block`, through
  `groom`, and through `unpark` or `unblock` on a task that needs answers, for
  example. Rules per verb would copy that derivation and drift from it.
- **The window is one mechanism for two needs.** It bounds the cost to one
  read however many writes arrive, and it groups an agent's burst of
  decisions.
- **One host process sees the writes made through it.** The CLI, MCP, the
  console, and agent runs reach a host's store through its one Engine
  (ADR 0034, decision 8).

## Considered and rejected

- **A hook on each verb.** Rejected above: it copies the derivation.
- **Notifying at once, with no window, as the wake does.** ADR 0040 rejected
  batching wakes over a window, because it needs a timer and loses the pending
  wake at a restart. A wake answers one operator action, so nothing there
  needs grouping. Here a check per write costs one review read per write, and
  an agent's burst of decisions would arrive as separate notifications. The
  timer and the loss at a restart are accepted and listed under Known limits;
  the record stays in the console's needs-you list either way.
- **Attribution per write.** A check after every write would say which write
  caused which entry, at the price of one review read per write, and a write
  that lands during the read would still be ambiguous.
- **A stored ledger of reported members.** It would save only the check that
  is pending when the host stops.
- **Notifying from the core.** The core carries no concept of any integration
  ([ADR 0002](0002-general-purpose-primitives-not-baked-in-semantics.md),
  ADR 0040).
- **A switch for the notifier.** With no channel its cost is one review read
  per window, and its log lines are how a missing notification is diagnosed. A
  setting with no other consumer was not worth its configuration.

## Consequences

- A channel is added as a refinement of this ADR. It decides its own setting,
  storage, and failure states under ADR 0040.
- The rule names actors and recipients, never a transport. A host with several
  users needs more than that: every device token belongs to the one user
  `owner` today ([ADR 0038](0038-device-pairing-and-the-version-window.md)), so
  an actor would also have to tell a user from an agent that writes with that
  user's token. That design is not settled here.

## Refinement (2026-11-18, MMR-709): the Web Push channel

The first channel sends each event as an encrypted Web Push to every browser
that subscribed to it. It is an outbound integration under
[ADR 0040](0040-outbound-integrations-and-host-secrets.md): it lives in the
console server, is absent until its one setting is set, keeps its key as a
host secret, and reads and writes no work state. Showing a push and opening
its record are the service worker's work (MMR-710). The console control that
subscribes a device is MMR-711.

### The setting and its states

`MIMIR_PUSH_CONTACT` turns the channel on. Its value is the contact the push
services require as the VAPID subject (RFC 8292): a `mailto:` URL with one
address that contains `@`, or an `https:` URL whose host, as the URL parser
normalizes it, does not name this machine: not `localhost` with or without a
trailing dot, no name ending `.localhost`, no address in `127.0.0.0/8`
(also IPv4-mapped), and not `0.0.0.0`, `[::]`, or `[::1]`. With it unset, the channel is **absent**: no channel is registered with
the notifier, nothing is written to `push_subscriptions` or `host_secrets`,
and every server function answers `unconfigured`.

With it set, the host checks four more things, and each problem it finds
makes the channel **misconfigured**:

| Problem                                             | Setting named                                 |
| --------------------------------------------------- | --------------------------------------------- |
| The value is not a contact as above                 | `MIMIR_PUSH_CONTACT` is malformed             |
| `MIMIR_URL` is unset                                | `MIMIR_URL` is unset                          |
| `MIMIR_URL` is neither HTTPS nor HTTP on loopback   | `MIMIR_URL` is not HTTPS                      |
| `MIMIR_HOSTS` is unset                              | `MIMIR_HOSTS` is unset                        |
| The secret key is missing, unreadable, or malformed | `MIMIR_SECRET_KEY` or `MIMIR_SECRET_KEY_FILE` |

- `MIMIR_URL` is needed because a notification opens an absolute URL, and the
  notifier has no request to take an origin from. HTTP on loopback is allowed
  for a development host, as the T3 adapter allows it.
- `MIMIR_HOSTS` is required for the reason ADR 0040 requires it of T3. A page
  that rebinds its name to the host is same-origin, so without Host filtering
  it could subscribe its own browser and receive every later event's text,
  long after the page is closed.
- The secret key is read and checked as ADR 0040 describes, by whichever
  enabled integration needs it.

A misconfigured channel warns at startup, one line per problem, naming the
setting and never its value. It is not registered with the notifier, writes
nothing, and its server functions answer `misconfigured` with the first
problem. Settings are read once at startup, so a fix takes a restart.

### The key

The channel signs with one VAPID key pair (ECDSA P-256), kept as the host
secret `push.vapid`: the sealed JSON of the public key and the private
scalar. The public key is always the raw 65-byte uncompressed point in
unpadded base64url, the form a browser's `applicationServerKey` takes.

**Every use reads the row.** Each status read, subscribe, send test, and
delivery reads and opens `push.vapid` again; the channel keeps no copy
between uses. A host therefore always signs with the key the store holds,
including after another host reset it. The cost is one row read per use.

**First use.** The pair is made when a use finds no row. The new row is
written only if no row of that name exists (a host-secret write that inserts
and never replaces), and the channel then reads the row back and uses
whatever it holds. Two callers or two hosts that make a pair at once
therefore both use the pair that was stored first. Within one host process,
making a pair, resetting it (below), and a subscribe's key read, key check,
and row write take turns: one runs at a time. A failed attempt is not
remembered, so the next use tries again.

A store error while reading or writing the key is a fault, never an absent
row: it makes no pair.

**An unusable row.** A row that fails to open (the secret key changed, or the
row was altered) is logged as `host_secret_unopenable`, with the `cause` that
T3's log line for its own row carries, and a row that opens
but does not hold a valid pair is logged as `host_secret_unreadable`, both
without contents, as ADR 0040 says. Each is logged once per process for
each row content, not on every use. Either way the channel is **key
unusable** while the row stays as it is. It does not replace the key on its
own, because the usual cause is a wrong secret key that the operator will
restore, and replacing the key would strand every device.

**Reset.** The operator replaces the key with the reset server function
(below), from the `key unusable` state or any time the channel is ready. In
one turn, it writes a new pair over the row, reads the row back, deletes
every subscription made for another key than the one it read, and answers
that key. Each row records the key it was made for (below), so a reset
interrupted between the two steps leaves rows that no send uses and that the
next reset or a removal deletes. Each device subscribes again: the console
compares its subscription's `applicationServerKey` with the served key when it
opens (MMR-711).

The private scalar never leaves the channel and never appears in a log.

### The table

`push_subscriptions` is a host transport table, like `device_tokens`
([ADR 0038](0038-device-pairing-and-the-version-window.md)): it is in both
store dialects, it is added by a schema version step, and export and import
skip it in both directions.

| Column            | Meaning                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| `endpoint`        | Primary key: the push service URL, as the URL parser serializes it        |
| `p256dh`          | The browser's public key, base64url                                       |
| `auth`            | The browser's authentication secret, base64url                            |
| `server_key`      | The VAPID public key the browser subscribed with                          |
| `label`           | The name the console gave the device                                      |
| `created_at`      | When the endpoint was first subscribed                                    |
| `last_success_at` | When a push service last accepted a push to it; absent until one does     |
| `last_failure_at` | When the latest failed push to it happened; absent after a success        |
| `last_failure`    | That failure: `HTTP <status>`, `timeout`, or `unreachable`                |

The endpoint and the browser's keys are stored in the clear, not sealed. The
browser's keys let the host encrypt to the browser, not decrypt, and the
push services below accept a push only when it is signed with the VAPID key
the endpoint was made for, whose private half is sealed.

There is no recipient column. Every subscription belongs to the one
recipient, the operator, so the notifier's rule above has already decided
whether an event reaches it.

This amends ADR 0040's boundary as its MMR-629 refinement did for `runs`: the
core's store gains a second integration's host-only table and a generic
insert-if-absent write on the host-secret store, and nothing else. Only the
host reads or writes the table; the contract, the wire, the CLI, and the
work-state export gain nothing.

### The server functions

The console calls six server functions, off the Engine. Each answers
`unconfigured` or `misconfigured` when the channel is not ready, and then
touches neither table. A store error is a host fault, as in every other
console server function; a push service's failure is an answer. Every
function that takes an endpoint serializes it with the URL parser before it
looks the row up.

In the `key unusable` state, Status answers `key_unusable`, Subscribe and Send
test refuse with `key_unusable`, List answers every row as made for another
key, and Unsubscribe and Reset key work as usual.

- **Status** answers `ready` with the public key and the console origin
  (`MIMIR_URL`), or `key_unusable`.
- **Subscribe** takes the endpoint, the two browser keys, the
  `applicationServerKey` the browser subscribed with, and a label. Input
  with an endpoint over 2048 characters, a key over 256, or a label over
  1000 is a validation error before any check below. It refuses, and writes
  nothing, when:
  - the request's `Origin` header is missing, or its scheme, host, and port
    are not those of `MIMIR_URL` (`wrong_origin`), because a notification
    opens `MIMIR_URL` and a device installed from another origin would open
    it outside the app. The header is compared, not the request URL, which
    is `http:` behind a proxy that ends TLS;
  - the given server key is not the current one (`stale_key`);
  - the endpoint is longer than 1024 characters, or is not an `https:` URL
    with no user, password, or fragment, on the default port, on one of the
    push hosts below (`endpoint_not_allowed`);
  - `p256dh` does not decode to a P-256 public point, or `auth` does not
    decode to 16 bytes (`invalid_keys`);
  - the table already holds 20 rows and the endpoint is not one of them
    (`too_many_devices`). The count and the write are one transaction.

  The label is plain text: runs of whitespace collapse to one space, it is
  cut to 60 characters, and an empty label becomes `Device`. A subscribe with
  an endpoint the table holds replaces that row's keys, server key, and
  label, clears its failure, and keeps its `created_at`.
- **Unsubscribe** takes an endpoint and deletes its row. An endpoint with no
  row is not an error.
- **List** answers every row, newest first, with its endpoint, label, times,
  last failure, and whether it was made for the current key, but not its
  keys.
- **Send test** takes an endpoint and sends one push to it alone, then
  answers `delivered`, `gone` (the row was deleted, below), or `failed` with
  the failure. An endpoint with no row answers `not_found`, and a row made
  for another key answers `stale_key` and sends nothing. A push that cannot
  be built (below), or a row update after the answer that fails, is a host
  fault, never an answer.
- **Reset key** replaces the pair, as above, and answers the new public key.

The push hosts are the services of Apple, Google, Mozilla, and Microsoft:

| Service   | Host                                                     |
| --------- | -------------------------------------------------------- |
| Apple     | `web.push.apple.com`, or a host ending `.push.apple.com` |
| Google    | `fcm.googleapis.com`                                     |
| Mozilla   | a host ending `.push.services.mozilla.com`               |
| Microsoft | a host ending `.notify.windows.com`                      |

The browser chooses the endpoint, so the allowlist is what keeps the host
from posting to an address of the browser's choosing. A host is compared
after the URL parser has lowercased and normalized it.

### Sending

The channel's `deliver` reads the key and the table and sends the event to
every row made for the current key, all at once. In the `key unusable` state
it sends nothing and resolves. It resolves when every send has an outcome
and every row update has finished or failed. It rejects only when the table
or the key cannot be read, which the notifier logs as
`needs_you_channel_fault`.

Each push is one HTTP `POST` to the endpoint:

- The body is the payload below, encrypted for the row's keys with RFC 8291:
  one `aes128gcm` record of at most 4096 bytes.
- `Content-Encoding: aes128gcm` and `Content-Type: application/octet-stream`.
- `Authorization: vapid t=<JWT>, k=<public key>`, where the JWT (ES256) has
  `aud` set to the endpoint's origin, `sub` set to `MIMIR_PUSH_CONTACT`, and
  `exp` 12 hours ahead. Apple refuses an `exp` more than a day ahead.
- `TTL: 86400`, so a push service holds an undelivered push for a day, and
  `Urgency: high`. No `Topic` header is sent.
- Redirects are not followed, and a send that has no answer in 10 seconds
  is a `timeout`.

The outcome of a send updates its row, but only while the row still holds
the endpoint and the browser keys the push was encrypted for. A row that was
removed, or subscribed again with new keys, while the push was in flight is
left alone.

| Answer                         | Row                                      | Log                      |
| ------------------------------ | ---------------------------------------- | ------------------------ |
| Any 2xx                        | `last_success_at` set, failure cleared   | nothing                  |
| 404 or 410                     | deleted                                  | `push_subscription_gone` |
| Any other status, or no answer | `last_failure_at` and `last_failure` set | `push_send_fault`        |

Both log lines carry the endpoint's host and the status (or `timeout` or
`unreachable`), never the endpoint's path, a key, the JWT, or the payload. A
row update that fails is logged as `push_outcome_write_fault` with the
endpoint's host and does not reject `deliver`.

A push that cannot be built (its encryption or its JWT fails, as with a
stored browser key that no longer decodes) is a local fault, not an answer
from the push service. Nothing is sent, the row is left as it is, and the
fault is logged as `push_build_fault` with the endpoint's host only. It
stops no other row's push and does not reject `deliver`.

The channel does not retry. The push service already holds a push for its
time-to-live, and the next event or a test push tries again. A send cannot
fail the write that caused the event: the notifier does not wait for its
channels.

### The payload

The payload is a Declarative Web Push message (WebKit; the W3C Push API
draft), which iOS shows and opens without the service worker. The service
worker's `push` handler parses the same JSON for a browser that delivers it
as a plain push (MMR-710).

```json
{
  "web_push": 8030,
  "notification": {
    "title": "<the event's title>",
    "body": "<the event's body>",
    "navigate": "<MIMIR_URL joined with the event's target>",
    "tag": "<kind>:<target>",
    "lang": "en",
    "dir": "ltr"
  },
  "app_badge": 4
}
```

- `navigate` is absolute, as the format requires.
- `tag` names what the event is about (the `kind` and `target` above). iOS
  does not replace a notification that has the same tag, so nothing depends
  on replacement. A browser that does replace by tag would do so silently;
  MMR-710's service worker shows a push with `renotify` so that it alerts.
- `app_badge` is the event's `needs_you` count, at the top level as an
  integer. Safari 26 moved it there from `notification`, where a string value
  crashed earlier versions. A test push carries no `app_badge`.
- The event's title and body are already plain and bounded (above), so the
  payload stays far below the record limit.

A test push has the title `Mimir test notification`, the body
`Notifications reach this device.`, the tag `test`, and opens `MIMIR_URL`.

### Known limits of the channel

- Apple went on answering 201 for a removed app's endpoint for minutes after
  the removal (MMR-707). A dead subscription is deleted when a push service
  answers 404 or 410, or when the operator removes it from the device list,
  so a row can outlive its device.
- A browser that is given a new endpoint subscribes as a new row, and its old
  row stays until one of the above.
- When two deliveries to one row overlap, the later outcome to finish wins,
  so the row can show an older failure after a newer success until the next
  push. A push still in flight when its row is removed and subscribed again
  with the same keys can likewise record its outcome on the new row.
- Two hosts that serve one store, as during an overlapping deploy, each send
  every event they find. Resets on both at the same moment can delete a
  subscription made in between for the key that won; that device subscribes
  again when the console next opens.
- A host restored from a transfer document has no subscriptions.

### Considered and rejected

- **A dependency for the protocol (`web-push`).** The spike proved a
  126-line WebCrypto implementation against Apple. Both RFCs are fixed, and
  the dependency brings its own HTTP stack and a Node crypto path.
- **Replacing the key when its row does not open.** It would delete every
  device's subscription after a deploy with the wrong secret key, which the
  operator would otherwise fix by restoring the key. Two hosts with different
  keys on one store would replace each other's key without end.
- **Sealing the subscriptions.** The browser's keys allow encryption only,
  and the endpoint is useless without the host's VAPID key, which is sealed.
- **Retrying in the channel.** The push service queues for a day. A retry in
  the host would need a timer that a restart loses, for an outcome the next
  event or a test push already gives.
- **Refusing to start when the setting is misconfigured.** ADR 0040 keeps an
  integration's problem from stopping the host.

## Refinement (2026-11-19, MMR-710): the console shows a push and opens its record

On iOS the browser shows a declarative push and opens its `navigate` address
itself, without the service worker. Every other browser hands the push to the
console's service worker, which decides what the operator sees and where a
tap goes.

### The worker's script

The handlers are one script that the generated Workbox worker imports with
`importScripts`. Its name carries a hash of its content, so a deploy that
changes the handlers changes the name, and an installed console never runs an
earlier build's handlers from the HTTP cache. The precache lists the script,
and the build's precache assertion refuses a worker that imports no push
script, or a script the output does not hold. The app-shell worker of
[ADR 0013](0013-ui-embedded-spa.md) is otherwise unchanged: the precache, the
prompt update flow, and its per-tab adoption stay Workbox's.

### A push

- Every push shows a notification. A push whose data is missing, is not JSON,
  or has no `notification` with a title shows a generic notification titled
  `Mimir` that opens the console's root.
- A notification shows the payload's title, body, tag, `lang`, and `dir`,
  with the console's icon. It always has a tag (the generic tag `mimir` when
  the payload gives none) and `renotify`, so a browser that replaces by tag
  still alerts.
- `app_badge` sets the icon badge when it is a non-negative integer at the
  top level, and 0 clears it. A browser without the Badging API, or one that
  refuses, still shows the notification.

### A tap

- A tap closes the notification and opens the payload's `navigate` address
  only when that address is absolute and on the worker's own origin. Any
  other address opens the console's root.
- When a console window is open, the worker navigates it to the address,
  then focuses it. A refused focus leaves the navigation in place. When no
  console window is open, or the open one refuses to navigate (a window the
  worker does not control), the worker opens a new window at the address.

### The badge from the console

The open console sets the badge to the size of the needs-you set after each
successful read of that set in the current session, and clears it at zero. It
does not set the badge from a cached read restored at start, so a count shown
offline is the last push's, not an older read's. A read counts when its data
is newer than the moment the console started; a device clock moved back since
the cached read can let that read count until the next one lands. The count the console shows
in _Needs you_ and the `needs_you` a push carries come from the same set, so a
read corrects a badge that a push left too high.

### Considered and rejected

- **Showing the notification from the payload alone, without a fallback.** A
  push the worker cannot read would arrive silently; a generic notification
  tells the operator something needs them and opens the console.
- **A fixed script name.** The browser may fetch an imported script from its
  HTTP cache when the worker updates, so the new worker could run the old
  handlers for hours after a deploy.

## Refinement (2026-11-19, MMR-711): the console's Notifications control

The console subscribes a browser to the Web Push channel from one page,
Settings › Notifications (`/settings/notifications`). It sits first in the
"This device" group of Settings, above Appearance, in the index, the phone
drawer, and the desktop sidebar, because it acts on the browser the operator
holds. The index row shows how this browser stands: On, Off, Blocked, Add to
Home Screen, or Unavailable.

### This browser's states

The page derives one state from the host's status, the browser's abilities and
permission, the browser's own subscription, the host's device list, and a local
record. The host's states win over the browser's, and the browser's win over
the record's.

1. **Not set up**, **set up wrong**, and **key unusable** (Unavailable). The
   page says what the host needs: the setting and the kind of problem, never a
   value. In `key unusable` it also offers Reset push key.
2. **Add to Home Screen**, **unsupported**, and **blocked**. An iPhone or iPad
   outside the Home Screen app gets the three steps. A browser without service
   workers, a push manager, or Notification is unsupported. A denied
   permission shows how to undo it for the platform and browser.
3. **Removed**, **off**, and **on**. Removed means this browser's record says
   another device removed it, or its push service stopped accepting it. On
   means the browser holds a subscription whose endpoint is in the host's
   list. Off is everything else, including a granted permission with no
   subscription the host knows.

The host stores each endpoint as its parsed URL's `href`, so the console
compares a browser's endpoint with a row, or with the record, after the same
normalization; an endpoint that does not parse compares as written. A read of
the browser's subscription waits at most 5 seconds for the service worker; a
read that runs out of time answers that the subscription is unknown, not that
there is none. The page shows such a browser as Off and offers Turn on instead
of waiting; the healer does nothing with it (see below).

Turn on is a button in Removed and Off. Turn off and Send test notification
are in On. Where this browser cannot act, no button shows. The sentence under
the group carries the state, the last delivery or the last failure, and the
answer to each action, in a polite live region.

### Labels

The label is generated from the browser and never typed: `<Platform> ·
<Browser>`, such as `Mac · Chrome` or `iPhone · Home Screen app`, at most 60
characters. An iPhone or iPad running the Home Screen app reads `<Platform> ·
Home Screen app`, and an installed app elsewhere reads `<Platform> · <Browser>
app`. iPadOS asks for desktop sites and reports a Mac, so a Mac user agent
with more than one touch point is an iPad.

### Turn on and Turn off

Turn on runs from the click itself, so the permission prompt has the user's
activation. When permission ends granted, the console subscribes through the
service worker with the served public key, sends the endpoint, the two keys,
that key, and the label, and writes its record. Between the prompt and the
subscribe it waits for a heal that is running (see below), at most 10 seconds.
When that heal finishes within the wait, the two never subscribe at once. A `stale_key` answer refetches the status and tries once
more. Any refusal or failure, including a permission
prompt that throws or a service worker that has not started within 10 seconds,
clears the record and unsubscribes the browser side, so the browser and the
host agree and an earlier turn on or removal no longer speaks for this
browser. The page says why in one sentence, and Turn on is offered again. A
`wrong_origin` refusal links to the console address from the status.

Turn off first waits for a heal that is running, so a heal that read the
record before the click cannot turn notifications back on after it, provided
the heal finishes within the 10 second wait; if that
heal sent a new endpoint, Turn off removes it from the host too. Then it
clears the record, unsubscribes the browser, and removes the endpoint from the
host. The record goes first because it is what the healer acts on: if a later
step fails, the next console load must not subscribe this browser again. The host's row is removed even when the
browser's unsubscribe fails, so no device lists a browser the operator turned
off; the page then says that this browser couldn't be turned off.

### The local record

Each browser keeps one small record in its own storage: `on` with the endpoint
and the public key it subscribed with, written by a successful turn on or heal,
or `removed`. Turn off clears it, as does a turn on the host refuses or that
fails, and a heal the host refuses for a reason this browser causes (see
below). The next successful turn on replaces it. A record from before the key
was kept reads as `on` with no key. Storage that is blocked or unreadable is no
record. The record is what lets the console tell a device that never turned
notifications on from one that did and lost its row.

### Healing when the console opens

The console compares what the browser holds with what the host serves once per
console load, from the shell, so no page has to be open. When the console
loads, the shell reads the browser once: unless it supports push, permission
is granted, and the record is `on`, there is nothing to heal, and the shell
asks the host nothing for the rest of the load. Otherwise it evaluates the
first time the status and the device list have both loaded, reading the record
once for that evaluation, and never again in the same load, whether or not it
healed. A record written later in the load, such as by a Turn on, or a device
list that a read started before the heal returns after it, therefore cannot
start a second heal against a stale list. The heal acts only when the status
is `ready`. It makes one decision:

- **The key changed.** The browser's `applicationServerKey` differs from the
  served public key: the host reset its key. The console unsubscribes,
  subscribes with the served key, sends the new subscription under a label
  generated again from the browser, and removes the old endpoint from the
  host. A browser that does not report its `applicationServerKey` is judged
  first by the key its record kept: a key other than the served one counts as
  a changed key, so a reset that deleted its row subscribes it again. When the
  record's key is the served one, or the record has none, the host's row for
  its endpoint decides: a row on the current key needs nothing, a row on an
  old key counts as a changed key, and no row is a removal.
- **The browser replaced or dropped it.** With no subscription, the console
  subscribes again. With an endpoint other than the record's, it sends the new
  subscription. Either way it removes the record's old endpoint from the host.
- **The host removed it.** The endpoint and key match the record, but the
  host's list lacks the endpoint. The console unsubscribes the browser and
  writes `removed`. It never subscribes again here: a Remove from another
  device must stick until the operator turns notifications on again.

The heal acts only on a subscription it could read. When the read runs out of
time waiting for the service worker, the heal does nothing in that load, even
if the worker starts later: taking an unknown subscription for a dropped one
would subscribe again a browser another device removed.

The host's answer to the subscription a heal sends decides what follows:

- `subscribed`: the console writes the record with the new endpoint and the
  key it used, and removes the old endpoint from the host when it differs
  after normalization.
- `wrong_origin`, `too_many_devices`, `endpoint_not_allowed`, or
  `invalid_keys`: this browser causes the refusal and trying again cannot fix
  it. The console unsubscribes the browser and clears the record, so the page
  reads Off with Turn on rather than holding a subscription that nothing sends
  to.
- `stale_key`: another device reset the key during the heal. The console
  rereads the status, subscribes with the fresh key, and sends once more, as
  Turn on does. If the retry is refused for one of the reasons above, it turns
  the browser off; otherwise it leaves the record as it was.
- `unconfigured`, `misconfigured`, or `key_unusable`, or a thrown failure: the
  console leaves the record and the browser's subscription as they are, so
  the next load adopts the subscription or subscribes again.

Every failure is silent. One heal runs at a time: a second request while one
runs joins it. Turn on, Turn off, and the page's heal after a reset wait for a
running heal instead, at most 10 seconds each, so a heal whose host call never
answers cannot hold the page busy. After the wait, Turn on and Turn off act as
they would have; the page's heal after a reset is described below.

### Every subscribed browser

The page lists every row the host holds, newest first, with its label and a
meta line: This device, delivered or failed with the failure, and Old key when
the row was made for another key. This browser's row has no actions. Another
row opens its actions: on a phone a bottom sheet titled with the label, on a
desktop a menu. Send test notification and Remove this browser are on every
other row; an old-key row offers only Remove, because a test to it can only
refuse. Remove wears the destructive red hairline and label in the sheet and
in the menu (ADR 0019, MMR-635 refinement). A test's answer shows in its
row.

### Reset push key

Reset push key is a quiet button under the list when the status is `ready`,
and the one action when it is `key unusable`. Both ask first, saying that every
device stops receiving notifications until its console is opened again. After a
reset this browser subscribes again at once with the key the reset answered,
when the reset's key differs from what the browser or its record holds; each
other device does when its console opens. A record kept before the key was
stored, in a browser that does not report its key, is judged by its row, which
the reset deleted, and ends Off. The page first waits for a
running heal, at most 10 seconds; a heal still running then is left to finish,
and this browser heals on its next load. Otherwise the page rereads the
status and the list and heals with the reset's key, even when the reread
answers an older key: a status read that started before the reset can still
answer the old one, and the reset is newer. A reread that is not `ready`
leaves this browser to its next load. If the reset succeeds but the page
cannot read the new status afterward, the page says the key was reset and asks
for a reload, not that the reset failed.

### Known limits of the control

- A browser that another device removed, and that has also lost its own
  subscription, is subscribed again on its next load. The console cannot tell
  it from a browser whose push service dropped its subscription, which is the
  case healing exists for.
- A Reset on another device that lands between this load's status read and
  its device-list read can leave this browser Off until the operator turns it
  on again.
- A cleanup step that fails can leave a dead row, which goes when its push
  service answers 404 or 410 or when the operator removes it, or a
  subscription in the browser that no push reaches.
- A heal whose host answer arrives after the 10 second wait and succeeds can
  undo a Turn off made meanwhile.
- A status or list read already in flight when Reset is tapped can leave this
  browser Off until Turn on, and a stale `key_unusable` answer skips the
  after-reset heal.
- A status read that never answers keeps Reset's button busy until the page
  reloads.
- A browser that does not report its key and gets a new endpoint, with Turn on
  tapped during a heal, can leave one dead row.
- A record kept before the key was stored, in a browser that does not report
  its key, is judged by its row after a reset and ends Off.

Seed MMR-s80 proposes serializing this browser's push actions to close these.

### Considered and rejected

- **A switch.** Turning on needs a permission prompt that can end denied or
  refused, so a switch would sit in a state it did not hold. A button names
  the action and the sentence names the result.
- **Typed labels.** A label the operator types drifts from what the device is,
  and nothing reads it but the operator. A generated one needs no input and
  says the same on every load.
- **Subscribing again when the host's list lacks the endpoint.** It would undo
  a Remove from another device the next time this browser's console opened.

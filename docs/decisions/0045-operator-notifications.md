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
services require as the VAPID subject (RFC 8292): a `mailto:` address or an
`https:` URL. With it unset, the channel is absent: no channel is registered
with the notifier, nothing is written to `push_subscriptions` or
`host_secrets`, and the console's server functions answer `unconfigured`.

With it set, the host reads three more things, and each problem it finds
makes the channel **misconfigured**:

| Problem                                            | Setting named                                   |
| -------------------------------------------------- | ----------------------------------------------- |
| The value is not a `mailto:` or `https:` URL       | `MIMIR_PUSH_CONTACT` is malformed               |
| `MIMIR_URL` is unset                               | `MIMIR_URL` is unset                            |
| `MIMIR_URL` is neither HTTPS nor HTTP on loopback  | `MIMIR_URL` is not HTTPS                        |
| The secret key is missing, unreadable, or malformed | `MIMIR_SECRET_KEY` or `MIMIR_SECRET_KEY_FILE` |

`MIMIR_URL` is needed because a notification opens an absolute URL, and the
notifier has no request to take an origin from. HTTP on loopback is allowed
for a development host, as the T3 adapter allows it. The key is read and
checked as ADR 0040 describes, whichever integration needs it.

A misconfigured channel warns at startup, one line per problem, naming the
setting and never its value. It is not registered with the notifier and
writes nothing. Its server functions answer `misconfigured` with the first
problem. Settings are read once at startup, so a fix takes a restart.

### The key

The channel signs with one VAPID key pair (ECDSA P-256), kept as the host
secret `push.vapid`: the sealed JSON of the raw public point and the private
scalar, both base64url. The pair is made on first use, which is the first
status read or the first send, and is never rotated by the host.

A row that fails to open (the secret key changed, or the row was altered) is
logged as `host_secret_unopenable` without its contents, as ADR 0040 says.
The channel then makes a new pair, writes it, deletes every row of
`push_subscriptions` (each was made for the old public key, and the push
services refuse a request signed with another), and logs
`push_key_replaced` with the number of rows deleted. Each device subscribes
again; the console compares its subscription's key with the served one when
it opens (MMR-711).

The public key is served to the console in the status answer. The private
scalar never leaves the channel and never appears in a log.

### The table

`push_subscriptions` is a host transport table, like `device_tokens`
([ADR 0038](0038-device-pairing-and-the-version-window.md)): it is in both
store dialects, it is added by a schema version step, and export and import
skip it in both directions.

| Column            | Meaning                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| `endpoint`        | Primary key: the push service URL the browser gave                        |
| `p256dh`          | The browser's public key, base64url                                       |
| `auth`            | The browser's authentication secret, base64url                            |
| `label`           | The name the console gave the device                                      |
| `created_at`      | When the endpoint was first subscribed                                    |
| `last_success_at` | When a push service last accepted a push to it; absent until one does     |
| `last_failure_at` | When the latest failed push to it happened; absent after a success        |
| `last_failure`    | That failure: `HTTP <status>`, `timeout`, or `unreachable`                |

The endpoint and the browser's keys are stored as given, not sealed. The
browser's keys let the host encrypt to the browser, not decrypt, and the
push services named below accept a request to an endpoint only when it is
signed with the host's VAPID key.

There is no recipient column. Every subscription belongs to the one
recipient, the operator, so the notifier's rule above has already decided
whether an event reaches it.

### The server functions

The console calls five server functions, off the Engine. Each one answers
`unconfigured` or `misconfigured` when the channel is not ready, and touches
neither table then.

- **Status** answers `ready` with the public key.
- **Subscribe** takes the endpoint, the two browser keys, and a label. It
  refuses, and writes nothing, when:
  - the endpoint is not an `https:` URL with no user, no password, and the
    default port, on one of the push hosts below (`endpoint_not_allowed`);
  - `p256dh` does not decode to a P-256 public point, or `auth` does not
    decode to 16 bytes (`invalid_keys`);
  - the table already holds 20 rows and the endpoint is not one of them
    (`too_many_devices`).

  The label is plain text: runs of whitespace collapse to one space, it is
  cut to 60 characters, and an empty label becomes `Device`. A subscribe with
  an endpoint the table holds replaces that row's keys and label, clears its
  failure, and keeps its `created_at`.
- **Unsubscribe** takes an endpoint and deletes its row. An endpoint with no
  row is not an error.
- **List** answers every row, newest first, with its endpoint, label, times,
  and last failure, but not its keys.
- **Send test** takes an endpoint and sends one push to it alone, then
  answers `delivered`, `gone` (the row was deleted, below), or `failed` with
  the failure. An endpoint with no row answers `not_found`.

The push hosts are the services of Apple, Google, Mozilla, and Microsoft:

| Service   | Host                                                  |
| --------- | ----------------------------------------------------- |
| Apple     | `web.push.apple.com`, or a host ending `.push.apple.com` |
| Google    | `fcm.googleapis.com`                                  |
| Mozilla   | a host ending `.push.services.mozilla.com`            |
| Microsoft | a host ending `.notify.windows.com`                   |

The browser chooses the endpoint, so the allowlist is what keeps the host
from posting to an address of the browser's choosing. A host is compared in
lowercase, after the URL parser normalizes it.

### Sending

The channel's `deliver` reads the table and sends the event to every row at
once. It resolves when every send has an outcome. It rejects only when the
table or the key cannot be read, which the notifier logs as
`needs_you_channel_fault`.

Each push is one HTTP `POST` to the endpoint:

- The body is the payload below, encrypted for the row's keys with RFC 8291
  (`aes128gcm`, one record).
- `Authorization: vapid t=<JWT>, k=<public key>`, where the JWT (ES256) has
  `aud` set to the endpoint's origin, `sub` set to `MIMIR_PUSH_CONTACT`, and
  `exp` 12 hours ahead. Apple refuses an `exp` more than a day ahead.
- `TTL: 86400`, so a push service holds an undelivered push for a day, and
  `Urgency: high`. No `Topic` header is sent.
- Redirects are not followed, and a send that has no answer in 10 seconds
  is a `timeout`.

The outcome of a send updates its row:

| Answer                         | Row                                           | Log                                    |
| ------------------------------ | --------------------------------------------- | -------------------------------------- |
| Any 2xx                        | `last_success_at` set, failure cleared        | nothing                                |
| 404 or 410                     | deleted                                       | `push_subscription_gone`               |
| Any other status, or no answer | `last_failure_at` and `last_failure` set      | `push_send_fault`                      |

Both log lines carry the endpoint's host and the status (or `timeout` or
`unreachable`), never the endpoint's path, a key, the JWT, or the payload.
The channel does not retry. The push service already holds a push for its
time-to-live, and the next event or a test push tries again.

A send cannot fail the write that caused the event: the notifier does not
wait for its channels.

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
  on replacement.
- `app_badge` is the event's `needs_you` count, at the top level as an
  integer. Safari 26 moved it there from `notification`, where a string value
  crashed earlier versions. A test push carries no `app_badge`.
- The event's title and body are already plain and bounded (above), so the
  payload stays far below the 4 KB the push services accept.

A test push has the title `Mimir test notification`, the body
`Notifications reach this device.`, the tag `test`, and opens the console's
root.

### Known limits of the channel

- Apple went on answering 201 for a removed app's endpoint for minutes after
  the removal (MMR-707). A dead subscription is deleted when a push service
  answers 404 or 410, or when the operator removes it from the device list,
  so a row can outlive its device.
- A browser that is given a new endpoint subscribes as a new row, and its old
  row stays until one of the above.
- Two hosts that serve one store, as during an overlapping deploy, each send
  every event they find, and the first use of the key on both can make two
  pairs, the later of which wins. A subscription made with the losing key
  fails until the device subscribes again.
- The channel sees only the subscriptions in its own store, so a host
  restored from a transfer document has none.

### Considered and rejected

- **A dependency for the protocol (`web-push`).** The spike proved a
  126-line WebCrypto implementation against Apple. Both RFCs are fixed, and
  the dependency brings its own HTTP stack and a Node crypto path.
- **Sealing the subscriptions.** The browser's keys allow encryption only,
  and the endpoint is useless without the host's VAPID key, which is sealed.
- **Retrying in the channel.** The push service queues for a day. A retry in
  the host would need a timer that a restart loses, for an outcome the next
  event or a test push already gives.
- **Refusing to start when the setting is misconfigured.** ADR 0040 keeps an
  integration's problem from stopping the host.

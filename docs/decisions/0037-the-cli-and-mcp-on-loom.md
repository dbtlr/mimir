---
title: 'ADR 0037: The CLI and MCP on Loom'
description: The mimir CLI is a Loom application whose commands call only the Engine. Help is generated, failures take Loom's failure shape, Loom generates the MCP contract from the commands, and a parity harness holds each port to the old CLI.
status: accepted
date: 2026-10-18
---

# ADR 0037: The CLI and MCP on Loom

The CLI and the MCP server in `packages/bin` hand-roll their parsing, help,
format selection, error envelopes, and tool registration. ADR 0034 put every
operation behind the Engine, so a transport no longer needs to reach the core.
Loom is a CLI framework that generates help, formats, failures, and an MCP
surface from one set of command declarations. This record settles how Mimir's
CLI and MCP move onto it.

## The decision

### The CLI is a Loom application whose commands call only the Engine

The new CLI is the private package `packages/cli` (`@mimir/cli`), on Loom
0.13. It grows command by command beside `packages/bin` and replaces it at
cutover, when `packages/bin` is deleted.

`src/app.ts` is the composition root. It builds the `LocalEngine` over the
configured store, the project binding over the clone's git config (ADR 0036),
and the Loom Application. It is the only module that imports `@mimir/core`. It
hands each command a set of ports: the Engine, the binding, and the pure input
grammar and wire codecs the CLI shares with the other transports, such as the
`FIELD:VALUE` filter parser and the node wire mapper. A command reads work
state through the Engine alone. An oxlint rule refuses an import of
`@mimir/core` outside `src/app.ts`, and an import of `@mimir/bin` outside the
package's tests. The test-support modules under `src/testing` are the one
exemption: they build stores and run the old CLI for the parity harness, so
the same rule refuses an import of them outside the tests.

### Help is generated

Loom's help plugin renders each page from the declarations: the command and
input descriptions, each option's placeholder, and the examples a command
declares. `-h` prints the compact page, and `--help` the extended page with
examples. This keeps ADR 0009's help tiers and replaces the hand-written
`COMMAND_HELP` descriptors. A page is pinned in a test and re-pinned when it
changes on purpose.

### Formats keep their contract

The formatter plugin adds `-f, --format` to each command that declares a
result. Each command declares its views by name: `table`, `records`, `ids`,
`json`, and `jsonl`. The `json` and `jsonl` views declare their media types,
so Loom writes a failure as JSON under them. A command can declare a different
default view on a terminal and in a pipe; an explicit `-f` overrides it. `get`
and `next` keep one default on both destinations, `records` and `table`.

The `ids`, `json`, and `jsonl` bytes are unchanged, with three exceptions.
DEL and the C1 controls (U+007F to U+009F) print as `\uXXXX` escapes, as
Loom's own JSON views write them, so that no terminal control reaches a
terminal. The escaped text parses to the same value. Two commands gain a
declared `jsonl` view: `status` printed styled text under it, and `overview`
refused it as a composite; both now print one compact JSON document, the compact form of their `json`
document. The harness records these as `new-view` differences. A board read that names one
project (ADR 0034) may refuse, or return less, where the old CLI read wider;
the harness records those as `board-read` differences, and an exit-0 read
must show only ids the old read showed. `table` and `records`
are evolvable layout (ADR 0009).

### Failures take Loom's failure shape

A failure is `{code, exitCode, message, hints}`. A domain refusal (a
`MimirError`) exits 1 with its code in kebab case: `not-found`,
`validation`, `conflict`, or `invariant`. A usage error Mimir raises, such as
an unknown column or a bad priority, exits 2 with the code `usage` and keeps
its message. A fault Loom's parser finds, such as an unknown option, a missing
value, or a missing argument, exits 2 in Loom's words and with Loom's code. A
flag that belongs to another command, or was retired, keeps the old CLI's
redirect as its hint; the harness records those as `flag-redirect`
differences. A failure's own hint is its first hint, and help's pointer follows
it.

On the terminal a failure prints its sentence and then each hint on its own
line. Under a `json` or `jsonl` view it prints one line on stderr,
`{"error":{"code":…,"exitCode":…,"message":…,"hints":[…]}}`. This replaces
the old envelope `{"error":{"code","message","hint"}}`.

### A board read names one project

A board read takes its project from `-s KEY` or from the clone binding. The
Engine reads one board at a time (ADR 0034), so `-s all` is retired. An
unbound clone with no `-s` is refused with a usage error that names both
ways to supply the project. A project name not shaped like a key is refused as a
missing project, `not-found` with the create hint, as the old CLI refused it.

### A parity harness holds each port to the old CLI

Each ported command passes a parity harness. A case runs through the old
CLI's `runCli` and the new CLI over one store. Most cases run the new CLI by
name through `app.invoke`, piped; argv cases run a literal argv through
Loom's parser, piped or on a color terminal. The two must agree:

- `json`, `jsonl`, and `ids` output and exit codes are byte-identical;
- `table` and `records` output may differ only by the lines an entry in a
  checked-in difference list names, with the reason for each;
- a failure compares by exit code, code, message, and hints, except a fault
  Loom's parser raises, which a difference entry names and which compares by
  exit code alone;
- an argv the old CLI accepted and Loom's parser refuses, such as a repeated
  single-value option, a stray positional, or `-s` before the verb, is a
  difference entry of its own, which requires exit 2 and a code of Loom's;
- an option the old CLI refused as a Mimir validation failure (exit 1) because
  the command does not take it, such as `--remote` on `create initiative`, is
  scoped to the command that declares it in Loom, so it is an unknown option
  at exit 2; a difference entry of its own requires exit 1 from the old CLI
  and exit 2 with a code of Loom's from the new;
- input the old CLI accepted and the Engine refuses, such as blank annotation
  text, is a difference entry of its own, which requires the old exit 0 and a
  Mimir refusal (exit 1) from the new CLI that writes nothing;
- help is pinned, never compared.

Two differences every case carries are normalized rather than listed: through
argv, help's plugin appends a `Run "mimir <cmd> --help"` pointer as the last
hint of every usage failure, and on a terminal Loom closes each style with its
own reset (`\e[22m` after bold, `\e[39m` after a color) where the old CLI
wrote `\e[0m`. A Loom entry whose new failure carries a Mimir code, or whose
failures match, fails its case, and an entry that matches no case fails its
command's parity test, so the list does not go stale.

### Loom generates the MCP contract

A command opts in to MCP with Loom's `mcpCommand` declaration as it is ported.
At cutover `mimir mcp` is Loom's MCP plugin, and its generated surface is the
MCP contract: the tool and argument names, the descriptions, and the validation
voice come from the command declarations. A tool's structured content is the
output of the command's first `application/json` view. MCP parity means equal
capability and equal structured content, not identical schemas. The old MCP
server runs until cutover.

This supersedes ADR 0025 Decision 4 for the CLI and MCP: help text and tool
descriptions are each command's own declaration, not per-transport templates
over registry facts. The operation facts remain the source of each uniform
verb's grammar.

## Why

- **One declaration feeds every surface.** Help, the format option, failures,
  and MCP tools derive from one command, so they cannot drift apart.
- **The Engine boundary is enforced, not hoped for.** A command that cannot
  import core cannot reach a store around the Engine, which keeps the remote
  path of phase 4 a change to the composition root alone.
- **Scripts keep their contract.** The structured formats and exit codes are
  what scripts depend on, so the harness holds them byte for byte. Layout and
  help prose are for people and may improve.
- **Loom's failure shape is a machine contract the old envelope was not.** It
  carries the exit code and a list of hints, and Loom writes it the same way
  for every failure, a parser fault included.

## Considered and rejected

- **Wrapping the old `runCli` in a Loom command.** It keeps the hand-rolled
  parser and help, which is what the move retires.
- **Comparing help and parser errors with the old CLI.** Loom owns their
  layout and voice; matching them byte for byte would mean overriding Loom
  everywhere for no reader's benefit.
- **Keeping per-transport description templates.** Each command already
  declares its description for help, and MCP reads the same declaration.
- **Moving the grammar and wire codecs out of core.** They depend on core's
  field spec and date rules. The composition root supplies them instead, so
  commands stay core-free without a second copy.

## Consequences

- `packages/cli` ports the styled renderers from `packages/bin`. Until
  cutover the two copies exist side by side; the old one is deleted with
  `packages/bin`.
- The output-contract reference documents the old CLI until cutover, when its
  error envelope and help sections move to this record's shapes.
- ADR 0009's help tiers hold, rendered by Loom. ADR 0025 Decision 4 no longer
  governs CLI help or MCP tool descriptions.
- The remaining ports (MMR-549 to MMR-554) extend the harness case lists and
  the difference list. The cutover (MMR-555) waits for Loom 0.15.

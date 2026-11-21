---
name: loom
description: Use when writing, changing, testing, building, or shipping a command-line application built with Loom (@loomcli/core). Teaches how a Loom application fits together, which the code and its doc comments do not show, and links the reference for each rule.
metadata:
  version: "0.20.0"
---

<!-- Managed by loom init. sha256:c9b5d93ab9ed9fbd58273d3b1009bdca6210f42ca39e15e4e68fb4b29af1e91a -->

# Author a Loom application

Loom is a toolkit for typed command-line applications. One immutable command graph serves the terminal, `--format`, MCP tool calls, and callers that invoke a Command in their own process, so a Command declared once reaches people and agents alike. The author writes the Application, its Commands, and their actions; Loom does the parsing, routing, rendering, projections, and the toolchain that builds and ships it.

Read the doc comment of every export you use. It states the export's contract, shows an example, and links its reference page. This skill covers what those comments do not: how the parts fit and which one to choose.

## Rules to apply first

- **Declare, then run.** The application module, `src/application.ts`, declares and exports one Application. The entry, `src/main.ts`, imports it and calls `run()`. Never call `run()` in the application module, and never import the entry, from a test or anywhere else.
- **One Command, one module, by convention.** Put each Command in its own module under `src/commands/`, and attach it with `command()`. Nothing in Loom reads the file layout, so this is a convention that keeps modules small. A Command module never imports the Application, because the Application imports it.
- **Choose the mechanism by its reach.** The work of one Command is its action. A step several actions repeat is a plain function. A typed value an action reads is a provider. Code around every invocation is a middleware, which belongs to a plugin.
- **Data is a result.** A Command whose output a script, `--format`, or an agent reads declares `result()` or `rows()` and emits it once through `out.results`. Messages go to stderr through `info`, `warn`, and the other levels.
- **Fail by throwing.** A failure is a thrown failure class, such as a `FatalError` subclass, whose class sets the exit code. An action's return value is ignored. Never call `process.exit()` or set `process.exitCode`.
- **Read the machine through `host`.** Read the environment, the working directory, the platform, standard input, and child programs through `host`, never through `process`, so a test can state them. The [`host-bypass`](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/libs/eslint-plugin.md#host-bypass) lint rule does not report `node:fs`, so resolve a path the operator supplied against `host.cwd` before you hand it to `node:fs`, or declare a [content input](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/validation.md#content-inputs) and let core read the file.
- **Test in the test's process.** Keep the assembly test `loom init` writes. Run the whole application on a `mockProcess` handle from `@loomcli/testing`, and unit-test an extracted action with its context helper.
- **Run `loom` through the package manager.** `@loomcli/loom` is a development dependency of the package, so run `pnpm loom build` or `npx loom build`, for example.
- **Paths have conventions.** This skill names each path by its convention, such as `src/application.ts`, `src/main.ts`, `.changes/`, and `dist/`. A `loom.config.json` beside `package.json` moves them, so read its `paths` before you use one.

## References

Read the reference for the work at hand.

- [Structure](references/structure.md): read it when you lay out files, add a Command or declare its inputs, install a plugin, or share an option, a view, or a failure class.
- [Middleware and actions](references/middleware-and-actions.md): read it when you decide where work goes, write an action's messages, progress lines, or questions, or write a middleware.
- [Results and failures](references/results-and-failures.md): read it when you declare what a Command produces, throw or translate a failure, or write a failure message.
- [Testing](references/testing.md): read it when you write or change a test.
- [Toolchain](references/toolchain.md): read it when you run `loom init`, `loom build`, `loom changelog`, `loom docs`, or `loom skills export`, or change `loom.config.json`.
- [Shipping](references/shipping.md): read it when you choose a build target, publish a release, ship through npm or Homebrew, or set up installation and self-update.

The `loom-changelog` skill beside this one teaches the change fragments and version cuts.

For a rule this skill does not cover, start at the reference maps: [core](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/README.md), [plugins](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/plugins/README.md), [libraries](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/libs/README.md), and [the toolchain](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/toolchain/README.md). The [glossary](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/glossary.md) defines each term this skill uses.

<!-- Managed by loom init. sha256:e1308cf79be2a8d0084f05e537a6c7246600f6dd24f55425ceb022ef94badec1 -->

# Middleware and actions

This reference covers when work belongs in a Command's action and when it belongs in a plugin's middleware, how the middleware chain runs around an action, and what each one may read and write.

## Choose the mechanism

An action does one Command's work. A middleware wraps every invocation that activates it, whichever Command was routed. Most work an application adds is an action. Choose by the job:

- The work of one Command: that Command's action.
- A step several actions repeat, such as reading a document: a plain function each action calls.
- A value the operator supplies that every action reads: a [global option](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/commands.md#global-options).
- A typed value an action reads, such as a pool, a session, or data derived from global options: a [provider](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/providers.md) the Command opts in to.
- Code around every invocation, such as an audit line or a state restore: an `'always'` middleware.
- Code around an invocation when the operator asks for it, such as `--timing`: a middleware activated by its own option.
- Ending an invocation in place of the action, as `--help` and `--version` do: a middleware activated by its own option that takes over by returning without calling `next()`. Core never reads `control: true`, so the mark does not make the middleware take over. Mark the option `control: true` anyway, as you would any option that controls the run rather than feeding the Command's work, so a projection such as the MCP tool listing leaves it out of what the Command needs, under [control options](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/commands.md#control-options).
- Choosing the view a result renders through: a middleware that assigns `view`.
- Adding an option or a fact to every Command at graph build: an [`onCommandAttach`](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/lifecycle-hooks.md) hook. It runs for each Command once per Application and build in a process, so it reads only the declaration it receives, never the host or the run. Work that depends on the run goes in a middleware.
- Adding hints to a failure, observing log events, or adding environment variables: [`onFailure`](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/lifecycle-hooks.md#failure-hints), [`onLog`](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/lifecycle-hooks.md#observing-log-events), or [`onEnvironment`](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/plugin-contract.md#environment-preparation).
- Keeping a record of runs, as JSONL files, a console stream, or an OpenTelemetry logger: install [`logging()`](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/plugins/logging.md) with its `destinations`, not an `onLog` hook of your own. Operators then get `<APP>_LOG_LEVEL` and `<APP>_LOG_FILE` for its file destinations, and with a file destination, a failure that `failureHint` selects, by default any but a usage error, names the run's log file.

An Application has no middleware of its own. Middleware belongs to a plugin, so an application that needs one writes a plugin and installs it in its `plugins` list, under the same [plugin contract](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/plugin-contract.md) as a first-party plugin. [Structure](structure.md) says where that plugin's files go.

## What an action reads and writes

An action receives the validated invocation. Declare a validator on the input instead of checking the value again in the action.

- **It reads** `args`, `options` (the Command's local options and every global option), `provided`, `host`, `signal`, `stdin`, `supplied`, `interactive`, `graph`, and `command`, and `passthrough` on a Command that declares `.passthrough()`. It reads the machine only through `host`; the [`host-bypass`](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/libs/eslint-plugin.md#host-bypass) lint rule reports `process`, `node:os` folders, and `node:child_process`.
- **Its result is data for a consumer.** Declare `result()` or `rows()` on a Command whose output a script, `--format`, or an MCP tool call reads, and emit it once through `out.results` before the action returns. On such a Command stdout carries the result alone, and `out.print` and `out.render` move to stderr, under [Stdout belongs to the result](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/results.md#stdout-belongs-to-the-result). [Results and failures](results-and-failures.md) says when to declare one.
- **Its messages are about the work.** Progress, notes, and summaries go to `out.info`, `out.success`, and `out.warn` on stderr. Out has five lanes: `print`, `info`, `success`, `warn`, and `error`. Verbosity decides whether `info` and `success` write. Detail goes to `log.debug` and `log.trace`, which `-v` and `-vv` show as log lines. Write the message as a constant template and pass each value as a field, `log.debug('Read {file}.', { file: args.file })`. The line fills and escapes the field, and the record keeps the template searchable. `log.with({ request })` binds fields that every event of one piece of work repeats, and the Application's `log: { redact: [...] }` replaces the listed field paths with `"[Redacted]"` everywhere. See [Logging](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/logging.md). A second argument gives a message another look at its level: `out.info('Building 3 packages', step())`, with `step` from `@loomcli/plugins/step`, marks a stage of the work, and `box({ title })` draws a note, under [A message's own view](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/output.md#a-messages-own-view). Every message ends with exactly one line break, so a text that ends with one prints no blank line after it.
- **Progress lines and questions adapt to the screen.** On a terminal that redraws in place, `progress()` redraws its line and a question redraws its frame. Elsewhere `progress()` prints its plain start and end lines, a question on a terminal that does not move its cursor asks line by line, and off a terminal or under CI a question does not ask at all: it takes its supplied linked input or fails, under [Interaction](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/interaction.md). So do not test for a terminal yourself. An operator turns redrawing off with `ACCESSIBLE` set, or `--plain` from the [plain plugin](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/plugins/plain.md): a progress line then prints its start and end lines, a streamed message is written a line at a time, and a question asks [line by line](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/libs/prompts.md#asking-line-by-line). A region you open with `out.region()` yourself reads `live` and writes plain lines when it is `false`, as `progress()` does. A Command whose action works only at a terminal, such as a full-screen view or a raw-mode editor, declares `needsTerminal()` before `action()`. Without a terminal or under CI it fails before the action with `TerminalUnavailableError`, exit 1, and it always fails under `invoke`. The MCP plugin refuses it as a tool, under [A Command that needs a terminal](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/commands.md#a-command-that-needs-a-terminal).
- **A progress line ends as the work did.** Call `end()` for a success, `fail()` for a failure, `skip()` when the work had nothing to do, `warn()` when it finished with a problem the operator should see, and `clear()` when the line leaves nothing worth keeping, such as a quick check before the real work. `track(work)` ends only with `end` or `fail`, so await the work and call the end yourself for the other three. A line that fails or is cancelled keeps its text, so do not clear one to hide a failure. An `onProgress` observer and an MCP client read `skipped` and `warned` ends, and a cleared line as `ended`, under [Progress](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/libs/prompts.md#progress).
- **A long counted line can show its pace.** Pass `estimate: true`, and `unit` for what it counts, to `progress()`, and report `completed` through `update()` as the work goes: the running line then shows its rate and time left, `40/120 · 12.0s · 3.3 files/s · about 24s left`, once a second of reports has passed. Start no timer for it. The line computes both from your reports and the clock, and the end line and the plain lines show neither, under [Rate and time left](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/libs/prompts.md#rate-and-time-left).
- **A child program's output belongs in the line's log.** Pass its text to `log()`, a string or an async iterable such as a `PassThrough` built with `encoding: 'utf8'` that `host.spawn` writes into, each chunk escaped with `style.escape`, one `log()` call for each stream so a partial line of one never joins the other's, and await every `log()` before you end the line. The running line shows the newest 5 lines under it, fewer on a short terminal, where the run's open lines share its height, `end()`, `skip()`, and `clear()` remove them, and `fail()`, `warn()`, and a cancellation write the kept lines, at most 1000, above the end line, so do not print the child's output yourself to keep it. `logRows` and `logLimit` change the two counts, under [A line's log](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/libs/prompts.md#a-lines-log).
- **The parts of one piece of work belong in a task group.** Open each part as a task with `task()` on the line that holds them, `const build = deploying.task({ label: 'Building the image' })`, and end each task as you would a line; run them in order or at once as the work needs, because the library schedules nothing. A task still open when its parent ends takes the parent's end, a group that succeeds leaves its own end line alone, and one that fails, warns, or is cancelled keeps its tasks under it, with each failed task's kept log lines above its end line. Pass `keepTasks: true` to keep a group's tasks on success too. Where the line prints plain lines, each task prints its start and end lines through the lane, its text stepping in under its parent's after the glyph, under [Task groups](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/libs/prompts.md#task-groups).
- **A dependency's console writes tear a drawn line.** A `console.log` from a library you call while a progress line or a question is drawn lands inside it. Install [`patchConsole()`](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/plugins/patch-console.md) from `@loomcli/plugins/patch-console`, which routes the console through `out` above the drawn lines while any is drawn, rather than silencing the library.
- **A child program that draws on the terminal borrows it.** Run an editor, a pager, or `git commit` inside `out.lendTerminal(work)`, so the drawn lines hold still while it runs and draw again below what it wrote, under [Lending the terminal](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/output.md#lending-the-terminal).
- **A question answers an input.** Link each question from `@loomcli/prompts` to the option or argument it answers, with `option` or `argument`: a supplied value then prefills it, except at a `secret`, which starts empty, or with `skipIfSupplied` answers it, and a run that cannot ask takes the supplied value or fails for it. Choose the kind by the answer: `text`, `secret`, or `confirm` for one value, `select` for one of a set, `multiselect` for several, which links a multiple option or a variadic argument, and `editor` for text longer than a line. Give a long list `search: true`, or a `source` that fetches the choices for what the operator types. A linked `select` or `multiselect` answers the input's validated value, under [Linking an input](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/libs/prompts.md#linking-an-input).
- **A message can stream.** Text that arrives over time, such as a model's answer, goes to the same methods as an async iterable of strings: `await out.print(answer())`. Each chunk shows as it arrives on a terminal, a pipe receives whole lines, and the call resolves when the iterable ends. On a terminal every other write waits for the end of a streamed `print`'s line, so an iterable that feeds `out.print` yields its line break before it awaits another `out` call, or it waits on itself. Escape raw text chunk by chunk with `style.escape`, pass no view, and narrow a value that may be either form before the call, under [A streamed message](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/output.md#a-streamed-message). Do not split the text into one `out` call per chunk, which ends every chunk with a line break.
- **Its return value is ignored.** A normal return succeeds unless its output fails, it did not emit a declared result, the run was cancelled, which resolves the cancellation code, such as 130 for Ctrl-C, or a provided value's close throws, under [Closing](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/providers.md#closing). A failure is a throw: `out.fatal(message)`, or a failure class such as a `FatalError` subclass, whose class decides the [exit code](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/failures.md#declared-exit-codes). Never set `process.exitCode` or call `process.exit()`.
- **Its catch is final.** An action that catches a failure and returns ends the run with what it produced, under [the ordinary failure path](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/failures.md#the-ordinary-failure-path).
- **It restores what it changes.** Restore raw mode, the cursor, or a child program in a `finally`, and register a synchronous [`onShutdown`](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/signals.md#onshutdown) handler so a shutdown that runs out of budget restores it too. Read `signal` in long work. Do not register `process.on` handlers.
- **It alone runs other Commands.** `invoke` is on the action context, not the middleware context.
- **It can load its work when it runs.** Every module the Application imports statically loads at launch, whichever Command runs. When a Command's work, or a dependency only it uses, is large, keep the extracted handler in its own module and give the declaration an inline handler that loads it with `import()` and passes it the context, under [Loading an action's work when it runs](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/commands.md#loading-an-actions-work-when-it-runs). The handler type-imports its declaration, and the declaration never imports the handler statically. A `node` or `bun` bundle puts that module in a chunk of its own; a compiled binary carries the module's code but evaluates it only when the action imports it.

## What a middleware reads and writes

A middleware reads the routed invocation after parsing and validation, under [Middleware](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/middleware.md).

- **It reads** `options` (every global option's value, or `null` while core holds a fault on a global option), `ownOptions` (its own plugin's validated options, even under a held fault), `spellings`, `request`, `graph`, `command`, `view`, `mediaType`, `host`, `signal`, `unknownCommand`, and `invokedBy`. `invokedBy` is `'name'` under `invoke` and MCP, so a middleware that serves only a command-line operator reads it. A takeover reads `mediaType` to choose its encoding, as the version plugin's extended output prints JSON under `--format json`, at a group or on a Command that declares a result, when `format()` is installed ahead of `version()`, because on a Command that declares no result, a group included, a takeover reads only the media type a middleware that ran before it assigned. On a Command that declares a result, `mediaType` follows the selected view.
- **`request` is untyped and may be `null`.** It is `null` while core holds a fault and on a group, and its records are frozen and typed `unknown`. Check each value before you use it.
- **It writes** `view`, `mediaType` on a Command that declares no result, and `transform`, one `ResultTransform` per run that reshapes the result before its view, as `--fields` does, before `await next()`, because an assignment after the dispatch boundary changes nothing. It also writes output through `out`, `log`, and `onShutdown` handlers. Its `out` keeps the default destinations on every Command, so its `print` reaches stdout even on a Command that declares a result.
- **It cannot hand the action anything.** It cannot replace the request, `next()` takes no argument, and the action context has no member a middleware fills. A value the action needs comes from a provider.
- **It continues or takes over.** `await next()` runs the rest of the chain and resolves `'dispatched'`, `'taken-over'`, or `'cancelled'`. Returning without calling `next()` takes over: the action never runs, a held input fault is never raised, and the exit code is the one the middleware states through `exitCode` (0 when it states none) unless the middleware or its output fails or the run is cancelled.

## Order and activation

- **Installation order.** The chain runs each activated middleware in the order of the Application's `plugins` list, and the action ends the chain. Code after `await next()` unwinds in reverse order. A plugin listed earlier wraps the plugins after it and can take over before they load.
- **Activation.** `activate` is `'always'` or a list of the plugin's own option names. A listed option activates the middleware when a token or an input source supplies it, never when only its default applies. An option the plugin's `onCommandAttach` hook declares cannot activate it, so a middleware that reads one declares `'always'`, as the formatter does. [Activation](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/plugin-contract.md#activation) states the rule.
- **Lazy loading.** Core calls `load` only when the chain reaches an activated middleware. Keep the middleware in its own module and load it with `import()`, so an invocation that does not activate it never imports it. An `'always'` middleware loads on every invocation that reaches the chain.
- **Before the chain.** An unknown command is held too, but only `'always'` middleware run on it: each reads the unknown word under `unknownCommand`, its `next()` rejects with `UnknownCommandError`, and it may take the run over, as the [external commands plugin](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/plugins/external-commands.md) does. Every other input fault is held and raised at the dispatch boundary, where it rejects the innermost `next()` and travels outward through every awaiting middleware. Validators run before the chain, even on an invocation a middleware then takes over. A declared default or implied value that its validator rejects fails the run before the chain starts, so not even `--help` can take over, under [Invocation](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/invocation.md).
- **At the dispatch boundary.** Core builds the routed Command's providers after the last middleware continues, and closes them when the action settles, so code after `await next()` runs after every provided value has closed.
- **Invocation by name.** Each `invoke` call runs the chain again for the Command it names, so an `'always'` middleware also wraps every MCP tool call. What it writes there lands in that call's captured output.

## A middleware of the application's own

This plugin reports how long a dispatched Command took when the operator supplies `--timing`. The action knows nothing about it.

```ts
import { Application, plugin } from "@loomcli/core";
import type { Middleware, Plugin, PluginOptions } from "@loomcli/core";

// The option controls the run rather than feeding the Command's work.
const options = {
  timing: {
    control: true,
    description: "Report how long the command took.",
    type: "boolean",
  },
} satisfies PluginOptions;

// In the application, this is the default export of its own module.
// The plugin loads that module with import().
const middleware: Middleware<typeof timing> = async ({ next, out }) => {
  const started = Date.now();
  const outcome = await next();
  if (outcome === "dispatched") {
    await out.info(`Finished in ${Date.now() - started} ms.`);
  }
};

function timing(): Plugin<typeof options> {
  return plugin("notes/timing", {
    middleware: {
      activate: ["timing"],
      load: async () => ({ default: middleware }),
    },
    options,
  });
}

export const notes = new Application("notes", {
  description: "Keep short notes.",
  plugins: [timing()],
}).action(({ out }) => out.print("No notes yet."));
```

The factory's annotated return type is what lets the middleware module type-import the plugin without a type cycle. When `next()` rejects, the `await` throws, so the failure propagates and nothing is printed.

## Common mistakes

- **Per-command work in a middleware.** A middleware that branches on `command.path` to do one Command's job belongs in that Command's action.
- **A cross-cutting concern copied into every action.** An audit line, timing, or a state restore repeated in each action belongs in one middleware. A shared step that produces the action's data stays a function the actions call, and a shared typed value is a provider.
- **Setup in a middleware for the action.** A connection opened in a middleware cannot reach the action, and it opens even when a later middleware takes over or a held fault fails the run. A provider builds only at the dispatch boundary, and only for a Command that opts in.
- **Swallowing a failure.** A middleware that catches the rejection of `next()` to log it and then returns ends the run as a success. Rethrow after you log.
- **Calling `next()` without awaiting it.** The cleanup then runs before the chain it wraps has finished. A second call to `next()` rejects and continues nothing.
- **Writing stdout from a middleware on a result Command.** The bytes mix with the result a script reads. Write messages through `out.info` or `out.warn` on stderr, and detail through `log.debug`, which `-v` shows as a log line.
- **Expecting a default to activate.** A declared default never activates a middleware. Supply the option, or declare `'always'` and read the value.
- **Validating or normalizing input in a middleware.** A middleware cannot change what the action receives. Put the rule in the input's validator.

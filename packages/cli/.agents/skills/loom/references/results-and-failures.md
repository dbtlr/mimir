<!-- Managed by loom init. sha256:6ed3ebbc912713d8a753db3de5b7cc563b67e381b92164a597ae30ab472f8080 -->

# Results and failures

This reference covers what a Command hands its consumer: a declared result when it succeeds, and a failure class when it does not.

## Declare a result when the output is data

Declare `result<Value>()` or `rows<Row>()` when a script or an agent reads what the Command produces, such as a list, a record, or a computed value. Write through the semantic lanes (`out.info`, `out.success`, `out.warn`) when the Command reports on its work. A Command that only changes something, such as a deploy, declares no result and ends with `out.success`.

A result is one declaration that every projection reads, so declaring it is what makes the Command usable by machines:

- The [formatter](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/plugins/format.md) adds `--format` and `--fields` to every Command that declares a result, and the `json` and `jsonl` views to a record that lacks them. Under `rows()` its `jsonl` is the row view `jsonlRows()`. `--fields` selects top-level keys of the json and jsonl output the formatter appended, so a Command, a global option, or a plugin that declares its own `fields` fails the build. Rename it, under [Selecting fields](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/plugins/format.md#selecting-fields).
- The [manifest](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/plugins/manifest.md) publishes the view names and the [media type](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/results.md#media-types) of each view.
- An [MCP tool](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/plugins/mcp.md) call selects the first view whose media type is `application/json` and sends its output as structured content. With no such view, the agent receives plain text. Without the formatter installed, list `json: json()` from `@loomcli/plugins/format` yourself.
- [`invoke`](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/invocation.md#invocation-by-name) captures the rendered result as the outcome's `output`.

Keep these invariants:

- Emit the result once, through `out.results`, before the action returns. The action's return value is not the result: core ignores it. A return without the call, or a second call, fails the run with `ResultError`, exit 1, under [Emitting a result](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/results.md#emitting-a-result).
- On a Command that declares a result, stdout carries the result and nothing else. The action's `out.print` and `out.render` write to stderr, as [Stdout belongs to the result](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/results.md#stdout-belongs-to-the-result) states.
- Under `rows<Row>()`, pass any iterable or async iterable. A row view writes each row as it arrives; a whole view, `json()` included, waits for the whole sequence. Under the formatter, `--format jsonl` on a `rows()` Command writes each line as its row arrives, so a run that fails partway leaves the earlier rows on stdout. A Command whose JSON Lines output must be all or nothing declares `jsonl: jsonl()` in its `views`. Declaring it opts that view out of `--fields`, which still applies to a `json` view the formatter appends, so shape the declared view's fields yourself through its `map`.
- Write through `out`, never through `console.log` or `process.stdout`, and never call `process.exit()`. Under `invoke` and an MCP tool call the run's streams are capture sinks, so a direct write to the process misses the capture, and in the MCP server it corrupts the protocol stream.
- State the row type on a pack view factory that you hoist out of the `views` record, `table<Row>({ … })`, or its columns go unchecked.

## Fail by throwing a failure class

Reporting an error does not fail the run: `out.error` writes its message and the run goes on. To fail, throw. Core reads the exit code from the thrown failure's class, so never set `process.exitCode`. An action that returns still fails when it emitted no declared result, when a write to a destination fails, or when a provided value's close throws, and a cancelled run resolves its cancellation code, such as 130 for Ctrl-C.

Choose the base by who must act:

- **`FatalError`**: the application could not do what was asked. It exits 1 unless the subclass declares another code, and its default text is the message alone. `out.fatal(message)` throws a plain one.
- **A `UsageError` subclass**: the invocation is wrong in a way no validator could see. It exits 2, and core opens each line with the application name.
- **A validator**: a rule over one input's value belongs in `validate`, not in the action. Returned issues report as an `InputError`, exit 2, before the action runs, beside every other problem, under [Issues and validator failures](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/validation.md#issues-and-validator-failures). An action throws `InputError` itself only for a rule over a whole list of values, and builds the failure for an omitted input with `missingInputError`, under [Interaction](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/interaction.md).

Declare one class for each failure a reader must tell apart:

- `static override readonly code` is the [failure code](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/failures.md#failure-codes) a machine reader branches on. It is kebab-case. Core checks it each time an instance is constructed, not when the class is declared, and a code outside the grammar makes that construction throw a `DeclarationError` in place of the failure. The failure form, `invoke`'s outcome, a failure encoder, and an MCP tool error all carry it.
- `static override readonly exitCode` is its [declared exit code](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/failures.md#declared-exit-codes), from 1 through 125. Use the `EX_*` constants core exports. Annotate the field as `FailureExitCode` (or `code` as `string`) when a subclass of your class declares another value.
- Facts a view or a script reads are `readonly` fields on the instance, not text to parse.
- List the classes each Command can raise in the `failures` of its `manifestCommand` value, one entry `{ failure: InvalidJsonError, meaning: "The document is not valid JSON." }` for each, with a one-line meaning, under [Manifest failures](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/plugins/manifest.md#manifest-failures), so an agent reads what each code means before it runs the Command.

A `FatalError`'s message is marked text that core does not escape. Pass each raw value you interpolate, such as a path the operator supplied, through `escapeControlCharacters`, which `@loomcli/core` exports, so no control character or bidirectional control reaches the terminal, as rule 5 of [Failure message voice](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/failures.md#failure-message-voice) requires. Then escape markup once: with `style.escape` on the value, or with a `FatalError` view override that escapes the whole message, as [Failure views](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/failure-views.md#failure-views) shows. Do one of the two, not both, because markup escaped twice no longer displays as written.

```ts
import { Application, Command, EX_DATAERR } from "@loomcli/core";
import { FatalError, translate } from "@loomcli/core";
import { format } from "@loomcli/plugins/format";
import { table } from "@loomcli/plugins/table";

interface Entry {
  key: string;
  kind: string;
}

export class InvalidJsonError extends FatalError {
  static override readonly code = "invalid-json";
  static override readonly exitCode = EX_DATAERR;

  constructor(options?: ErrorOptions) {
    super("The document is not valid JSON. Correct its syntax.", options);
    this.name = "InvalidJsonError";
  }
}

// JSON.parse throws a SyntaxError for a malformed document.
function invalidJson(error: SyntaxError): InvalidJsonError {
  return new InvalidJsonError({ cause: error });
}

function entriesOf(document: unknown): Entry[] {
  if (typeof document !== "object" || document === null) {
    return [];
  }
  return Object.entries(document).map(([key, value]) => ({
    key,
    kind: typeof value,
  }));
}

export const keys = new Command("keys", {
  description: "List the top-level keys of a JSON document.",
})
  .argument("document", { description: "The JSON text.", required: true })
  .rows<Entry>({ views: { table: table({ columns: ["key", "kind"] }) } })
  .action(async ({ args, out }) => {
    // A malformed document throws here, and the translator answers it.
    const document: unknown = JSON.parse(args.document);
    await out.info("Read the document.");
    await out.results(entriesOf(document));
  });

// format() adds --format json and jsonl.
// When one is selected, it writes a failed run as JSON too.
export const app = new Application("doc", {
  plugins: [format()],
  translators: [translate(SyntaxError, invalidJson)],
}).command(keys);
```

## Translate a foreign throw, and let a defect stay a defect

A [translator](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/failures.md#translators) turns an error a library or the platform throws into one of your failure classes, so no action repeats the catch. Register it under the Application's `translators`; a plugin that wraps a client ships its own.

- The translator receives the instance typed from its key class and returns a failure, or `undefined` to pass the throw on. Pass `{ cause: error }` to keep the original; core never sets `cause` for you.
- Node's system errors are all `Error` instances told apart by `code`, so key the translation on `Error` and narrow inside it, such as `"code" in error && error.code === "ENOENT"`. The parameter is typed `Error`, which has no `code`, so `error.code` alone does not compile; narrow it, never assert it with `as`.
- The Application's list is consulted before every plugin's, and at each one the whole prototype chain is walked before the next, so your translation keyed on `Error` answers before a plugin's keyed on `SyntaxError`.
- A translator sees the error alone. When the sentence must name something only the call site knows, such as which of several files failed, catch at the call site and throw your class there.
- A throw from an action, a middleware, an input source, a row source, or a write the action awaits reaches the translators. A failure class, a cancellation, and a throw from one of Loom's contracts, such as a validator or a translator, never do.

Every throw no translator answers is a [defect](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/glossary.md#failures): an `InternalError` that exits 1. A development build, such as a source run or a run on a default `mockProcess()`, shows the author its Developer Diagnostic. A distributed build shows the operator `<application>: Something went wrong.` with no reason, under [Development builds](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/release-facts.md#development-builds). Do not wrap every throw in a `FatalError` that quotes `error.message`: the defect then reads as something the operator can fix, prints the engine's text, and loses its diagnostic. Translate only what the operator can act on.

The same holds for the rest of your code. A validator that throws, instead of returning issues, is a `DeclarationError`. A view, a translator, or a hook that throws is a defect. When your code catches a failure and goes on, the outcome is what your code produces, under [The ordinary failure path](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/failures.md#the-ordinary-failure-path), except that a failed destination write still fails the run.

## Restyle a failure with a failure view

`override(FailureClass, view)` under the Application's `views` replaces how a class renders, typed from its instances. The [failure views](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/failure-views.md#failure-views) page states the resolution; these are the points an author gets wrong:

- An override for a base class covers every subclass at once, and the Application's overrides win over every plugin's. So `override(UsageError, …)` restyles every exit-2 failure core raises, and it also replaces the [suggestions](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/plugins/suggestions.md) plugin's views for an unknown command and an unknown option, which then lose their `Did you mean` sentence. It does not reach a class of your own that declares exit code 2 without extending `UsageError`.
- The view owns its trailing newline, and it prints `context.hints` itself. An override that ignores them drops the lines plugins add, such as a pointer to `--help`.
- Read `context.invokedBy` before pointing at a command line: under `invoke` and an MCP tool call there is none.
- Print `context.message`, the failure's sentence in the run's language, rather than `failure.message`, which stays English. Under [`localization()`](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/plugins/localization.md), core renders Loom's own sentences in the operator's language, while the failure form, codes, JSON, and the log record stay English. Your own sentences print as written unless you register a message module and say them through phrases, under [Localization](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/localization.md#phrases).
- A view cannot change the exit code, which is a fact of the class.
- A defect never reaches an override in a development build. In a distributed build, `override(InternalError, …)` replaces the generic message for a defect. A declaration fault that reaches a run is a `DeclarationError`, which does not extend `InternalError`, so replace its message with `override(DeclarationError, …)`.
- Under `run()`, when the selected view declares a media type that a [failure encoder](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/failure-views.md#failure-encoders) answers, such as the formatter's `application/json`, the encoder writes the failure form on stderr and no view renders. A script that asked for `--format json` reads JSON on failure too.

## Write the message in the failure voice

Every operator message says what went wrong and what to do instead. [Failure message voice](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/failures.md#failure-message-voice) states the rules Loom's own messages follow; Loom cannot check yours, so apply them yourself:

- Name the specific thing in the first part, such as the path, the file, or the key, and give an action or the accepted form in the second: `Path not found: "user.nme". Run doc keys to list the keys at the root.`
- Repeat an input's value only when you know it is not a secret, and pass what you repeat through `escapeControlCharacters`.
- Quote no text you did not write, such as a cause's message, an engine reason, or a stack. It can leak a path or a value, it changes between runtimes, and it gives the operator no step to take.
- Give a defect no operator message of your own. The operator cannot fix it, so let core report it.

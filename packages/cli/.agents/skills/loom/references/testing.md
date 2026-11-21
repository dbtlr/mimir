<!-- Managed by loom init. sha256:aa48ac67dda6cbe0374badd314bfdda7548592d436b5d4f4500ab893f079f945 -->

# Testing

This reference covers how to test a Loom application: the assembly check, a committed copy of its skills, a whole run in the test's own process, one function with a built context, and the few cases that need a child process.

The examples import from `bun:test`, the runner a default `loom init` sets up. A package made with `--test-runner vitest` imports `expect` and `test` from `vitest` instead, and uses `vi.fn` where an example uses `mock`.

## Keep the assembly check

`loom init` writes `src/application.test.ts`, which passes the Application to `assertAssembles` from `@loomcli/testing`. Keep it. It runs `Application.check()`: every build rule, the input-schema converter check, and every plugin's `onGraphBuilt` hook, such as the MCP plugin's tool-name check. A fault there fails CI with its Developer Diagnostic instead of failing an operator's run.

- Import the Application from the application module. Never import the entry, `src/main.ts`, because importing it runs the application.
- The check does not run a declared default or an implied value through its validator, under [What it covers](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/libs/testing.md#what-it-covers). A whole run of each Command does, so write at least one.

## Check a committed copy of the skills

A package that commits the files `loom skills export` writes keeps a test that calls `assertSkillsMatch` from `@loomcli/testing`, under [assertSkillsMatch](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/libs/testing.md#assertskillsmatch): `await assertSkillsMatch(application, 'committed-skills', { moduleDirectory: import.meta.dirname })`. It reads the skills the application declares, generated command references included, as an install does, and throws for the first file whose bytes or executable bit differ from the copy, or that the copy lacks or holds in excess.

- **Refresh, then commit.** When it fails, run `loom skills export` with the same directory and commit the result. Never edit the copy by hand.
- **Paths.** The copy's directory resolves against the test's working directory. Pass `moduleDirectory` as the application module's directory when the skills plugin's `folder` setting is relative.
- **Install `@loomcli/plugins`.** The assertion loads it, at the same version as `@loomcli/testing`, only when it runs.
- **Some skills.** `skills: ['notes']` checks only the skills it names, as `loom skills export --skill` exports them.

## Run the whole application in the test's process

Most tests run the Application through its own `run()` on a mock process handle: `await app.run({ process: mockProcess(fields) })`. The run parses, validates, applies defaults, translates, renders, and resolves the exit code exactly as it does for an operator, and it reads no process fact from the machine. Read `mock.stdout.text`, `mock.stderr.text`, and the resolved code. [mockProcess](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/libs/testing.md#mockprocess) states every field.

- **Sealed defaults.** A field the test omits holds a fixed value, not the machine's: `argv` is `[]`, `env` is `{}`, `cwd` is `/loom-test`, which does not exist, `platform` is `linux`, `runtime` is Node.js 24.0.0 whichever runtime runs the test, stdin is empty, no stream is a terminal, and no child program can start. `release` is `{ build: 'source' }`, a development build, so a defect writes its Developer Diagnostic; state `release: { build: 'distributed' }` to see what an operator sees.
- **A supplied field replaces its default whole.** `env: { HOME: home }` is the run's entire environment.
- **Files.** Give `cwd` as an absolute path to a fixture folder, or to a folder the test makes with `mkdtempSync` and removes after. The default home and temporary folders do not exist, so a run that writes there fails. With the configuration plugin installed, its project lookup in a mock run looks only in `cwd`, because the mock's `ceiling` is its `cwd`, so a configuration file above the folder never answers, whatever the mock's home is. A start directory that the plugin's directory option names outside the ceiling, being neither the ceiling, inside it, nor an ancestor of it, is looked in alone: the walk reads no ancestor of it, and a start that is an ancestor of the ceiling looks nowhere. Write the test's configuration file into `cwd`. When the file sits in a parent of `cwd`, pass `ceiling` as that parent or a directory above it, kept inside the test's temporary folder. Pass `--no-config` in `argv` only for a run that should read no file. [The configuration plugin](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/plugins/config.md) states the lookup.
- **Child programs.** `programs` scripts each child program by the exact command the run names, with no `PATH` lookup, so `git` and `/usr/bin/git` are two scripts. A command with no script throws from `host.spawn`, which fails the run. Assert the arguments the script received.
- **The terminal.** `terminal: { columns, rows }` puts the output streams on a terminal of that size, and `terminal.keys` answers questions, under [Answering questions](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/libs/testing.md#answering-questions).
- **What stays real.** Clocks, timers, randomness, the network, and the file system. Mask a timestamp or an elapsed time before comparing.
- **One mock per run.** A mock records every run given it, so a second run on it reads both runs' writes.
- **Typed calls.** `app.invoke(path, values, { process: mock })` runs one Command by name on the mock's facts and returns its outcome: `output` and `messages` as text, and for a failure its `exitCode` and failure `form`. It writes nothing to the mock's streams. A literal path types its values from the Command, so an option a plugin's hook adds, such as `format` or `fields`, does not compile. Select a view with the call's `view`, `app.invoke(['list'], {}, { view: 'json' })`.

```ts
/// <reference types="bun" />
import { expect, test } from "bun:test";
import { Application, FatalError } from "@loomcli/core";
import { mockProcess } from "@loomcli/testing";

const sentence = "The folder is not a git repository. Run revision inside one.";

class NotARepositoryError extends FatalError {
  static override readonly code = "not-a-repository";

  constructor() {
    super(sentence);
    this.name = "NotARepositoryError";
  }
}

// A real test imports the Application from the application module instead.
const revision = new Application("revision").action(async (context) => {
  const { host, out, signal } = context;
  const git = host.spawn("git", ["rev-parse", "HEAD"], { signal });
  const exit = await git.exited;
  if (exit.kind !== "exited" || exit.code !== 0) {
    throw new NotARepositoryError();
  }
  await out.print(exit.stdout.text.trim());
});

test("revision prints the commit git reports, with no git run", async () => {
  const calls: (readonly string[])[] = [];
  const mock = mockProcess({
    programs: {
      git: ({ args }) => {
        calls.push(args);
        return { stdout: "3f2a9c1\n" };
      },
    },
  });
  await expect(revision.run({ process: mock })).resolves.toBe(0);
  expect(calls).toEqual([["rev-parse", "HEAD"]]);
  expect(mock.stdout.text).toBe("3f2a9c1\n");
  expect(mock.stderr.text).toBe("");
});

test("outside a repository, revision fails with its own code", async () => {
  const mock = mockProcess({ programs: { git: () => ({ code: 128 }) } });
  await expect(revision.run({ process: mock })).resolves.toBe(1);
  expect(mock.stderr.text).toBe(`${sentence}\n`);

  const outside = mockProcess({ programs: { git: () => ({ code: 128 }) } });
  const outcome = await revision.invoke([], {}, { process: outside });
  const code = outcome.status === "failed" ? outcome.form.code : undefined;
  expect(code).toBe("not-a-repository");
});
```

## Assert what the application promises

- **Exact bytes where the operator reads them.** Compare stdout and your own failure sentences whole, and compare the exit code. For a failure a script or an agent branches on, assert its failure code from `invoke`'s outcome rather than parsing the text.
- **State every fact the behavior reads, and write the expected value literally.** Never derive an expected value from the real `process.platform`, `process.env`, `os.homedir()`, or the machine's time zone. The run reads the mock, not the machine, so such an expectation agrees with the run only by accident. To test the macOS branch, pass `platform: 'darwin'` and expect the macOS answer.
- **Do not pass `env: process.env`** unless the test is about the machine's environment. It makes the result depend on the machine, and on CI, `CI=true` turns interaction off.
- **Your behavior, not Loom's.** Assert that a declaration reaches the operator: the option binds, the default applies, the result renders through your view, the failure exits with your code. Loom tests its own layouts and catalog sentences.
- **The final effect of a live region,** not each frame. A question or a progress line redraws on stderr, so assert the answer's effect, the exit code, and the final text. With `env: { ACCESSIBLE: '1' }`, or `--plain` in `argv` under the [plain plugin](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/plugins/plain.md), nothing redraws: a progress line writes its start line and, unless it is cleared, its end line, and a line with a log that fails, warns, or is cancelled also writes its kept log lines above its end line (a cancelled line writes them alone), under [A line's log](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/libs/prompts.md#a-lines-log), and a question prints each piece once, so `mock.stderr.text` holds plain lines you may compare whole. The question echoes what it reads, the secret's keys excepted, so the stderr holds each answer after its asking row, as a terminal shows it.

## Test one function with a built context

When an action, a middleware, a hook, or a view holds logic worth testing alone, call it with the context its builder makes, under [Testing one function alone](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/libs/testing.md#testing-one-function-alone): `actionContext`, `middlewareContext`, `failureHookContext`, `providerContext`, `viewContext`, or `environmentContext`. No Application runs.

- **Extract the action.** `actionContext` takes an extracted handler, typed `ActionHandler<typeof command>`. An inline `.action()` handler has no public way to reach it. [Structure](structure.md) shows where the extracted handler lives.
- **State the inputs whole.** State `args`, `options`, and `provided` exactly as the handler reads them. `options` includes every registered global option, and `provided` is `{}` for a Command with no provider. No default, validator, or input source runs.
- **Know what an unstated member does.** The semantic lanes, `out.render`, and `out.results` resolve and keep nothing, so state `out: { results }` with your own function to read the result. `next`, `invoke`, `out.text`, and a view's measures throw or reject with a sentence that asks you to state them, and so does a read of `host`, `graph`, `command`, or another fact you did not state. An unstated `style` returns its text unchanged. Under `bun test`, `spyOn` installs nothing on that style, so assign your own `mock` to the style name the function calls, as [Testing one function alone](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/libs/testing.md#testing-one-function-alone) shows. A stated `out` lane or `log` level receives `string | Phrase`. Annotate `(message: string)` only when the code under test passes only strings.
- **A linked `select` or `multiselect` needs the real graph.** It passes its answer through the input's own validator, which core finds through the graph, so state `graph: application.inspect()` and `command` as that graph's node for the Command, or run the whole application with `terminal.keys`. Without them the question throws rather than answer an unvalidated value, under [Validation](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/core/validation.md#validation-context).
- **No core machinery runs.** A thrown error reaches the test as the function threw it: no translator answers it and no failure view renders it. Test translation, failure text, and exit codes through a whole run.
- **Functions with no builder.** A failure view and a configuration source have no builder, so test them through a whole run. An `onLog` hook and a progress observer have no context builder either: call them with values that `logEvent`, `logDestination`, and `progressEvent` build, under [Building the values a hook reads](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/libs/testing.md#building-the-values-a-hook-reads). Test an `onCommandAttach` or `onGraphBuilt` hook by installing its plugin on a small Application and reading `inspect()`, or with `assertAssembles`. A later `run()`, `invoke`, or `inspect()` on one Application reuses its built graph and runs neither hook again. A test that counts hook calls builds a new Application or calls `check()`.

```ts
/// <reference types="bun" />
import { expect, mock, test } from "bun:test";
import { Command } from "@loomcli/core";
import type { ActionHandler } from "@loomcli/core";
import { table } from "@loomcli/plugins/table";
import { actionContext } from "@loomcli/testing";

interface Entry {
  key: string;
  kind: string;
}

type Rows = Iterable<Entry> | AsyncIterable<Entry>;

function entriesOf(document: unknown): Entry[] {
  if (typeof document !== "object" || document === null) {
    return [];
  }
  return Object.entries(document).map(([key, value]) => ({
    key,
    kind: typeof value,
  }));
}

// In an application, the handler sits in a module of its own.
// That module type-imports the Command.
const listKeys: ActionHandler<typeof keys> = async ({ args, out }) => {
  const document: unknown = JSON.parse(args.document);
  await out.results(entriesOf(document));
};

export const keys = new Command("keys")
  .argument("document", { required: true })
  .rows<Entry>({ views: { table: table({ columns: ["key", "kind"] }) } })
  .action(listKeys);

test("keys emits one row for each top-level key", async () => {
  const results = mock(async (_rows: Rows) => {});
  const context = actionContext(listKeys, {
    args: { document: '{"a":1}' },
    options: {},
    out: { results },
    provided: {},
  });
  await listKeys(context);
  expect(results).toHaveBeenCalledWith([{ key: "a", kind: "number" }]);
});

test("a malformed document rejects with the raw SyntaxError", async () => {
  const context = actionContext(listKeys, {
    args: { document: "{" },
    options: {},
    provided: {},
  });
  const call = Promise.resolve().then(() => listKeys(context));
  await expect(call).rejects.toThrow(SyntaxError);
});
```

## Start a child process only when the behavior needs one

A [process test](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/glossary.md#toolchain) starts the application as a child process. Write one only for behavior that only a process has: a signal delivered by the operating system and the exit status the shell sees, a pseudo-terminal, a real shell, the framing of real stdio, or what the built bundle loads in a fresh process. Everything else runs on a mock.

A signal does not need a process. `mock.signals.raise('SIGINT')` reaches the runs listening on that mock alone, and such a run resolves 130. Call `run()` without awaiting it, then raise: a raise before any run listens ends the mock instead. A top-level `invoke` never listens on the mock's signals, so pass it an `AbortController`'s signal in its `signal` option, and abort the controller to cancel it. Ctrl-C in `terminal.keys` raises SIGINT at a question. [Cancelling at a named point](https://github.com/dbtlr/loomcli/blob/v0.20.0/docs/libs/testing.md#cancelling-at-a-named-point) shows where to raise it.

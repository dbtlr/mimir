/**
 * What an agent did during a skill-eval run, read from its harness's JSON
 * event stream: the shell commands it ran, the skills it loaded, and its final
 * reply. Claude (`--output-format stream-json`) and Codex (`exec --json`)
 * each normalize to the same {@link Transcript}.
 */

export type Transcript = { commands: string[]; skills: string[]; finalText: string };

/** One `mimir` call found in a shell command. `help` marks a `-h`/`--help` lookup,
 * which reads usage and acts on nothing. */
export type MimirCall = { verb: string; sub?: string; help: boolean; command: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function events(stream: string): Record<string, unknown>[] {
  const parsed: Record<string, unknown>[] = [];
  for (const line of stream.split('\n')) {
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) {
        parsed.push(value);
      }
    } catch {
      // Harnesses interleave non-JSON diagnostics; they carry no actions.
    }
  }
  return parsed;
}

const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function parseClaudeStream(stream: string): Transcript {
  const transcript: Transcript = { commands: [], finalText: '', skills: [] };
  for (const event of events(stream)) {
    if (event.type === 'result') {
      transcript.finalText = text(event.result);
    }
    if (event.type !== 'assistant') {
      continue;
    }
    const content = record(event.message).content;
    for (const block of Array.isArray(content) ? content : []) {
      const { input, name, type } = record(block);
      if (type !== 'tool_use') {
        continue;
      }
      if (name === 'Bash') {
        transcript.commands.push(text(record(input).command));
      } else if (name === 'Skill') {
        transcript.skills.push(text(record(input).skill));
      }
    }
  }
  return transcript;
}

export function parseCodexStream(stream: string): Transcript {
  const transcript: Transcript = { commands: [], finalText: '', skills: [] };
  for (const event of events(stream)) {
    if (event.type !== 'item.completed') {
      continue;
    }
    const item = record(event.item);
    if (item.type === 'command_execution') {
      transcript.commands.push(text(item.command));
    } else if (item.type === 'agent_message') {
      transcript.finalText = text(item.text);
    }
  }
  return transcript;
}

/**
 * Every `mimir` call at command position: line start, after a control operator
 * or `$(`, or just inside a quoted `sh -c` body. `echo mimir` is not a call.
 * A call's words stay on its own line; a substitution nested in it is its own call.
 */
const CALL =
  /(?:^|&&|\|\||[;|\n(]|\$\(|-[a-z]*c[ \t]+['"])[ \t]*(?:\S*\/)?mimir[ \t]+([a-z][a-z-]*)(?:[ \t]+([^\s'"&|;)]+))?((?:[^\n;&|$)]|\$(?!\())*)/g;
const HELP = /(?:^|\s)(?:-h|--help)(?:$|[\s'"])/;

/**
 * Calls through a relative path (`./mimir`, `bin/mimir`). The runner cannot
 * tell which binary those reached, so any one is an escape.
 */
export function relativeCalls(commands: readonly string[]): string[] {
  return commands.filter((command) =>
    /(?:^|&&|\|\||[;|\n(]|\$\(|-[a-z]*c[ \t]+['"])[ \t]*(?!\/|~)\S*\/mimir[ \t]/.test(command),
  );
}

export function mimirCalls(commands: readonly string[]): MimirCall[] {
  const calls: MimirCall[] = [];
  for (const command of commands) {
    for (const match of command.matchAll(CALL)) {
      calls.push({
        command,
        help: HELP.test(` ${match[2] ?? ''}${match[3] ?? ''}`),
        sub: match[2],
        verb: match[1] ?? '',
      });
    }
  }
  return calls;
}

/**
 * Every place a command could find a `mimir` other than through the agent's
 * PATH: absolute or home-relative paths naming a file called `mimir`, and
 * `mimir` inside each directory a `PATH=` assignment adds. The runner treats
 * any that resolves to an executable other than the sandbox's as an escape.
 */
export function binaryPaths(commands: readonly string[]): string[] {
  const paths = new Set<string>();
  for (const command of commands) {
    for (const match of command.matchAll(/\bPATH=["']?([^\s"';|&]+)/g)) {
      for (const dir of (match[1] ?? '').split(':')) {
        if (dir.startsWith('/') || dir.startsWith('~')) {
          paths.add(`${dir.replace(/\/$/, '')}/mimir`);
        }
      }
    }
    for (const match of command.matchAll(
      /(?:^|[\s'"(=`])((?:~|\/)[^\s'"`;|&()]*\/mimir)(?=$|[\s'"`;|&)])/g,
    )) {
      paths.add(match[1] ?? '');
    }
  }
  return [...paths];
}

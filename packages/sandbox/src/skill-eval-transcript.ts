/**
 * What an agent did during a skill-eval run, read from its harness's JSON
 * event stream: the shell commands it ran, the skills it loaded, and its final
 * reply. Claude (`--output-format stream-json`) and Codex (`exec --json`)
 * each normalize to the same {@link Transcript}.
 */

export type Transcript = { commands: string[]; skills: string[]; finalText: string };

/** One `mimir` call found in a shell command. `escaped` marks a binary other than the sandbox's. */
export type MimirCall = { verb: string; sub?: string; escaped: boolean; command: string };

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
 */
const CALL =
  /(?:^|&&|\|\||[;|\n]|\$\(|-[a-z]*c\s+['"])\s*(\S*\/)?mimir\s+([a-z][a-z-]*)(?:\s+([^\s'"&|;)]+))?/g;

export function mimirCalls(commands: readonly string[], sandboxBinary?: string): MimirCall[] {
  const calls: MimirCall[] = [];
  for (const command of commands) {
    for (const match of command.matchAll(CALL)) {
      const directory = match[1];
      calls.push({
        command,
        escaped: directory !== undefined && `${directory}mimir` !== sandboxBinary,
        sub: match[3],
        verb: match[2] ?? '',
      });
    }
  }
  return calls;
}

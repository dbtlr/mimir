/**
 * Test support for the skill drift guard: reads every `mimir …` invocation the
 * agent skill shows (fenced `sh` blocks and inline code spans) and checks it
 * against the CLI's own surface. Not bundled in production output.
 */

import type { Store } from '../core';
import { COMMAND_HELP } from './help';
import { runCli } from './run';
import { fakeIo } from './testing';

/** One `mimir` invocation found in a skill file; `words` excludes `mimir`. */
export type SkillInvocation = { file: string; text: string; words: string[] };

type Token = { kind: 'word'; text: string; quoted: boolean; subs: string[] } | { kind: 'op' };

/** The index of the `)` that closes the `(` at `open` (the line's end when unbalanced). */
function closingParen(line: string, open: number): number {
  let depth = 0;
  for (let j = open; j < line.length; j += 1) {
    if (line[j] === '(') {
      depth += 1;
    } else if (line[j] === ')') {
      depth -= 1;
      if (depth === 0) {
        return j;
      }
    }
  }
  return line.length;
}

/** Split one shell line into words and control operators, honoring quotes and `$(…)`. */
function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let text = '';
  let quoted = false;
  let started = false;
  let subs: string[] = [];
  const flush = (): void => {
    if (started) {
      tokens.push({ kind: 'word', quoted, subs, text });
    }
    text = '';
    quoted = false;
    started = false;
    subs = [];
  };
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] ?? '';
    if (ch === '$' && line[i + 1] === '(') {
      const j = closingParen(line, i + 1);
      subs.push(line.slice(i + 2, j));
      text += line.slice(i, j + 1);
      started = true;
      i = j;
    } else if (ch === '"' || ch === "'") {
      const end = line.indexOf(ch, i + 1);
      const close = end === -1 ? line.length : end;
      const inner = line.slice(i + 1, close);
      if (ch === '"') {
        for (const m of inner.matchAll(/\$\(([^)]*)\)/g)) {
          subs.push(m[1] ?? '');
        }
      }
      text += inner;
      quoted = true;
      started = true;
      i = close;
    } else if (/\s/.test(ch)) {
      flush();
    } else if (ch === '#' && !started) {
      break;
    } else if ((ch === '|' || ch === ';' || ch === '&') && !started) {
      flush();
      tokens.push({ kind: 'op' });
      while (line[i + 1] === '|' || line[i + 1] === '&') {
        i += 1;
      }
    } else {
      text += ch;
      started = true;
    }
  }
  flush();
  return tokens;
}

/** Strip doc-only optional syntax (`[--flag x]...`, `[--desc "…"]`) from a word. */
function cleanWord(word: string): string {
  return word.replace(/^\[/, '').replace(/(\]|\.\.\.)+$/, '');
}

function fromShell(file: string, line: string): SkillInvocation[] {
  const tokens = tokenize(line);
  const found: SkillInvocation[] = [];
  for (const token of tokens) {
    if (token.kind === 'word') {
      for (const sub of token.subs) {
        found.push(...fromShell(file, sub));
      }
    }
  }
  for (let i = 0; i < tokens.length; i += 1) {
    const start = tokens[i];
    if (start?.kind !== 'word' || start.quoted || start.text !== 'mimir') {
      continue;
    }
    const words: string[] = [];
    for (let j = i + 1; j < tokens.length; j += 1) {
      const token = tokens[j];
      if (token === undefined) {
        break;
      }
      if (token.kind === 'op') {
        // `--top | --bottom` in a synopsis lists alternatives, not a pipe.
        const next = tokens[j + 1];
        if (next?.kind === 'word' && next.text.startsWith('-')) {
          continue;
        }
        break;
      }
      const word = cleanWord(token.text);
      // An empty quoted value (`--direction ""`) is still an argument.
      if (word !== '' || token.quoted) {
        words.push(word);
      }
    }
    found.push({ file, text: words.join(' '), words });
  }
  return found;
}

/** Fence languages whose lines are shell; an untagged fence counts, a `toml` or `json` one does not. */
const SHELL_FENCES = new Set(['', 'sh', 'bash', 'shell', 'zsh', 'console']);

/** A line's command text: a `$ ` prompt marker removed. */
const command = (line: string): string => line.replace(/^\s*\$\s+/, '');

/** Every `mimir` invocation in a markdown document, in document order. */
export function extractInvocations(file: string, markdown: string): SkillInvocation[] {
  const found: SkillInvocation[] = [];
  // The open fence's marker (three or more backticks or tildes); empty outside a fence.
  let fence = '';
  let shellFence = false;
  let pending = '';
  let heredoc: string | undefined;
  for (const line of markdown.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})\s*([\w-]*)\s*$/.exec(line);
    // A fence closes only on a bare marker of its own character, at least as long.
    const closes =
      fence !== '' &&
      marker !== null &&
      marker[2] === '' &&
      marker[1]?.[0] === fence[0] &&
      (marker[1]?.length ?? 0) >= fence.length;
    if (marker !== null && (fence === '' || closes)) {
      // A continuation left dangling at the fence ends with it.
      if (pending !== '') {
        found.push(...fromShell(file, command(pending)));
      }
      shellFence = fence === '' && SHELL_FENCES.has(marker[2] ?? '');
      fence = fence === '' ? (marker[1] ?? '') : '';
      pending = '';
      heredoc = undefined;
      continue;
    }
    if (fence !== '') {
      if (!shellFence) {
        continue;
      }
      // A heredoc body is data, not commands.
      if (heredoc !== undefined) {
        heredoc = line.trim() === heredoc ? undefined : heredoc;
        continue;
      }
      heredoc = /<<-?\s*['"]?(\w+)['"]?/.exec(line)?.[1];
      if (line.trimEnd().endsWith('\\')) {
        pending += `${line.trimEnd().slice(0, -1)} `;
        continue;
      }
      found.push(...fromShell(file, command(pending + line)));
      pending = '';
      continue;
    }
    for (const span of line.matchAll(/(`+)([^`]+?)\1/g)) {
      const code = command(span[2] ?? '').trim();
      if (code === 'mimir' || code.startsWith('mimir ')) {
        found.push(...fromShell(file, code));
      }
    }
  }
  return found;
}

/** Flags `mimir` takes with no verb. */
const ROOT_FLAGS = new Set(['-h', '--help', '-v', '--version']);
/** Flags every verb accepts: the output format and help. */
const UNIVERSAL_FLAGS = ['-f', '--format', '-h', '--help', '--ascii'];
/** What a help row's `--on created_at:<date>` stands for: every date operator. */
const DATE_FLAGS = ['--on', '--before', '--after', '--at-or-before', '--at-or-after', '--tz'];
/** What a help row's `--is / --eq / …` stands for: the full selection grammar, dates included. */
const SELECTION_FLAGS = [
  '--is',
  '--not-is',
  '--eq',
  '--not-eq',
  '--in',
  '--not-in',
  '--has',
  '--missing',
  ...DATE_FLAGS,
];
/**
 * Verbs checked statically only: most need host wiring the bare runner lacks
 * (they refuse as "unavailable"), `version` is answered before the runner, and
 * `skill install` would really write into $HOME — a side effect, not a parse.
 */
const STATIC_ONLY_VERBS = new Set([
  'setup',
  'service',
  'store',
  'doctor',
  'self-update',
  'skill',
  'serve',
  'mcp',
  'version',
]);

const isPlaceholder = (word: string): boolean =>
  (word.startsWith('<') && word.endsWith('>')) || word.startsWith('$') || word === '…';
const isFlag = (word: string): boolean => word.startsWith('-') && word !== '-' && word !== '--';

/** The flag spellings a help descriptor declares, with grammar shorthands expanded. */
function declaredFlags(key: string): Set<string> {
  const declared = new Set(UNIVERSAL_FLAGS);
  for (const [spelling] of COMMAND_HELP[key]?.flags ?? []) {
    for (const m of spelling.matchAll(/(?:^|[\s/|,])(--?[a-z][a-z-]*)/g)) {
      declared.add(m[1] ?? '');
    }
  }
  const extra = [
    ...(declared.has('--is') ? SELECTION_FLAGS : []),
    ...(declared.has('--on') ? DATE_FLAGS : []),
  ];
  for (const flag of extra) {
    declared.add(flag);
  }
  return declared;
}

/**
 * A verb's subcommands: its space-keyed descriptors (`scratch create`), or the
 * literal first words of its usage alternatives (`store upgrade | export …`).
 */
function subcommands(key: string): string[] {
  const keyed = Object.keys(COMMAND_HELP)
    .filter((k) => k.startsWith(`${key} `) && !k.slice(key.length + 1).includes(' '))
    .map((k) => k.slice(key.length + 1));
  if (keyed.length > 0 || key.includes(' ')) {
    return keyed;
  }
  const synopsis = COMMAND_HELP[key]?.usage.slice(`mimir ${key}`.length).trim() ?? '';
  return synopsis
    .split(' | ')
    .map((alternative) => alternative.split(' ')[0] ?? '')
    .filter((word) => /^[a-z][a-z-]*$/.test(word));
}

type Resolved = { key: string; problem?: string; placeholder?: boolean };

/** The deepest help key the leading words name (`scratch agenda add`, `create task`, `list`). */
function resolveKey(words: string[]): Resolved {
  let key = words[0] ?? '';
  for (const word of words.slice(1, 3)) {
    const subs = subcommands(key);
    if (subs.length === 0 || isFlag(word)) {
      break;
    }
    if (isPlaceholder(word)) {
      return { key, placeholder: true };
    }
    if (!subs.includes(word)) {
      return { key, problem: `unknown subcommand '${word}' of mimir ${key}` };
    }
    key = `${key} ${word}`;
  }
  return { key };
}

/** The flags a key declares; under a placeholder subcommand, any of its subcommands' flags. */
function flagsFor(resolved: Resolved): Set<string> {
  const declared = declaredFlags(resolved.key);
  if (resolved.placeholder === true) {
    for (const key of Object.keys(COMMAND_HELP).filter((k) => k.startsWith(`${resolved.key} `))) {
      for (const flag of declaredFlags(key)) {
        declared.add(flag);
      }
    }
  }
  return declared;
}

/**
 * The argv the parser sees: a placeholder positional becomes a well-formed id,
 * and a flag whose value is a placeholder is dropped (it was checked statically).
 */
function parserArgv(words: string[]): string[] {
  const argv: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] ?? '';
    const next = words[i + 1];
    if (isFlag(word) && next !== undefined && isPlaceholder(next)) {
      i += 1;
    } else {
      argv.push(isPlaceholder(word) ? 'KEY-1' : word);
    }
  }
  return argv;
}

const STORE_REACHED = new Error('store reached');

const getStore = (): Store => {
  throw STORE_REACHED;
};

/**
 * Run the real parser inside a bound repo (the skill's setting); a usage
 * refusal (exit 2) before the store opens is drift.
 */
async function parserRefusal(words: string[]): Promise<string | undefined> {
  const io = fakeIo();
  try {
    const code = await runCli(parserArgv(words), getStore, io, { scope: 'KEY' });
    return code === 2 ? io.err.join(' ') : undefined;
  } catch (error) {
    if (error === STORE_REACHED) {
      return undefined;
    }
    throw error;
  }
}

/** Why the CLI would not accept this invocation as the skill shows it; empty when it would. */
export async function invocationProblems(inv: SkillInvocation): Promise<string[]> {
  const verb = inv.words[0];
  if (verb === undefined || isPlaceholder(verb)) {
    return [];
  }
  if (isFlag(verb)) {
    return ROOT_FLAGS.has(verb) ? [] : [`'${verb}' is not a top-level flag`];
  }
  if (!(verb in COMMAND_HELP) || verb.includes(' ')) {
    return [`unknown command '${verb}'`];
  }
  const resolved = resolveKey(inv.words);
  if (resolved.problem !== undefined) {
    return [resolved.problem];
  }
  const problems: string[] = [];
  const declared = flagsFor(resolved);
  const terminator = inv.words.indexOf('--');
  const options = terminator === -1 ? inv.words : inv.words.slice(0, terminator);
  for (const flag of options.filter(isFlag)) {
    if (!declared.has(flag)) {
      problems.push(`'${flag}' is not a flag of mimir ${resolved.key}`);
    }
  }
  // A bare verb in prose (`one \`mimir get\` away`) names the command, not a full call.
  // Under a placeholder subcommand the parser has no real command to run.
  const runnable = inv.words.length > 1 && resolved.placeholder !== true;
  if (problems.length === 0 && runnable && !STATIC_ONLY_VERBS.has(verb)) {
    const refusal = await parserRefusal(inv.words);
    if (refusal !== undefined) {
      problems.push(`the CLI refuses it: ${refusal}`);
    }
  }
  return problems;
}

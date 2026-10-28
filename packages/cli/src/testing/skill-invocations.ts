/**
 * Test support for the skill drift guard: reads every `mimir …` invocation the
 * agent skill shows (fenced `sh` blocks and inline code spans) and checks it
 * against the Loom CLI's own surface, the command graph the Application
 * declares, then runs the real parser over it. Not bundled in production output.
 */
import { fileURLToPath } from 'node:url';

import type { CommandNode, OptionNode } from '@loomcli/core';

import { createApp } from '../app';
import { boundClone } from './fixture';
import { runArgv } from './run';

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

/** Whether a quote opened on this shell line is still open at its end (a multi-line argument). */
function endsInsideQuote(line: string): boolean {
  let quote = '';
  for (const ch of line) {
    if (quote === '' && ch === '#') {
      return false;
    }
    if (quote === '' && (ch === '"' || ch === "'")) {
      quote = ch;
    } else if (ch === quote) {
      quote = '';
    }
  }
  return quote !== '';
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
      // A quoted argument may run on over several lines.
      if (endsInsideQuote(pending + line)) {
        pending += `${line}\n`;
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

/** Flags `mimir` takes with no verb: Loom's help, and nothing else. */
const ROOT_FLAGS = new Set(['-h', '--help']);
/**
 * Verbs checked statically only: they act on the machine (the config, the
 * installed skill, the registered MCP server, the binary itself), so running
 * their parser here would either refuse for want of host wiring or write into
 * the real home.
 */
const STATIC_ONLY_VERBS = new Set([
  'store',
  'doctor',
  'self-update',
  'skills',
  'mcp',
  'version',
  'pair',
  'bind',
]);

const isPlaceholder = (word: string): boolean =>
  (word.startsWith('<') && word.endsWith('>')) || word.startsWith('$') || word === '…';
const isFlag = (word: string): boolean => word.startsWith('-') && word !== '-' && word !== '--';

const graph = createApp({
  git: boundClone('KEY'),
  store: () => Promise.reject(new Error('The drift guard reads the graph; it opens no store.')),
}).inspect();

/** Every spelling an option answers to: long, short, negative, and aliases, dashes included. */
function spellings(option: OptionNode): string[] {
  const names = [option.long, option.short, ...option.aliases];
  if (option.type === 'boolean') {
    names.push(option.negative);
  }
  return names
    .filter((name): name is string => name !== null)
    .map((name) => (name.startsWith('-') ? name : `${name.length === 1 ? '-' : '--'}${name}`));
}

const spellingsOf = (nodes: readonly CommandNode[]): string[] =>
  nodes.flatMap((node) => node.options.flatMap(spellings));

const visibleChild = (node: CommandNode, word: string): CommandNode | undefined =>
  node.children.find(
    (child) => !child.hidden && (child.name === word || child.aliases.includes(word)),
  );

const descendants = (node: CommandNode): CommandNode[] => [
  node,
  ...node.children.flatMap(descendants),
];

type Resolved = {
  /** The command path from the root, root excluded. */
  path: CommandNode[];
  placeholder?: boolean;
  problem?: string;
};

/** The deepest command the leading words name (`scratch agenda add`, `create task`, `list`). */
function resolve(words: string[]): Resolved {
  const path: CommandNode[] = [];
  let node = graph.root;
  for (const word of words) {
    if (isFlag(word) || node.children.length === 0) {
      break;
    }
    const child = visibleChild(node, word);
    if (child !== undefined) {
      path.push(child);
      node = child;
      continue;
    }
    if (isPlaceholder(word) && path.length > 0) {
      return { path, placeholder: true };
    }
    // A command with an action reads the word as an argument; a group cannot.
    if (!node.hasAction) {
      return {
        path,
        problem:
          path.length === 0
            ? `unknown command '${word}'`
            : `unknown subcommand '${word}' of mimir ${path.map((p) => p.name).join(' ')}`,
      };
    }
    break;
  }
  return { path };
}

/** The flag spellings the resolved command accepts, with every option it inherits. */
function declaredFlags({ path, placeholder }: Resolved): Set<string> {
  const nodes = [graph.root, ...path];
  const last = path.at(-1);
  if (placeholder === true && last !== undefined) {
    nodes.push(...descendants(last).slice(1));
  }
  return new Set([...graph.globals.flatMap(spellings), ...spellingsOf(nodes), ...ROOT_FLAGS]);
}

/** A word the skill writes as a stand-in: `<id>`, `$VAR`, `…`, or a synopsis list (`p0..p3`, `a|b`). */
const isStandIn = (word: string): boolean =>
  isPlaceholder(word) || word.includes('..') || word.includes('|') || word.endsWith('-sN');

/** A well-formed value for the flag a stand-in value fills, so the parser sees a real call. */
const SAMPLE_VALUES: Record<string, string> = {
  '--expected-updated-at': '2026-01-01T00:00:00.000Z',
  '--file': fileURLToPath(import.meta.url),
  '--format': 'json',
  '--kind': 'idea',
  '--priority': 'p1',
  '--size': 's',
  '--upstream': 'KEY-s1',
  '-f': 'json',
  '-k': 'idea',
  '-p': 'p1',
};

/**
 * The argv the parser sees: a stand-in positional becomes a well-formed id, a
 * stand-in flag value becomes a sample the flag accepts, and a stand-in for a
 * flag that is not declared stays as it is (it was checked statically).
 */
function parserArgv(words: string[]): string[] {
  return words.map((word, i) => {
    const flag = words[i - 1] ?? '';
    // A file the skill names (`--file plan.md`) is an example; the parser wants one that exists.
    if (!isStandIn(word) && flag !== '--file') {
      return word;
    }
    return isFlag(flag) ? (SAMPLE_VALUES[flag] ?? 'KEY-1') : 'KEY-1';
  });
}

/**
 * Run the real parser inside a bound repo (the skill's setting) over a store
 * that refuses to open: a usage refusal (exit 2) is drift, and any other exit
 * means the parser accepted the words and reached the store.
 */
async function parserRefusal(words: string[]): Promise<string | undefined> {
  const app = createApp({
    git: boundClone('KEY'),
    store: () => Promise.reject(new Error('store reached')),
  });
  // A synopsis lists alternatives (`--top | --bottom`) the parser takes as one call.
  const run = await runArgv(app, parserArgv(words), { stdin: 'content' });
  const refused = run.exitCode === 2 && !run.stderr.includes('cannot be used together');
  return refused ? run.stderr.trim() : undefined;
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
  const resolved = resolve(inv.words);
  if (resolved.problem !== undefined) {
    return [resolved.problem];
  }
  const problems: string[] = [];
  const declared = declaredFlags(resolved);
  const terminator = inv.words.indexOf('--');
  const options = terminator === -1 ? inv.words : inv.words.slice(0, terminator);
  const name = resolved.path.map((node) => node.name).join(' ');
  for (const word of options.filter(isFlag)) {
    const flag = word.split('=')[0] ?? word;
    if (!declared.has(flag)) {
      problems.push(`'${flag}' is not a flag of mimir ${name}`);
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

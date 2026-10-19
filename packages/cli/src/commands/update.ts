/**
 * `update <id>`: change a task, phase, or initiative, or a project. A project
 * takes its own flags (`--name`, `--pinned`, `--remote`), a node takes the
 * rest, and a flag aimed at the wrong kind is refused by name.
 */
import { Command } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';
import { MimirError } from '@mimir/contract';

import { MimirUsageError } from '../failures';
import { flagPair, nodeToken, parseUpstream, withListHint, withProjectHint } from '../node-input';
import { asciiOption, text, writeHints } from '../options';
import { parsePriority, parseSize } from '../parse';
import type { Ports } from '../ports';
import { presentationOf } from '../render/presentation';
import { nodeEcho, nodeEchoViews } from '../render/writes';
import type { NodeEcho } from '../render/writes';

/** The flags `update` reads, as the action receives them. */
type UpdateOptions = {
  title?: string;
  desc?: string;
  direction?: string;
  summary?: string;
  priority?: string;
  size?: string;
  target?: string;
  ref?: string;
  upstream?: string;
  host?: string;
  harness?: string;
  session?: string;
  'worker-harness'?: string;
  'worker-session'?: string;
  branch?: string;
  'open-ended'?: boolean;
  'not-open-ended'?: boolean;
  name?: string;
  pinned?: boolean;
  'not-pinned'?: boolean;
  remote?: string;
  ascii: boolean;
};

/** The flags only a project takes, with what each lets a project do. */
const PROJECT_ONLY_FLAGS = [
  ['pinned', 'pinned'],
  ['not-pinned', 'pinned'],
  ['name', 'renamed'],
  ['remote', 'given a Git remote'],
] as const;

/** The flags only a node takes, in the order a project refuses them. */
const NODE_ONLY_FLAGS = [
  'branch',
  'ref',
  'harness',
  'host',
  'open-ended',
  'not-open-ended',
  'priority',
  'session',
  'size',
  'summary',
  'target',
  'title',
  'upstream',
  'worker-harness',
  'worker-session',
] as const;

const given = (value: unknown): boolean => value !== undefined && value !== false;

/** What an id names, in the words a refusal uses. */
const NOUNS = {
  artifact: 'an artifact',
  node: 'a task or container',
  seed: 'a seed',
} as const;

/** Refuse a project-only flag aimed at something that is not a project. */
function refuseProjectOnlyFlags(options: UpdateOptions, kind: keyof typeof NOUNS): void {
  for (const [flag, rule] of PROJECT_ONLY_FLAGS) {
    if (given(options[flag])) {
      const message = `--${flag} doesn't apply to ${NOUNS[kind]} — only a project can be ${rule}`;
      // A seed's refusal is usage-class, like its other node-only flags.
      throw kind === 'seed' ? new MimirUsageError(message) : new MimirError('validation', message);
    }
  }
}

/** Refuse a node-only flag aimed at a project. */
function refuseNodeOnlyFlags(options: UpdateOptions): void {
  for (const flag of NODE_ONLY_FLAGS) {
    if (given(options[flag])) {
      throw new MimirError(
        'validation',
        `--${flag} doesn't apply to a project — use --name to rename it`,
      );
    }
  }
}

/** The labels of the node fields the flags set, in the order the old echo listed them. */
function changedLabels(options: UpdateOptions): string[] {
  const labels: [string, unknown][] = [
    ['title', options.title],
    ['description', options.desc],
    ['next', options.direction],
    ['branch', options.branch],
    ['ref', options.ref],
    ['harness', options.harness],
    ['host', options.host],
    ['open_ended', given(options['open-ended']) || given(options['not-open-ended'])],
    ['priority', options.priority],
    ['session', options.session],
    ['size', options.size],
    ['summary', options.summary],
    ['target', options.target],
    ['upstream', options.upstream],
    ['worker-harness', options['worker-harness']],
    ['worker-session', options['worker-session']],
  ];
  return labels
    .filter(([, value]) => value !== undefined && value !== false)
    .map(([label]) => label);
}

/** A project's `--remote`: absent leaves it, blank clears it. */
function remoteOf(remote: string | undefined): string | null | undefined {
  if (remote === undefined) {
    return undefined;
  }
  return remote.trim() === '' ? null : remote;
}

export function updateCommand(ports: Ports) {
  async function updateProject(id: string, options: UpdateOptions) {
    refuseNodeOnlyFlags(options);
    const pinned = flagPair(
      options.pinned,
      options['not-pinned'],
      'at most one of --pinned | --not-pinned',
    );
    const engine = await ports.engine();
    return withProjectHint(id, () =>
      engine.updateProject({
        description: options.desc,
        id,
        name: options.name,
        next: options.direction,
        pinned,
        // A blank --remote clears it, like a blank --direction clears the narrative.
        remote: remoteOf(options.remote),
      }),
    );
  }

  async function updateNode(id: string, options: UpdateOptions) {
    const openEnded = flagPair(
      options['open-ended'],
      options['not-open-ended'],
      'at most one of --open-ended | --not-open-ended',
    );
    const priority = parsePriority(options.priority);
    const size = parseSize(options.size);
    const upstream = parseUpstream(ports.grammar, options.upstream);
    const engine = await ports.engine();
    return withListHint([id], () =>
      engine.update({
        branch: options.branch,
        description: options.desc,
        externalRef: options.ref,
        harness: options.harness,
        host: options.host,
        id,
        next: options.direction,
        openEnded,
        priority,
        session: options.session,
        size,
        summary: options.summary,
        target: options.target,
        title: options.title,
        upstream,
        workerHarness: options['worker-harness'],
        workerSession: options['worker-session'],
      }),
    );
  }

  return new Command('update', {
    description: 'Change a task, phase, or initiative (KEY-seq), or a project (KEY).',
    extensions: [
      helpCommand({
        examples: [
          {
            command: 'update MMR-16 --title "Wire the store once"',
            note: 'retitle a task',
          },
          {
            command: 'update MMR-16 -p p1 --size m',
            note: 'priority and size',
          },
          {
            command: 'update MMR-4 --direction "Next: …"',
            note: "a container's ## Next narrative",
          },
          { command: 'update MMR --pinned', note: 'pin a project' },
          {
            command: 'update MMR --remote git@github.com:dbtlr/mimir.git',
            note: "a project's remote",
          },
        ],
      }),
      mcpCommand({
        annotations: { ...writeHints, idempotent: true },
      }),
    ],
  })
    .argument('id', { description: 'KEY-seq or KEY.', required: true })
    .option('title', text('The new title.'))
    .option('desc', text('The new description.'))
    .option('direction', text("A container's ## Next narrative."))
    .option('summary', text('A one-line summary.'))
    .option('priority', { ...text('p0, p1, p2, or p3.', 'p0..p3'), short: 'p' })
    .option('size', text('s, m, or l.', 's|m|l'))
    .option('target', text("A phase's target, such as 2026-11.", 'date'))
    .option('ref', text("A task's external reference.", 'ref'))
    .option('upstream', text("A task's seed on another board, or none to clear.", 'KEY-sN|none'))
    .option('host', text('Resume handle: the host working on it.'))
    .option('harness', text('Main conversation: the agent harness.'))
    .option('session', text('Main conversation: the session id.'))
    .option('worker-harness', text('Whole-task worker: the agent harness.'))
    .option('worker-session', text('Whole-task worker: the session id.'))
    .option('branch', text('Resume handle: the Git branch.'))
    .option('open-ended', {
      description: 'Mark a phase or initiative open-ended.',
      type: 'boolean',
    })
    .option('not-open-ended', {
      description: 'Mark it not open-ended.',
      type: 'boolean',
    })
    .option('name', text("A project's new name."))
    .option('pinned', { description: 'Pin a project.', type: 'boolean' })
    .option('not-pinned', { description: 'Unpin a project.', type: 'boolean' })
    .option('remote', text("A project's Git remote; blank clears it.", 'url'))
    .option('ascii', asciiOption)
    .result<NodeEcho>({ views: nodeEchoViews })
    .views({}, { default: 'records' })
    .action(async ({ args, host, options, out }) => {
      const presentation = presentationOf(host, options.ascii);
      const kind = ports.grammar.idKind(args.id);
      if (kind === 'project') {
        const written = await updateProject(args.id, options);
        await out.results(nodeEcho(ports, written, presentation));
        return;
      }
      if (kind === 'artifact' || kind === 'seed') {
        refuseProjectOnlyFlags(options, kind);
        for (const flag of ['worker-harness', 'worker-session'] as const) {
          if (given(options[flag])) {
            throw kind === 'seed'
              ? new MimirUsageError(
                  `--${flag} doesn't apply to a seed — patch --title, --kind, or --desc`,
                )
              : new MimirError(
                  'validation',
                  `--${flag} doesn't apply to an artifact — title and summary are its mutable fields`,
                );
          }
        }
        throw new MimirError(
          'validation',
          `update does not edit ${NOUNS[kind]} yet`,
          kind === 'artifact'
            ? 'artifact edits land with MMR-563; update edits a task, phase, initiative, or project'
            : 'seed edits land with MMR-552; update edits a task, phase, initiative, or project',
        );
      }
      // A token that names no kind is the Engine's to refuse as missing, as the old CLI did.
      if (kind === 'node') {
        refuseProjectOnlyFlags(options, 'node');
      }
      const id = nodeToken(ports.grammar, args.id);
      const written = await updateNode(id, options);
      const labels = changedLabels(options);
      const suffix = labels.length > 0 ? ` (${labels.join(', ')})` : '';
      await out.results(nodeEcho(ports, written, presentation, (rid) => `updated ${rid}${suffix}`));
    });
}

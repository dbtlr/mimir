/**
 * `update <id>`: change a task, phase, or initiative, a project, an artifact,
 * or a seed. A project takes its own flags (`--name`, `--pinned`, `--remote`),
 * an artifact `--title` and `--summary`, a seed `--title`, `--kind`, and
 * `--desc`, a node takes the rest, and a flag aimed at the wrong kind is
 * refused by name.
 */
import { Command } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';
import { intentEncoders, MimirError, SEED_KIND_VALUES } from '@mimir/contract';

import { MimirUsageError } from '../failures';
import { flagPair, nodeToken, parseUpstream, withListHint, withProjectHint } from '../node-input';
import { asciiOption, text, writeHints } from '../options';
import { parsePriority, parseSeedKind, parseSize } from '../parse';
import type { Ports } from '../ports';
import { idOf, recordsOf, tableOf } from '../render/get';
import type { GetValue } from '../render/get';
import { presentationOf } from '../render/presentation';
import type { Presentation } from '../render/presentation';
import { seedEcho, seedRecordsOf } from '../render/seeds';
import type { SeedEcho } from '../render/seeds';
import { prettyJson, recordViews } from '../render/views';
import { nodeEcho, nodeEchoRecords, nodeEchoTable } from '../render/writes';
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
  kind?: string;
  ascii: boolean;
};

/** The flags only a project takes, with what each lets a project do. */
const PROJECT_ONLY_FLAGS = [
  ['pinned', 'pinned'],
  ['not-pinned', 'pinned'],
  ['name', 'renamed'],
  ['remote', 'given a Git remote'],
] as const;

const given = (value: unknown): boolean => value !== undefined && value !== false;

/** What an id names, in the words a refusal uses. */
const NOUNS = {
  artifact: 'an artifact',
  node: 'a task or container',
  project: 'a project',
  seed: 'a seed',
} as const;

/** The targets other than a node that own a field. */
type Owner = 'artifact' | 'project' | 'seed';

/**
 * Every node field's flags in the canonical field order a refusal walks, with
 * the other targets that own the field. The first given flag a target does not
 * own is the one a refusal names.
 */
const FIELD_FLAGS: readonly (readonly [flag: keyof UpdateOptions, owners: readonly Owner[]])[] = [
  ['branch', []],
  ['desc', ['project', 'seed']],
  ['ref', []],
  ['harness', []],
  ['host', []],
  ['direction', ['project']],
  ['open-ended', []],
  ['not-open-ended', []],
  ['priority', []],
  ['session', []],
  ['size', []],
  ['summary', ['artifact']],
  ['target', []],
  ['title', ['artifact', 'seed']],
  ['upstream', []],
  ['worker-harness', []],
  ['worker-session', []],
];

/** The node-field flags `owner` does not own, in the order a refusal walks them. */
export function foreignFields(owner: Owner): (keyof UpdateOptions)[] {
  return FIELD_FLAGS.filter(([, owners]) => !owners.includes(owner)).map(([flag]) => flag);
}

/** The first given node field that `owner` does not own, if any. */
function firstForeignFlag(options: UpdateOptions, owner: Owner): keyof UpdateOptions | undefined {
  return foreignFields(owner).find((flag) => given(options[flag]));
}

/** Refuse `--kind` aimed at anything but a seed, the only target that has a kind. */
function refuseKind(options: UpdateOptions, target: Exclude<keyof typeof NOUNS, 'seed'>): void {
  if (given(options.kind)) {
    throw new MimirError(
      'validation',
      `--kind doesn't apply to ${NOUNS[target]} — only a seed has a kind`,
    );
  }
}

/** Refuse a node-only flag aimed at an artifact or a seed, as the old CLI worded it. */
function refuseInapplicableFields(options: UpdateOptions, kind: 'artifact' | 'seed'): void {
  const flag = firstForeignFlag(options, kind);
  if (flag === undefined) {
    return;
  }
  if (kind === 'seed') {
    throw new MimirUsageError(
      `--${flag} doesn't apply to a seed — patch --title, --kind, or --desc`,
    );
  }
  throw new MimirError(
    'validation',
    `--${flag} doesn't apply to an artifact — title and summary are its mutable fields`,
  );
}

/** Refuse a project-only flag aimed at something that is not a project. */
function refuseProjectOnlyFlags(
  options: UpdateOptions,
  kind: Exclude<keyof typeof NOUNS, 'project'>,
): void {
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
  const flag = firstForeignFlag(options, 'project');
  if (flag !== undefined) {
    throw new MimirError(
      'validation',
      `--${flag} doesn't apply to a project — use --name to rename it`,
    );
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

/** The labels of the seed fields the flags set, in the order the old echo listed them. */
function seedLabels(options: UpdateOptions): string[] {
  const labels: [string, unknown][] = [
    ['title', options.title],
    ['description', options.desc],
    ['kind', options.kind],
  ];
  return labels.filter(([, value]) => value !== undefined).map(([label]) => label);
}

/** A project's `--remote`: absent leaves it, blank clears it. */
function remoteOf(remote: string | undefined): string | null | undefined {
  if (remote === undefined) {
    return undefined;
  }
  return remote.trim() === '' ? null : remote;
}

/** The written record `update` echoes, whichever kind the id named. */
type UpdateEcho = NodeEcho | SeedEcho | Extract<GetValue, { kind: 'artifact' }>;

/** Route an echo to the text of the kind it carries: an artifact, a seed, or a node. */
function textOf(
  echo: Readonly<UpdateEcho>,
  render: {
    artifact: (echo: Readonly<GetValue>) => string;
    node: (echo: Readonly<NodeEcho>) => string;
    seed: (echo: Readonly<SeedEcho>) => string;
  },
): string {
  if ('artifact' in echo) {
    return render.artifact(echo);
  }
  return 'seed' in echo ? render.seed(echo) : render.node(echo);
}

/** The views of a written artifact, seed, or node; an artifact prints no note, as `get` does not. */
const updateViews = recordViews<UpdateEcho>({
  ids: (echo) => textOf(echo, { artifact: idOf, node: (e) => e.node.id, seed: (e) => e.seed.id }),
  json: (echo) => prettyJson(echo.wire),
  records: (echo) =>
    textOf(echo, { artifact: recordsOf, node: nodeEchoRecords, seed: seedRecordsOf }),
  table: (echo) => textOf(echo, { artifact: tableOf, node: nodeEchoTable, seed: seedRecordsOf }),
});

export function updateCommand(ports: Ports) {
  async function updateProject(id: string, options: UpdateOptions) {
    refuseNodeOnlyFlags(options);
    refuseKind(options, 'project');
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

  async function updateArtifact(id: string, options: UpdateOptions, presentation: Presentation) {
    refuseKind(options, 'artifact');
    const engine = await ports.engine();
    const artifact = intentEncoders.artifactDetail.parse(
      await engine.updateArtifact({ id, summary: options.summary, title: options.title }),
    );
    return {
      artifact,
      kind: 'artifact',
      presentation,
      wire: ports.wire.artifact(artifact),
    } as const;
  }

  async function updateSeed(id: string, options: UpdateOptions, presentation: Presentation) {
    const kind = parseSeedKind(options.kind);
    const engine = await ports.engine();
    const seed = intentEncoders.seed.parse(
      await engine.seedUpdate({ description: options.desc, id, kind, title: options.title }),
    );
    const labels = seedLabels(options);
    const suffix = labels.length > 0 ? ` (${labels.join(', ')})` : '';
    return seedEcho(ports, seed, `updated ${seed.id}${suffix}`, presentation);
  }

  return new Command('update', {
    description:
      'Change a task, phase, or initiative (KEY-seq), a project (KEY), an artifact (KEY-aN), or a seed (KEY-sN).',
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
          { command: 'update MMR-a1 --title "…"', note: 'retitle an artifact' },
          { command: 'update MMR-s1 --kind bug', note: "change a seed's kind" },
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
    .argument('id', { description: 'KEY-seq, KEY, KEY-aN, or KEY-sN.', required: true })
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
    .option('kind', {
      ...text(`A seed's kind: ${SEED_KIND_VALUES.join(', ')}.`, 'kind'),
      short: 'k',
    })
    .option('ascii', asciiOption)
    .result<UpdateEcho>({ views: updateViews })
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
        refuseInapplicableFields(options, kind);
        await out.results(
          kind === 'artifact'
            ? await updateArtifact(args.id, options, presentation)
            : await updateSeed(args.id, options, presentation),
        );
        return;
      }
      // A token that names no kind is the Engine's to refuse as missing, as the old CLI did.
      if (kind === 'node') {
        refuseProjectOnlyFlags(options, 'node');
        refuseKind(options, 'node');
      }
      const id = nodeToken(ports.grammar, args.id);
      const written = await updateNode(id, options);
      const labels = changedLabels(options);
      const suffix = labels.length > 0 ? ` (${labels.join(', ')})` : '';
      await out.results(nodeEcho(ports, written, presentation, (rid) => `updated ${rid}${suffix}`));
    });
}

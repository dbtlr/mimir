/**
 * `create project|initiative|phase|task`: add a record to the work tree. Each
 * type is a subcommand that declares only the options that type takes.
 */
import { Command, FatalError } from '@loomcli/core';
import type { StringOption } from '@loomcli/core';
import { helpCommand, helpInput } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';
import { MimirError, PROJECT_KEY_PATTERN } from '@mimir/contract';

import { DASH_TITLE_HINT, MimirUsageError } from '../failures';
import { flagPair, parseUpstream, withListHint } from '../node-input';
import { asciiOption, tagOption, text, writeHints } from '../options';
import { parsePriority, parseSize } from '../parse';
import type { Ports } from '../ports';
import { okLine, presentationOf } from '../render/presentation';
import { nodeEcho, nodeEchoViews, noticeViews } from '../render/writes';
import type { NodeEcho, Notice } from '../render/writes';

const descOption = text('The description.');
const summaryOption = text('A one-line summary.');
const parentOption = (what: string) =>
  ({
    description: `The parent ${what}.`,
    extensions: [helpInput({ placeholder: 'id' })],
    required: true,
    type: 'string',
  }) satisfies StringOption;
const openEndedOption = {
  description: 'Mark it open-ended.',
  type: 'boolean',
} as const;
const notOpenEndedOption = {
  description: 'Mark it not open-ended.',
  type: 'boolean',
} as const;

/**
 * The title a create takes: the argument, else the words after `--` (which is
 * how a title that leads with a dash arrives). Absent, it is the usage error
 * that points at the `--` terminator.
 */
function requireTitle(
  title: string | undefined,
  passthrough: readonly string[],
  type: string,
): string {
  const given = title ?? (passthrough.length > 0 ? passthrough.join(' ') : undefined);
  if (given === undefined || given.trim() === '') {
    throw new MimirUsageError(`create ${type} requires a title`, DASH_TITLE_HINT);
  }
  return given;
}

/** The tags given, or `undefined` for none, which the Engine takes as "add no tags". */
const tagsOf = (tags: readonly string[]): string[] | undefined =>
  tags.length > 0 ? [...tags] : undefined;

/** A parent token whose grammar cannot be the required kind is a bad invocation, not a lookup miss. */
function requireParentKind(
  ports: Ports,
  parent: string,
  kind: 'project' | 'node',
  message: string,
): string {
  if (ports.grammar.idKind(parent) !== kind) {
    throw new MimirUsageError(message);
  }
  return parent;
}

function projectCommand(ports: Ports) {
  return new Command('project', {
    description: 'Create a project. Its key is immutable, so creating one asks for confirmation.',
    extensions: [
      helpCommand({
        examples: [
          {
            command: 'create project "Mimir" --key MMR -y',
            note: 'confirm without a prompt',
          },
        ],
      }),
      mcpCommand({ annotations: writeHints }),
    ],
  })
    .argument('name', {
      description: "The project's name, or give it as --name.",
    })
    .option('key', {
      description: 'The project key: two to four capital letters. It cannot change.',
      extensions: [helpInput({ placeholder: 'KEY' })],
      required: true,
      type: 'string',
    })
    .option('name', text("The project's name, when not given as the argument."))
    .option('desc', descOption)
    .option('remote', text('The Git remote the project lives at.', 'url'))
    .option('tag', tagOption)
    .option('yes', {
      description: 'Confirm without a prompt.',
      short: 'y',
      type: 'boolean',
    })
    .option('ascii', asciiOption)
    .result<Notice>({ views: noticeViews })
    .views({}, { default: 'records' })
    .action(async ({ args, host, interactive, options, out }) => {
      const name = args.name ?? options.name;
      if (name === undefined) {
        throw new MimirUsageError(
          'create project requires a name',
          'create project "Name" --key KEY',
        );
      }
      // The key is immutable, so creation is the one gated write: a prompt on a
      // terminal, and -y/--yes where there is none.
      if (!options.yes) {
        if (!interactive) {
          throw new MimirUsageError(
            `create project ${options.key}: the key is immutable — confirmation required`,
            're-run with -y/--yes to confirm',
          );
        }
        const proceed = await ports.confirm(
          `create project ${options.key} ("${name}") — the key is immutable. proceed?`,
        );
        if (!proceed) {
          throw new FatalError('aborted');
        }
      }
      // A key not shaped like one is a refusal of the key, not of the schema.
      if (!PROJECT_KEY_PATTERN.test(options.key)) {
        throw new MimirError('validation', `project key must match [A-Z]{2,4}: ${options.key}`);
      }
      const engine = await ports.engine();
      const project = await engine.create({
        description: options.desc,
        key: options.key,
        name,
        remote: options.remote,
        tags: tagsOf(options.tag),
        type: 'project',
      });
      await out.results({
        ids: project.id,
        json: { project: { key: project.id, name: project.title } },
        line: okLine(presentationOf(host, options.ascii), `created project ${project.id}`),
      });
    });
}

function initiativeCommand(ports: Ports) {
  return new Command('initiative', {
    description: 'Create an initiative under a project.',
    extensions: [
      helpCommand({
        examples: [
          {
            command: 'create initiative "Platform" --parent MMR',
            note: 'under project MMR',
          },
        ],
      }),
      mcpCommand({ annotations: writeHints }),
    ],
  })
    .argument('title', { description: "The initiative's title." })
    .option('parent', parentOption('project (KEY)'))
    .option('desc', descOption)
    .option('summary', summaryOption)
    .option('tag', tagOption)
    .option('open-ended', openEndedOption)
    .option('not-open-ended', notOpenEndedOption)
    .option('ascii', asciiOption)
    .result<NodeEcho>({ views: nodeEchoViews })
    .views({}, { default: 'records' })
    .action(async ({ args, host, options, out, passthrough }) => {
      const title = requireTitle(args.title, passthrough, 'initiative');
      const parent = requireParentKind(
        ports,
        options.parent,
        'project',
        "an initiative's parent must be a project (KEY)",
      );
      const openEnded = flagPair(
        options['open-ended'],
        options['not-open-ended'],
        'at most one of --open-ended | --not-open-ended',
      );
      const engine = await ports.engine();
      const written = await engine.create({
        description: options.desc,
        openEnded,
        parent,
        summary: options.summary,
        tags: tagsOf(options.tag),
        title,
        type: 'initiative',
      });
      await out.results(
        nodeEcho(ports, written, presentationOf(host, options.ascii), (rid) => `created ${rid}`),
      );
    });
}

function phaseCommand(ports: Ports) {
  return new Command('phase', {
    description: 'Create a phase under an initiative.',
    extensions: [
      helpCommand({
        examples: [
          {
            command: 'create phase "Skeleton" --parent MMR-2 --target 2026-11',
            note: 'with a target',
          },
        ],
      }),
      mcpCommand({ annotations: writeHints }),
    ],
  })
    .argument('title', { description: "The phase's title." })
    .option('parent', parentOption('initiative (KEY-seq)'))
    .option('desc', descOption)
    .option('summary', summaryOption)
    .option('target', text('When it should land, such as 2026-11.', 'date'))
    .option('tag', tagOption)
    .option('open-ended', openEndedOption)
    .option('not-open-ended', notOpenEndedOption)
    .option('ascii', asciiOption)
    .result<NodeEcho>({ views: nodeEchoViews })
    .views({}, { default: 'records' })
    .action(async ({ args, host, options, out, passthrough }) => {
      const title = requireTitle(args.title, passthrough, 'phase');
      const parent = requireParentKind(
        ports,
        options.parent,
        'node',
        "a phase's parent must be an initiative (KEY-seq)",
      );
      const openEnded = flagPair(
        options['open-ended'],
        options['not-open-ended'],
        'at most one of --open-ended | --not-open-ended',
      );
      const engine = await ports.engine();
      const written = await withListHint([parent], () =>
        engine.create({
          description: options.desc,
          openEnded,
          parent,
          summary: options.summary,
          tags: tagsOf(options.tag),
          target: options.target,
          title,
          type: 'phase',
        }),
      );
      await out.results(
        nodeEcho(ports, written, presentationOf(host, options.ascii), (rid) => `created ${rid}`),
      );
    });
}

/** The resume handles given, or `undefined` when none were. */
function handlesOf(options: {
  host?: string;
  harness?: string;
  session?: string;
  branch?: string;
}) {
  const given = Object.entries({
    branch: options.branch,
    harness: options.harness,
    host: options.host,
    session: options.session,
  }).filter(([, value]) => value !== undefined);
  return given.length === 0 ? undefined : Object.fromEntries(given);
}

function taskCommand(ports: Ports) {
  return new Command('task', {
    description: 'Create a task under a phase or initiative.',
    extensions: [
      helpCommand({
        examples: [
          {
            command: 'create task "Wire the store" --parent MMR-4',
            note: 'a task under a phase',
          },
          {
            command: 'create task "Spike" --parent MMR-4 --size s -p p1',
            note: 'sized and ranked',
          },
          {
            command: 'create task --parent MMR-4 -- "--weird title"',
            note: 'a title that starts with a dash',
          },
        ],
      }),
      mcpCommand({ annotations: writeHints }),
    ],
  })
    .argument('title', { description: "The task's title." })
    .option('parent', parentOption('phase or initiative (KEY-seq)'))
    .option('desc', descOption)
    .option('summary', summaryOption)
    .option('priority', { ...text('p0, p1, p2, or p3.', 'p0..p3'), short: 'p' })
    .option('size', text('s, m, or l.', 's|m|l'))
    .option('ref', text('An external reference, such as an issue URL.', 'ref'))
    .option('upstream', text('The seed on another board this task answers.', 'KEY-sN'))
    .option('host', text('Resume handle: the host working on it.'))
    .option('harness', text('Resume handle: the agent harness.'))
    .option('session', text('Resume handle: the session id.'))
    .option('branch', text('Resume handle: the Git branch.'))
    .option('tag', tagOption)
    .option('groomed', {
      description: 'Born groomed: carved from a finished design.',
      type: 'boolean',
    })
    .option('ascii', asciiOption)
    .result<NodeEcho>({ views: nodeEchoViews })
    .views({}, { default: 'records' })
    .action(async ({ args, host, options, out, passthrough }) => {
      const title = requireTitle(args.title, passthrough, 'task');
      const parent = requireParentKind(
        ports,
        options.parent,
        'node',
        "a task's parent must be a phase or initiative (KEY-seq)",
      );
      const priority = parsePriority(options.priority);
      const size = parseSize(options.size);
      const upstream = parseUpstream(ports.grammar, options.upstream) ?? undefined;
      const engine = await ports.engine();
      const written = await withListHint([parent], () =>
        engine.create({
          description: options.desc,
          externalRef: options.ref,
          groomed: options.groomed ? true : undefined,
          handles: handlesOf(options),
          parent,
          priority,
          size,
          summary: options.summary,
          tags: tagsOf(options.tag),
          title,
          type: 'task',
          upstream,
        }),
      );
      await out.results(
        nodeEcho(ports, written, presentationOf(host, options.ascii), (rid) => `created ${rid}`),
      );
    });
}

export function createCommand(ports: Ports) {
  return new Command('create', {
    description: 'Create a project, initiative, phase, or task.',
  })
    .command(projectCommand(ports))
    .command(initiativeCommand(ports))
    .command(phaseCommand(ports))
    .command(taskCommand(ports));
}

/**
 * `scratch`: the Scratchpad group. Its reads are `list` (one project's pads)
 * and `get` (one pad by UUID); its writes are create, update, checkpoint, the
 * agenda changes, freeze, and discard. A write calls the Engine and echoes a
 * compact receipt whose `updated_at` is the next concurrency token.
 */
import { Command } from '@loomcli/core';
import { helpCommand, helpInput } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';
import { intentEncoders, MimirError } from '@mimir/contract';
import type { ArtifactDetail, Engine, Scratchpad } from '@mimir/contract';

import { MimirUsageError } from '../failures';
import { asciiOption, scopeOption, tagOption, text, writeHints } from '../options';
import { reasonWords } from '../parse';
import type { Ports } from '../ports';
import { presentationOf } from '../render/presentation';
import type { Presentation } from '../render/presentation';
import { renderScratchpad, renderScratchRows, scratchEchoViews } from '../render/scratch';
import type { ScratchEcho } from '../render/scratch';
import { recordViews } from '../render/views';
import { boardProject, boundProject, targetProject } from '../scope';

/** The pads of one project, as the wire rows `json`, `jsonl`, and `ids` print. */
export type ScratchListValue = { rows: Record<string, unknown>[] };

// The old CLI printed the scratchpad reads' `json` on one line, unlike every other read.
const listViews = recordViews<ScratchListValue>({
  compact: true,
  ids: (value) => value.rows.map((r) => r.id).join('\n'),
  json: (value) => ({ scratchpads: value.rows, total: value.rows.length }),
  jsonl: (value) => value.rows,
  records: (value) => renderScratchRows(value.rows),
});

function scratchListCommand(ports: Ports) {
  return new Command('list', {
    description: "List one project's active scratchpads, freezing first and newest first.",
    extensions: [
      helpCommand({
        examples: [
          { command: 'scratch list', note: "the bound project's pads" },
          { command: 'scratch list -s MMR -f json', note: 'structured output for scripts' },
        ],
      }),
      mcpCommand({ annotations: { openWorld: false, readOnly: true } }),
    ],
  })
    .option('scope', scopeOption)
    .result<ScratchListValue>({ views: listViews })
    .views({ table: listViews.table }, { default: 'table' })
    .action(async ({ options, out }) => {
      const notify = (line: string): void => {
        void out.print(line);
      };
      const project = await boardProject(ports, options.scope, 'scratch list', notify);
      const engine = await ports.engine();
      const pads = intentEncoders.scratchpadRows.parse(await engine.scratchList({ project }));
      await out.results({ rows: pads.map((pad) => ports.wire.scratchRow(pad)) });
    });
}

/** One pad, its wire object, and how the styled views render it. */
export type ScratchGetValue = {
  presentation: Presentation;
  wire: Record<string, unknown>;
};

const getText = (value: Readonly<ScratchGetValue>): string =>
  renderScratchpad(value.wire, value.presentation);

const getViews = recordViews<ScratchGetValue>({
  compact: true,
  ids: (value) => String(value.wire.id),
  json: (value) => value.wire,
  records: getText,
});

function scratchGetCommand(ports: Ports) {
  return new Command('get', {
    description: 'Read one scratchpad by UUID: its agenda, journal, and linked work.',
    extensions: [
      helpCommand({ examples: [{ command: 'scratch get 0d6c3f1e-…', note: 'one pad in full' }] }),
      mcpCommand({ annotations: { openWorld: false, readOnly: true } }),
    ],
  })
    .argument('id', { description: 'The scratchpad UUID.', required: true })
    .option('ascii', asciiOption)
    .result<ScratchGetValue>({ views: getViews })
    .views({ records: getViews.records }, { default: 'records' })
    .action(async ({ args, host, options, out }) => {
      const engine = await ports.engine();
      const pad = intentEncoders.scratchpad.parse(await engine.scratchGet({ id: args.id }));
      await out.results({
        presentation: presentationOf(host, options.ascii),
        wire: ports.wire.scratchpad(pad),
      });
    });
}

const expectedOption = {
  description:
    "The scratchpad's updated_at as last read: the write is refused if it changed since.",
  extensions: [helpInput({ placeholder: 'timestamp' })],
  type: 'string',
} as const;

const linkOption = {
  description: 'Linked work (a task or artifact id). Repeat for more.',
  extensions: [helpInput({ placeholder: 'ID' })],
  multiple: true,
  type: 'string',
} as const;

function required(value: string | undefined, message: string): string {
  if (value === undefined || value.trim() === '') {
    throw new MimirUsageError(message);
  }
  return value;
}

/**
 * The concurrency guard as the Date the Engine takes. A token that reads as no
 * instant can match no stored one, so it becomes the epoch and the Engine
 * refuses the write as changed concurrently, as it does any stale token.
 */
function guard(raw: string | undefined): Date {
  const token = required(raw, 'scratch mutation requires --expected-updated-at <timestamp>');
  const instant = new Date(token);
  return Number.isNaN(instant.getTime()) ? new Date(0) : instant;
}

function agendaNumber(raw: string | undefined, verb: string): number {
  const parsed = Number(raw);
  if (raw === undefined || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new MimirUsageError(`scratch agenda ${verb} requires a positive item number`);
  }
  return parsed;
}

/** The write subcommands of the group. */
function scratchWriteCommands(ports: Ports) {
  /** The echo of a Scratchpad write: its compact receipt. */
  const receipt = (pad: unknown, p: ScratchEcho['presentation']): ScratchEcho => ({
    presentation: p,
    wire: ports.wire.scratchReceipt(intentEncoders.scratchpad.parse(pad) satisfies Scratchpad),
  });

  const create = new Command('create', {
    description: 'Create a scratchpad: a temporary journal and agenda for one episode of work.',
    extensions: [
      helpCommand({
        examples: [
          { command: 'scratch create "Index rewrite" --link MMR-12', note: 'anchor it to a task' },
        ],
      }),
      mcpCommand({ annotations: writeHints }),
    ],
  })
    .argument('words', { description: 'The title, the rest of the line.', variadic: true })
    .option('title', text('The title, in place of the words after the subcommand.'))
    .option('link', linkOption)
    .option('scope', {
      ...scopeOption,
      description: 'The project to create the scratchpad in. Defaults to the clone binding.',
    })
    .option('ascii', asciiOption)
    .result<ScratchEcho>({ views: scratchEchoViews })
    .views({ records: scratchEchoViews.records }, { default: 'records' })
    .action(async ({ args, host, options, out, passthrough }) => {
      const notify = (line: string): void => {
        void out.print(line);
      };
      const words = reasonWords(args.words, passthrough);
      const title = required(
        options.title ?? (words === '' ? undefined : words),
        'scratch create requires a title',
      );
      const bound = await boundProject(ports, options.scope, notify);
      const project = targetProject(
        undefined,
        bound,
        {
          hint: 'bind a project or pass -s KEY',
          message: 'scratch create needs a project',
        },
        (key) => new MimirError('not_found', `project ${key} doesn't exist`),
      );
      const engine = await ports.engine();
      const pad = await engine.scratchCreate({
        anchors: options.link.length > 0 ? options.link : undefined,
        project,
        title,
      });
      await out.results(receipt(pad, presentationOf(host, options.ascii)));
    });

  const update = new Command('update', {
    description: "Change a scratchpad's title or linked work.",
    extensions: [mcpCommand({ annotations: writeHints })],
  })
    .argument('id', { description: 'The scratchpad UUID.', required: true })
    .option('expected-updated-at', expectedOption)
    .option('title', text('The new title.'))
    .option('link', linkOption)
    .option('clear-links', { description: 'Drop all linked work.', type: 'boolean' })
    .option('ascii', asciiOption)
    .result<ScratchEcho>({ views: scratchEchoViews })
    .views({ records: scratchEchoViews.records }, { default: 'records' })
    .action(async ({ args, host, options, out }) => {
      if (options['clear-links'] && options.link.length > 0) {
        throw new MimirUsageError('scratch update cannot combine --clear-links and --link');
      }
      const expectedUpdatedAt = guard(options['expected-updated-at']);
      // Clearing the links sends an empty list; no `--link` leaves them as they are.
      let anchors: string[] | undefined;
      if (options['clear-links']) {
        anchors = [];
      } else if (options.link.length > 0) {
        anchors = options.link;
      }
      const engine = await ports.engine();
      const pad = await engine.scratchUpdate({
        anchors,
        expectedUpdatedAt,
        id: args.id,
        title: options.title,
      });
      await out.results(receipt(pad, presentationOf(host, options.ascii)));
    });

  const checkpoint = new Command('checkpoint', {
    description: "Append a checkpoint to a scratchpad's journal, inline or from a file.",
    extensions: [mcpCommand({ annotations: writeHints })],
  })
    .argument('id', { description: 'The scratchpad UUID.', required: true })
    .argument('text', { description: 'The checkpoint text, the rest of the line.', variadic: true })
    .option('expected-updated-at', expectedOption)
    .option('file', {
      description: 'Read the checkpoint from this file instead, or from piped stdin.',
      extensions: [helpInput({ placeholder: 'path' })],
      stdin: true,
      type: 'content',
    })
    .option('ascii', asciiOption)
    .result<ScratchEcho>({ views: scratchEchoViews })
    .views({ records: scratchEchoViews.records }, { default: 'records' })
    .action(async ({ args, host, options, out, passthrough }) => {
      const inline = reasonWords(args.text, passthrough) || undefined;
      // Piped stdin only stands in for a checkpoint when no text was typed; a path is explicit.
      if (inline !== undefined && options.file?.path !== undefined) {
        throw new MimirUsageError(
          'scratch checkpoint accepts either inline content or --file, not both',
        );
      }
      const expectedUpdatedAt = guard(options['expected-updated-at']);
      const content = required(
        inline ?? (await options.file?.text()),
        'scratch checkpoint requires content or --file',
      );
      const engine = await ports.engine();
      const pad = await engine.scratchCheckpoint({ content, expectedUpdatedAt, id: args.id });
      await out.results(receipt(pad, presentationOf(host, options.ascii)));
    });

  // Loom 0.13 nests commands two levels below the root, so `scratch agenda <action>`
  // is one command that takes its action as the first argument (seed LM-s29).
  const agenda = new Command('agenda', {
    description:
      "Change a scratchpad's agenda: add an item, complete one, or supersede one with a reason.",
    extensions: [
      helpCommand({
        examples: [
          { command: 'scratch agenda add <id> Port the verbs', note: 'add an item' },
          { command: 'scratch agenda complete <id> 2', note: 'mark item 2 done' },
          { command: 'scratch agenda supersede <id> 3 folded into 2', note: 'with its reason' },
        ],
      }),
      mcpCommand({ annotations: writeHints }),
    ],
  })
    .argument('action', { description: 'add, complete, or supersede.', required: true })
    .argument('id', { description: 'The scratchpad UUID.', required: true })
    .argument('words', {
      description:
        'For add, the item; for complete and supersede, the item number then any reason.',
      variadic: true,
    })
    .option('expected-updated-at', expectedOption)
    .option('reason', text('For supersede, why, in place of the words after the number.'))
    .option('ascii', asciiOption)
    .result<ScratchEcho>({ views: scratchEchoViews })
    .views({ records: scratchEchoViews.records }, { default: 'records' })
    .action(async ({ args, host, options, out, passthrough }) => {
      const { action, id } = args;
      if (action !== 'add' && action !== 'complete' && action !== 'supersede') {
        throw new MimirUsageError('scratch agenda requires add, complete, or supersede');
      }
      const expectedUpdatedAt = guard(options['expected-updated-at']);
      const words = [...args.words, ...passthrough];
      const [first, ...rest] = words;
      // Every usage refusal comes before the store opens.
      let write: (engine: Engine) => Promise<unknown>;
      if (action === 'add') {
        const content = required(
          words.join(' ') || undefined,
          'scratch agenda add requires content',
        );
        write = (engine) => engine.scratchAgendaAdd({ content, expectedUpdatedAt, id });
      } else if (action === 'complete') {
        const number = agendaNumber(first, 'complete');
        write = (engine) => engine.scratchAgendaComplete({ expectedUpdatedAt, id, number });
      } else {
        const number = agendaNumber(first, 'supersede');
        const reason = required(
          options.reason ?? (rest.join(' ') || undefined),
          'scratch agenda supersede requires a reason',
        );
        write = (engine) =>
          engine.scratchAgendaSupersede({ expectedUpdatedAt, id, number, reason });
      }
      const pad = await write(await ports.engine());
      await out.results(receipt(pad, presentationOf(host, options.ascii)));
    });

  const freeze = new Command('freeze', {
    description: 'Freeze a scratchpad into an artifact, with a summary and tags.',
    extensions: [mcpCommand({ annotations: writeHints })],
  })
    .argument('id', { description: 'The scratchpad UUID.', required: true })
    .option('expected-updated-at', expectedOption)
    .option('summary', text("The artifact's summary."))
    .option('tag', { ...tagOption, description: 'Tag the artifact. Repeat for more.' })
    .option('ascii', asciiOption)
    .result<ScratchEcho>({ views: scratchEchoViews })
    .views({ records: scratchEchoViews.records }, { default: 'records' })
    .action(async ({ args, host, options, out }) => {
      const expectedUpdatedAt = guard(options['expected-updated-at']);
      const summary = required(options.summary, 'scratch freeze requires --summary');
      const engine = await ports.engine();
      const artifact: ArtifactDetail = intentEncoders.artifactDetail.parse(
        await engine.scratchFreeze({
          expectedUpdatedAt,
          id: args.id,
          summary,
          tags: options.tag.length > 0 ? options.tag : undefined,
        }),
      );
      await out.results({
        presentation: presentationOf(host, options.ascii),
        wire: {
          created_at: artifact.createdAt,
          id: artifact.id,
          linked_work: artifact.links,
          project: artifact.project,
          summary: artifact.summary,
          tags: artifact.tags,
          title: artifact.title,
        },
      });
    });

  const discard = new Command('discard', {
    description: 'Discard a scratchpad. A scratchpad with work in it needs --force.',
    extensions: [mcpCommand({ annotations: { ...writeHints, destructive: true } })],
  })
    .argument('id', { description: 'The scratchpad UUID.', required: true })
    .option('expected-updated-at', expectedOption)
    .option('force', { description: 'Discard even if it has journal entries.', type: 'boolean' })
    .option('reason', text('Why it is discarded.'))
    .option('ascii', asciiOption)
    .result<ScratchEcho>({ views: scratchEchoViews })
    .views({ records: scratchEchoViews.records }, { default: 'records' })
    .action(async ({ args, host, options, out }) => {
      const expectedUpdatedAt = guard(options['expected-updated-at']);
      const engine = await ports.engine();
      const result = intentEncoders.scratchpadDiscard.parse(
        await engine.scratchDiscard({
          expectedUpdatedAt,
          force: options.force ? true : undefined,
          id: args.id,
          reason: options.reason,
        }),
      );
      await out.results({
        presentation: presentationOf(host, options.ascii),
        wire: { id: result.id, result: result.result },
      });
    });

  return { agenda, checkpoint, create, discard, freeze, update };
}

export function scratchCommand(ports: Ports) {
  const writes = scratchWriteCommands(ports);
  return new Command('scratch', {
    description: 'Read and keep Scratchpads, the working state of one episode.',
  })
    .command(scratchListCommand(ports))
    .command(scratchGetCommand(ports))
    .command(writes.create)
    .command(writes.update)
    .command(writes.checkpoint)
    .command(writes.agenda)
    .command(writes.freeze)
    .command(writes.discard);
}

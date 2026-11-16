/**
 * `item`: the checklist group (ADR 0044). `item add` adds an open item to a
 * task; `item check` and `item drop` settle one for good, a drop with its
 * reason. Each subcommand calls one Engine method and prints the task's whole
 * checklist as `json`, the task id as `ids`, and the item it changed as
 * `records`.
 */
import { Command } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';
import { encodeChecklist } from '@mimir/contract';
import type { EngineChecklist } from '@mimir/contract';

import { MimirUsageError } from '../failures';
import { nodeToken } from '../node-input';
import { asciiOption, text, writeHints } from '../options';
import { reasonWords } from '../parse';
import type { Ports } from '../ports';
import { itemEchoViews } from '../render/checklist';
import type { ItemEcho } from '../render/checklist';
import { presentationOf } from '../render/presentation';
import type { Presentation } from '../render/presentation';

/** The item number a usage line names: a positive whole number, refused before the store opens. */
function itemNumber(raw: string | undefined, verb: string): number {
  const parsed = Number(raw);
  if (raw === undefined || !/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new MimirUsageError(`item ${verb} requires a positive item number`);
  }
  return parsed;
}

/** The echo of a write: the whole checklist, and the item the write changed. */
function echo(checklist: EngineChecklist, changed: number, presentation: Presentation): ItemEcho {
  return { changed, checklist: encodeChecklist(checklist), presentation };
}

const taskArgument = {
  description: 'The task (KEY-seq).',
  required: true,
} as const;

function itemAddCommand(ports: Ports) {
  return new Command('add', {
    description: "Add an open item to a task's checklist.",
    extensions: [
      helpCommand({
        examples: [
          {
            command: 'item add MMR-12 "Remove the retired --since hint from flag-owners"',
            note: 'a follow-up kept with its task',
          },
        ],
      }),
      mcpCommand({ annotations: writeHints }),
    ],
  })
    .argument('task', taskArgument)
    .argument('content', { description: 'The item, the rest of the line.', variadic: true })
    .option('ascii', asciiOption)
    .result<ItemEcho>({ views: itemEchoViews })
    .views({ records: itemEchoViews.records }, { default: 'records' })
    .action(async ({ args, host, options, out, passthrough }) => {
      const content = reasonWords(args.content, passthrough);
      if (content === '') {
        throw new MimirUsageError('item add requires content');
      }
      const task = nodeToken(ports.grammar, args.task, 'task');
      const checklist = await (await ports.engine()).itemAdd({ content, task });
      await out.results(
        echo(checklist, checklist.items.at(-1)?.number ?? 0, presentationOf(host, options.ascii)),
      );
    });
}

function itemCheckCommand(ports: Ports) {
  return new Command('check', {
    description: 'Check an open item: it is done, for good.',
    extensions: [
      helpCommand({ examples: [{ command: 'item check MMR-12 2', note: 'item 2 is done' }] }),
      mcpCommand({ annotations: writeHints }),
    ],
  })
    .argument('task', taskArgument)
    .argument('number', { description: 'The item number.', required: true })
    .option('ascii', asciiOption)
    .result<ItemEcho>({ views: itemEchoViews })
    .views({ records: itemEchoViews.records }, { default: 'records' })
    .action(async ({ args, host, options, out }) => {
      const number = itemNumber(args.number, 'check');
      const task = nodeToken(ports.grammar, args.task, 'task');
      const checklist = await (await ports.engine()).itemCheck({ number, task });
      await out.results(echo(checklist, number, presentationOf(host, options.ascii)));
    });
}

function itemDropCommand(ports: Ports) {
  return new Command('drop', {
    description: 'Drop an open item with a reason: it will not be done, for good.',
    extensions: [
      helpCommand({
        examples: [{ command: 'item drop MMR-12 3 "Covered by MMR-14"', note: 'with its reason' }],
      }),
      mcpCommand({ annotations: writeHints }),
    ],
  })
    .argument('task', taskArgument)
    .argument('number', { description: 'The item number.', required: true })
    .argument('words', { description: 'Why it is dropped, the rest of the line.', variadic: true })
    .option('reason', text('Why it is dropped, in place of the words after the number.'))
    .option('ascii', asciiOption)
    .result<ItemEcho>({ views: itemEchoViews })
    .views({ records: itemEchoViews.records }, { default: 'records' })
    .action(async ({ args, host, options, out, passthrough }) => {
      const number = itemNumber(args.number, 'drop');
      const reason = options.reason ?? reasonWords(args.words, passthrough);
      const task = nodeToken(ports.grammar, args.task, 'task');
      const checklist = await (await ports.engine()).itemDrop({ number, reason, task });
      await out.results(echo(checklist, number, presentationOf(host, options.ascii)));
    });
}

export function itemCommand(ports: Ports) {
  return new Command('item', {
    description: "Keep a task's checklist: items added, then checked or dropped.",
  })
    .command(itemAddCommand(ports))
    .command(itemCheckCommand(ports))
    .command(itemDropCommand(ports));
}

/**
 * `tag` and `untag`: add or remove tags on tasks, phases, initiatives,
 * projects, and artifacts.
 */
import { Command } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';

import { MimirUsageError } from '../failures';
import { splitCsv } from '../node-input';
import { asciiOption, writeHints } from '../options';
import type { Ports } from '../ports';
import { okLine, presentationOf } from '../render/presentation';
import { noticeViews } from '../render/writes';
import type { Notice } from '../render/writes';

type Tagging = {
  verb: 'tag' | 'untag';
  /** The past tense, which keys the JSON object and words the line. */
  done: 'tagged' | 'untagged';
  description: string;
  example: string;
};

const TAGGINGS: Record<Tagging['verb'], Tagging> = {
  tag: {
    description: 'Add tags to tasks, phases, initiatives, projects, or artifacts.',
    done: 'tagged',
    example: 'tag MMR-16,MMR-17 design review',
    verb: 'tag',
  },
  untag: {
    description: 'Remove tags from tasks, phases, initiatives, projects, or artifacts.',
    done: 'untagged',
    example: 'untag MMR-16 review',
    verb: 'untag',
  },
};

function taggingCommand(ports: Ports, tagging: Tagging) {
  return new Command(tagging.verb, {
    description: tagging.description,
    extensions: [
      helpCommand({ examples: [{ command: tagging.example, note: tagging.description }] }),
      mcpCommand({
        annotations: {
          ...writeHints,
          destructive: tagging.verb === 'untag',
          idempotent: true,
        },
      }),
    ],
  })
    .argument('ids', {
      description: 'The records: ids (KEY, KEY-seq, KEY-aN), comma-separated.',
      required: true,
    })
    .argument('tags', { description: 'The tags.', variadic: true })
    .option('ascii', asciiOption)
    .result<Notice>({ views: noticeViews })
    .views({}, { default: 'records' })
    .action(async ({ args, host, options, out, passthrough }) => {
      const ids = splitCsv(args.ids);
      if (ids.length === 0) {
        throw new MimirUsageError(`${tagging.verb} requires ids (comma-separated)`);
      }
      // Words after `--` are tags too, so a tag may lead with a dash.
      const given = [...args.tags, ...passthrough];
      if (given.length === 0) {
        throw new MimirUsageError(`${tagging.verb} requires at least one tag`);
      }
      const engine = await ports.engine();
      const { tags } = await engine[tagging.verb]({ ids, tags: given });
      await out.results({
        ids: ids.join('\n'),
        json: { [tagging.done]: { ids, tags } },
        line: okLine(
          presentationOf(host, options.ascii),
          `${tagging.done} ${ids.join(', ')}: ${tags.join(', ')}`,
        ),
      });
    });
}

export const tagCommand = (ports: Ports) => taggingCommand(ports, TAGGINGS.tag);
export const untagCommand = (ports: Ports) => taggingCommand(ports, TAGGINGS.untag);

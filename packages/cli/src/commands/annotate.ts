/**
 * `annotate <id> [text…]`: append a note to a task, phase, or initiative. The
 * text is the trailing words, else piped stdin.
 */
import { Command } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';

import { MimirUsageError } from '../failures';
import { contentText, nodeToken, withListHint } from '../node-input';
import { asciiOption, writeHints } from '../options';
import type { Ports } from '../ports';
import { presentationOf } from '../render/presentation';
import { nodeEcho, nodeEchoViews } from '../render/writes';
import type { NodeEcho } from '../render/writes';

export function annotateCommand(ports: Ports) {
  return new Command('annotate', {
    description: 'Append a note to a task, phase, or initiative.',
    extensions: [
      helpCommand({
        examples: [
          {
            command: 'annotate MMR-16 "Settled: one store per run."',
            note: 'note on a task',
          },
          {
            command: 'echo "long note" | mimir annotate MMR-16',
            note: 'the note from stdin',
          },
        ],
      }),
      mcpCommand({ annotations: writeHints }),
    ],
  })
    .argument('id', {
      description: 'The task, phase, or initiative (KEY-seq).',
      required: true,
    })
    .argument('text', {
      description: 'The note. Read from stdin when omitted.',
      variadic: true,
    })
    .stdin({ description: 'The note, when no text is given.' })
    .option('ascii', asciiOption)
    .result<NodeEcho>({ views: nodeEchoViews })
    .views({}, { default: 'records' })
    .action(async ({ args, host, options, out, passthrough, stdin }) => {
      // Words after `--` are text too, so a note may lead with a dash.
      const typed = [...args.text, ...passthrough].join(' ');
      const content =
        typed === '' ? (await contentText(stdin, host.terminal.stdin.isTTY)).trim() : typed;
      if (content === '') {
        throw new MimirUsageError('annotate requires content (positional or stdin)');
      }
      const id = nodeToken(ports.grammar, args.id);
      const engine = await ports.engine();
      const written = await withListHint([id], () => engine.annotate({ content, id }));
      await out.results(
        nodeEcho(ports, written, presentationOf(host, options.ascii), (rid) => `annotated ${rid}`),
      );
    });
}

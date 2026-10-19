/**
 * `depend` and `undepend`: add or remove the prerequisites a task, phase, or
 * initiative waits on.
 */
import { Command } from '@loomcli/core';
import { helpCommand, helpInput } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';

import { idList, nodeToken, requireIdToken, withListHint } from '../node-input';
import { asciiOption, writeHints } from '../options';
import type { Ports } from '../ports';
import { presentationOf } from '../render/presentation';
import { nodeEcho, nodeEchoViews } from '../render/writes';
import type { NodeEcho } from '../render/writes';

type Direction = {
  verb: 'depend' | 'undepend';
  /** What the command does, for its page and its MCP tool. */
  description: string;
  /** What the note says follows the id. */
  note: string;
  destructive: boolean;
  example: string;
};

const DIRECTIONS: Record<Direction['verb'], Direction> = {
  depend: {
    description: 'Make a task, phase, or initiative wait on the others named by --on.',
    destructive: false,
    example: 'depend MMR-18 --on MMR-16,MMR-17',
    note: 'now depends on',
    verb: 'depend',
  },
  undepend: {
    description: 'Stop a task, phase, or initiative waiting on the others named by --on.',
    destructive: true,
    example: 'undepend MMR-18 --on MMR-16',
    note: 'no longer depends on',
    verb: 'undepend',
  },
};

function dependenceCommand(ports: Ports, direction: Direction) {
  return new Command(direction.verb, {
    description: direction.description,
    extensions: [
      helpCommand({ examples: [{ command: direction.example, note: direction.description }] }),
      mcpCommand({ annotations: { ...writeHints, destructive: direction.destructive } }),
    ],
  })
    .argument('id', { description: 'The task, phase, or initiative (KEY-seq).', required: true })
    .option('on', {
      description: 'The prerequisites: ids, comma-separated.',
      extensions: [helpInput({ placeholder: 'ids' })],
      required: true,
      type: 'string',
    })
    .option('ascii', asciiOption)
    .result<NodeEcho>({ views: nodeEchoViews })
    .views({}, { default: 'records' })
    .action(async ({ args, host, options, out }) => {
      const id = nodeToken(ports.grammar, args.id);
      const on = options.on
        .split(',')
        .map((token) =>
          nodeToken(ports.grammar, requireIdToken(token, direction.verb, 'on').trim()),
        );
      const engine = await ports.engine();
      const written = await withListHint([id, ...on], () => engine[direction.verb]({ id, on }));
      await out.results(
        nodeEcho(
          ports,
          written,
          presentationOf(host, options.ascii),
          (rid) => `${rid} ${direction.note} ${idList(options.on)}`,
        ),
      );
    });
}

export const dependCommand = (ports: Ports) => dependenceCommand(ports, DIRECTIONS.depend);
export const undependCommand = (ports: Ports) => dependenceCommand(ports, DIRECTIONS.undepend);

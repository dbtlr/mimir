/**
 * `move` and `reorder`: where a node sits, under which parent and in what rank.
 */
import { Command } from '@loomcli/core';
import { helpCommand, helpInput } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';

import { nodeToken, requireIdToken, withListHint } from '../node-input';
import { asciiOption, writeHints } from '../options';
import type { Ports } from '../ports';
import { arrow, presentationOf } from '../render/presentation';
import { nodeEcho, nodeEchoViews } from '../render/writes';
import type { NodeEcho } from '../render/writes';

export function moveCommand(ports: Ports) {
  return new Command('move', {
    description: 'Move a task, phase, or initiative under another parent in its project.',
    extensions: [
      helpCommand({
        examples: [
          {
            command: 'move MMR-18 --to MMR-4',
            note: 're-parent a task under a phase',
          },
        ],
      }),
      mcpCommand({ annotations: writeHints }),
    ],
  })
    .argument('id', {
      description: 'The node to move (KEY-seq).',
      required: true,
    })
    .option('to', {
      description: 'The new parent.',
      extensions: [helpInput({ placeholder: 'id' })],
      required: true,
      type: 'string',
    })
    .option('ascii', asciiOption)
    .result<NodeEcho>({ views: nodeEchoViews })
    .views({}, { default: 'records' })
    .action(async ({ args, host, options, out }) => {
      const id = nodeToken(ports.grammar, args.id);
      const to = nodeToken(ports.grammar, requireIdToken(options.to, 'move', 'to'));
      const engine = await ports.engine();
      const written = await withListHint([id, to], () => engine.move({ id, to }));
      const presentation = presentationOf(host, options.ascii);
      await out.results(
        nodeEcho(
          ports,
          written,
          presentation,
          (rid) => `moved ${rid} ${arrow(presentation.plain)} ${to}`,
        ),
      );
    });
}

/** Where `reorder` puts the task: an end of its siblings, or beside another. */
type Place =
  | { position: 'top' | 'bottom'; where: string }
  | { position: 'before' | 'after'; ref: string; where: string };

export function reorderCommand(ports: Ports) {
  return new Command('reorder', {
    description: "Change a task's rank among its siblings.",
    extensions: [
      helpCommand({
        examples: [
          { command: 'reorder MMR-18 --top', note: 'first among its siblings' },
          {
            command: 'reorder MMR-18 --after MMR-16',
            note: 'just behind MMR-16',
          },
        ],
      }),
      mcpCommand({ annotations: writeHints }),
    ],
  })
    .argument('id', { description: 'The task (KEY-seq).', required: true })
    .option('top', { description: 'Make it first.', type: 'boolean' })
    .option('bottom', { description: 'Make it last.', type: 'boolean' })
    .option('before', {
      description: 'Put it just ahead of this sibling.',
      extensions: [helpInput({ placeholder: 'id' })],
      type: 'string',
    })
    .option('after', {
      description: 'Put it just behind this sibling.',
      extensions: [helpInput({ placeholder: 'id' })],
      type: 'string',
    })
    .option('ascii', asciiOption)
    .exclusive('top', 'bottom', 'before', 'after')
    .oneRequired('top', 'bottom', 'before', 'after')
    .result<NodeEcho>({ views: nodeEchoViews })
    .views({}, { default: 'records' })
    .action(async ({ args, host, options, out }) => {
      const id = nodeToken(ports.grammar, args.id, 'task');
      const place = placeOf(ports, options);
      const engine = await ports.engine();
      const tokens = 'ref' in place ? [id, place.ref] : [id];
      // The Engine answers a ref that is not there as "not in the rankable set";
      // a read first lets the caller learn it simply does not exist.
      if ('ref' in place) {
        await withListHint(tokens, () => engine.getNode({ facets: [], id: place.ref }));
      }
      const written = await withListHint(tokens, () =>
        engine.reorder(
          'ref' in place
            ? { id, position: place.position, ref: place.ref }
            : { id, position: place.position },
        ),
      );
      const presentation = presentationOf(host, options.ascii);
      await out.results(
        nodeEcho(
          ports,
          written,
          presentation,
          (rid) => `reordered ${rid} ${arrow(presentation.plain)} ${place.where}`,
        ),
      );
    });
}

/** The place the flags name; Loom has already ensured exactly one is given. */
function placeOf(
  ports: Ports,
  options: { top?: boolean; bottom?: boolean; before?: string; after?: string },
): Place {
  if (options.top === true) {
    return { position: 'top', where: 'top' };
  }
  if (options.bottom === true) {
    return { position: 'bottom', where: 'bottom' };
  }
  if (options.before !== undefined) {
    const ref = nodeToken(ports.grammar, requireIdToken(options.before, 'reorder', 'before'));
    return { position: 'before', ref, where: `before ${ref}` };
  }
  const ref = nodeToken(ports.grammar, requireIdToken(options.after ?? '', 'reorder', 'after'));
  return { position: 'after', ref, where: `after ${ref}` };
}

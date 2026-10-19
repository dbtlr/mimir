/**
 * `tree <id>`: the whole subtree under a node or project, children in rank
 * order, through the Engine's `tree` read.
 */
import { Command } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';
import { intentEncoders } from '@mimir/contract';
import type { TreeView } from '@mimir/contract';

import { asciiOption } from '../options';
import type { Ports } from '../ports';
import { presentationOf } from '../render/presentation';
import type { Presentation } from '../render/presentation';
import { renderTree } from '../render/report';
import { compactJson, prettyJson, recordViews } from '../render/views';

/** The subtree, its wire object, and how the styled views render it. */
export type TreeValue = {
  presentation: Presentation;
  tree: TreeView;
  wire: Record<string, unknown>;
};

const text = (value: Readonly<TreeValue>): string => renderTree(value.tree, value.presentation);

const views = recordViews<TreeValue>({
  ids: (value) => value.tree.id,
  json: (value) => prettyJson(value.wire),
  jsonl: (value) => compactJson(value.wire),
  records: text,
});

export function treeCommand(ports: Ports) {
  return new Command('tree', {
    description: 'Read the full subtree rooted at a node (KEY-seq) or project (KEY).',
    extensions: [
      helpCommand({
        examples: [
          { command: 'tree MMR', note: 'the full hierarchy under the project' },
          { command: 'tree MMR-3', note: 'the subtree rooted at a phase or initiative' },
        ],
      }),
      mcpCommand({ annotations: { openWorld: false, readOnly: true } }),
    ],
  })
    .argument('id', { description: 'KEY-seq or KEY.', required: true })
    .option('ascii', asciiOption)
    .result<TreeValue>({ views })
    .views({}, { default: 'records' })
    .action(async ({ args, host, options, out }) => {
      const engine = await ports.engine();
      const tree = intentEncoders.tree.parse(await engine.tree({ id: args.id }));
      await out.results({
        presentation: presentationOf(host, options.ascii),
        tree,
        wire: ports.wire.tree(tree),
      });
    });
}

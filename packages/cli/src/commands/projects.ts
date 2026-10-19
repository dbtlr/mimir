/**
 * `projects`: the projects themselves, key-ordered. They are the scope
 * dimension, so this is the one read that spans projects and the clone binding
 * never narrows it.
 */
import { Command } from '@loomcli/core';
import { helpCommand, helpInput } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';
import { intentEncoders } from '@mimir/contract';

import { asciiOption } from '../options';
import { parseProjectStatus } from '../parse';
import type { Ports } from '../ports';
import { nodeSetValue, nodeSetViews } from '../render/node-set';
import type { NodeSetValue } from '../render/node-set';
import { presentationOf } from '../render/presentation';

export function projectsCommand(ports: Ports) {
  return new Command('projects', {
    description: 'List the projects, key-ordered. The clone binding never narrows this read.',
    extensions: [
      helpCommand({
        examples: [
          { command: 'projects', note: 'every active project' },
          { command: 'projects --status archived', note: 'the archived shelf' },
          { command: 'projects --status all -f ids', note: 'every key taken, archived included' },
          { command: 'projects -f json', note: 'structured output for scripts' },
        ],
      }),
      mcpCommand({ annotations: { openWorld: false, readOnly: true } }),
    ],
  })
    .option('status', {
      description: 'The shelf: active (the default), archived, or all.',
      extensions: [helpInput({ placeholder: 'shelf' })],
      type: 'string',
    })
    .option('ascii', asciiOption)
    .result<NodeSetValue>({ views: nodeSetViews })
    .views({}, { default: 'table' })
    .action(async ({ host, options, out }) => {
      const shelf = parseProjectStatus(options.status);
      const engine = await ports.engine();
      const items = intentEncoders.nodes.parse(
        await engine.projects({ facets: ['distribution', 'tags'], status: shelf }),
      );
      const result = { items, returned: items.length, startsAt: 0, total: items.length };
      await out.results(
        nodeSetValue(
          ports,
          result,
          presentationOf(host, options.ascii),
          'project',
          shelf === 'archived' ? 'No archived projects' : 'No projects',
        ),
      );
    });
}

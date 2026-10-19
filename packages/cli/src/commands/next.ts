/**
 * `next`: the ready tasks of one project, in rank order, through the Engine's
 * `next` read and the shared query grammar.
 */
import { Command } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';

import { asciiOption, colOption, scopeOption, tzOption } from '../options';
import type { Ports } from '../ports';
import { filterOptions, nodeQueryOptions, readNodeSet } from '../query';
import { nodeSetViews } from '../render/node-set';
import type { NodeSetValue } from '../render/node-set';

const filters = filterOptions('tasks');

export function nextCommand(ports: Ports) {
  return new Command('next', {
    description: 'List the ready tasks of one project in rank order.',
    extensions: [
      helpCommand({
        examples: [
          { command: 'next -s MMR', note: 'what to work on next in project MMR' },
          { command: 'next -q auth', note: 'ready tasks whose titles contain auth' },
          { command: 'next -p p0', note: 'the highest-priority ready tasks' },
          { command: 'next --format json', note: 'structured output for scripts' },
        ],
      }),
      mcpCommand({ annotations: { openWorld: false, readOnly: true } }),
    ],
  })
    .option('scope', scopeOption)
    .option('query', nodeQueryOptions.query)
    .option('priority', nodeQueryOptions.priority)
    .option('size', nodeQueryOptions.size)
    .option('is', filters.is)
    .option('not-is', filters['not-is'])
    .option('eq', filters.eq)
    .option('not-eq', filters['not-eq'])
    .option('in', filters.in)
    .option('not-in', filters['not-in'])
    .option('has', filters.has)
    .option('missing', filters.missing)
    .option('before', filters.before)
    .option('on', filters.on)
    .option('after', filters.after)
    .option('at-or-before', filters['at-or-before'])
    .option('at-or-after', filters['at-or-after'])
    .option('tz', tzOption)
    .option('limit', nodeQueryOptions.limit)
    .option('col', colOption)
    .option('ascii', asciiOption)
    .result<NodeSetValue>({ views: nodeSetViews })
    .views({}, { default: 'table' })
    .action(({ host, options, out }) =>
      readNodeSet(
        ports,
        { host, options, out },
        'next',
        (project) =>
          `No ready tasks in ${project} — mimir list --status awaiting -s ${project} shows what's queued`,
        (query) => (engine, project) => engine.next({ ...query, project }),
      ),
    );
}

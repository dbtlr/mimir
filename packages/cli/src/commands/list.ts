/**
 * `list`: a broad selection of one project's nodes by predicate or tag,
 * through the Engine's `list` read and the shared query grammar.
 */
import { Command } from '@loomcli/core';
import { helpCommand, helpInput } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';

import { asciiOption, colOption, scopeOption, tzOption } from '../options';
import { parseStatus } from '../parse';
import type { Ports } from '../ports';
import { filterOptions, nodeQueryOptions, readNodeSet } from '../query';
import { nodeSetViews } from '../render/node-set';
import type { NodeSetValue } from '../render/node-set';

const filters = filterOptions('tasks');

export function listCommand(ports: Ports) {
  return new Command('list', {
    description: 'Select the nodes of one project by predicate, status, or tag.',
    extensions: [
      helpCommand({
        examples: [
          { command: 'list --is stale', note: 'tasks that have gone quiet' },
          { command: 'list -q auth', note: 'title or id substring' },
          { command: 'list --status done --after completed_at:2026-06-01' },
          { command: 'list --on created_at:2026-06-10 --tz UTC', note: 'a UTC calendar day' },
          { command: 'list --eq type:phase', note: 'filter to phases' },
          { command: 'list -s MMR --is stale', note: 'a named project, ignoring the binding' },
        ],
      }),
      mcpCommand({ annotations: { openWorld: false, readOnly: true } }),
    ],
  })
    .option('status', {
      description: 'The universe: ready, in_progress, …, done, or all. Defaults to live.',
      extensions: [helpInput({ placeholder: 'word' })],
      type: 'string',
    })
    .option('scope', scopeOption)
    .option('query', nodeQueryOptions.query)
    .option('tag', {
      description: 'Only nodes carrying this tag.',
      extensions: [helpInput({ placeholder: 'tag' })],
      short: 't',
      type: 'string',
    })
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
    .option('priority', nodeQueryOptions.priority)
    .option('size', nodeQueryOptions.size)
    .option('limit', nodeQueryOptions.limit)
    .option('col', colOption)
    .option('ascii', asciiOption)
    .result<NodeSetValue>({ views: nodeSetViews })
    .views({ table: nodeSetViews.table }, { default: 'table' })
    .action(({ host, options, out }) =>
      readNodeSet(
        ports,
        { host, options, out },
        'list',
        () => 'No tasks match — try --status all, or drop a filter',
        (query) => {
          const status = parseStatus(options.status);
          return (engine, project) => engine.list({ ...query, project, status, tag: options.tag });
        },
      ),
    );
}

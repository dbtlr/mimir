/**
 * `triage [KEY]`: the explicit reconciliation pass over one board's seeds. It
 * writes the upstream-resolution annotations unless `--dry-run` previews them.
 */
import { Command } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';
import { intentEncoders } from '@mimir/contract';

import { defaultFormat } from '../default-format';
import { asciiOption, scopeOption, writeHints } from '../options';
import type { Ports } from '../ports';
import { presentationOf } from '../render/presentation';
import { triageViews } from '../render/seeds';
import type { TriageValue } from '../render/seeds';
import { boundProject, targetProject } from '../scope';

export function triageCommand(ports: Ports) {
  return new Command('triage', {
    description:
      "Reconcile a board's seeds: list the untriaged and ready-to-resolve ones, and annotate the tasks whose upstream seed settled. A report, never a gate.",
    extensions: [
      helpCommand({
        examples: [
          {
            command: 'triage',
            note: "the bound project's pass, annotations written; records on a terminal, json when piped",
          },
          { command: 'triage XX --dry-run', note: 'preview another project, write nothing' },
        ],
      }),
      // A pass without --dry-run writes annotations, so it is not read-only.
      mcpCommand({ annotations: writeHints }),
      defaultFormat({ piped: 'json', terminal: 'records' }),
    ],
  })
    .argument('board', { description: 'The project to reconcile. Defaults to the clone binding.' })
    .option('dry-run', {
      description: 'Preview what would be annotated; write nothing.',
      type: 'boolean',
    })
    .option('scope', {
      ...scopeOption,
      description: 'The project to reconcile. Defaults to the clone binding.',
    })
    .option('ascii', asciiOption)
    .result<TriageValue>({ views: triageViews })
    .views({}, { default: 'records' })
    .action(async ({ args, host, options, out }) => {
      const notify = (line: string): void => {
        void out.print(line);
      };
      const raw = args.board;
      const bound =
        raw === undefined ? await boundProject(ports, options.scope, notify) : undefined;
      const named = (raw ?? bound)?.trim();
      const board = targetProject(named === '' ? undefined : named, undefined, {
        hint: 'pass a KEY or bind a board first (mimir bind KEY)',
        message: 'triage requires a board',
      });
      const engine = await ports.engine();
      const report = intentEncoders.triageReport.parse(
        await engine.triage({ board, dryRun: options['dry-run'] }),
      );
      await out.results({
        presentation: presentationOf(host, options.ascii),
        report,
        wire: ports.wire.triage(report),
      });
    });
}

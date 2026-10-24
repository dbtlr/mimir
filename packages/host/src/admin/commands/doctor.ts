/**
 * `doctor`: the record-health facet the console's Record-health panel reads,
 * from the host's own store. Like `mimir doctor` it is non-gating (ADR 0017):
 * a finished scan exits 0 whatever it found.
 */
import { Command } from '@loomcli/core';
import { helpCommand, helpInput } from '@loomcli/plugins/help/extension';
import { defaultFormat } from '@mimir/cli/src/default-format';
import { proseViews } from '@mimir/cli/src/render/machine';
import { countLine, okLine, presentationOf, warnGlyph } from '@mimir/cli/src/render/presentation';
import type { Presentation } from '@mimir/cli/src/render/presentation';
import type { DoctorFacet } from '@mimir/core';

import type { AdminPorts } from '../ports';

type DoctorValue = { facet: DoctorFacet; presentation: Presentation };

function doctorText({ facet, presentation }: Readonly<DoctorValue>): string {
  if (facet.finding_total === 0) {
    return okLine(presentation, 'doctor: no problems found');
  }
  return facet.groups
    .flatMap((group) => [
      `${group.project}  ${countLine(group.finding_count, 'finding')}`,
      ...group.records.map(
        (record) =>
          `  ${record.severity}  ${record.id}  ${record.cause}  ${record.locator}  ${record.note}`,
      ),
    ])
    .join('\n');
}

export function doctorCommand(ports: AdminPorts) {
  const views = proseViews<DoctorValue>(doctorText, {
    json: ({ facet }) => facet,
    jsonl: 'compact',
  });
  return new Command('doctor', {
    description:
      "Report the host store's record health, the findings the console's Record-health panel shows. Non-gating: exits 0 after a successful scan. Prints prose on a terminal and json when piped.",
    extensions: [
      defaultFormat({ piped: 'json', terminal: 'records' }),
      helpCommand({
        examples: [
          { command: 'doctor', note: 'every project' },
          { command: 'doctor -s MMR -f json', note: 'one project, as the facet' },
        ],
      }),
    ],
  })
    .option('scope', {
      description: 'Limit to a project.',
      extensions: [helpInput({ placeholder: 'KEY' })],
      short: 's',
      type: 'string',
    })
    .result<DoctorValue>({ views })
    .views({ records: views.records }, { default: 'records' })
    .action(async ({ host, options, out }) => {
      const facet = await ports.doctor(options.scope);
      const presentation = presentationOf(host, false);
      if (facet.scope?.matched_records === 0) {
        await out.print(
          `${warnGlyph(presentation.plain)} doctor scope '${facet.scope.key}' matched 0 records`,
        );
      }
      await out.results({ facet, presentation });
    });
}

/**
 * `doctor`: report read-only local store or remote client diagnostics.
 * The composition root supplies the checks; this command renders,
 * warns on an empty scope, and keeps the non-gating contract (ADR 0017): a
 * finished run exits 0 whatever it found, and only a diagnosis that cannot be
 * read fails. In a terminal the findings print on stderr and a clean run one
 * line on stdout; `json` and `jsonl` carry the findings on stdout.
 */
import { Command } from '@loomcli/core';
import { helpCommand, helpInput } from '@loomcli/plugins/help/extension';

import { defaultFormat } from '../default-format';
import type { Diagnosis } from '../machine';
import type { Ports } from '../ports';
import { proseViews } from '../render/machine';
import { okLine, presentationOf, warnGlyph } from '../render/presentation';
import type { Presentation } from '../render/presentation';
import { compactJson, prettyJson } from '../render/views';

/** The diagnosis and how this invocation styles it. */
export type DoctorValue = { diagnosis: Diagnosis; presentation: Presentation };

const views = proseViews(
  ({ diagnosis, presentation }: Readonly<DoctorValue>) =>
    diagnosis.findings.length === 0 ? okLine(presentation, 'doctor: no problems found') : '',
  ({ diagnosis }) => prettyJson(diagnosis.findings),
  // One finding per line, the NDJSON contract every Mimir surface honors.
  ({ diagnosis }) => diagnosis.findings.map((finding) => compactJson(finding)).join('\n'),
);

export function doctorCommand(ports: Ports) {
  return new Command('doctor', {
    description:
      'Run read-only diagnostics: local store health, or remote config, credentials, host reachability, version, and token checks. Remote record health is checked with mimir-host doctor. Non-gating: findings exit 0. Prints prose on a terminal and json when piped.',
    extensions: [
      defaultFormat({ piped: 'json', terminal: 'records' }),
      helpCommand({
        examples: [
          {
            command: 'doctor',
            note: 'check the bound project; findings are output, not the status',
          },
          { command: 'doctor -s all -f json', note: 'every project, as a findings array' },
        ],
      }),
    ],
  })
    .option('scope', {
      description:
        'Limit local store checks to a project. Defaults to the clone binding; all checks every project. Remote client checks are install-wide.',
      extensions: [helpInput({ placeholder: 'KEY|all' })],
      short: 's',
      type: 'string',
    })
    .result<DoctorValue>({ views })
    .views({}, { default: 'records' })
    .action(async ({ host, options, out }) => {
      // Git config only: resolving from the origin would open the store outside
      // the backend's error handling, which doctor relies on to report a down store.
      const scope =
        ports.machine.doctor.scope === 'install' || options.scope === 'all'
          ? undefined
          : (options.scope ?? (await ports.machine.binding.configured()));
      const diagnosis = await ports.machine.doctor.diagnose(scope);
      const presentation = presentationOf(host, false);
      const { scope: match } = diagnosis;
      if (match?.matched_records === 0) {
        await out.print(
          `${warnGlyph(presentation.plain)} doctor scope '${match.key}' matched 0 records`,
        );
      }
      // Findings are the loud channel: each on stderr, tagged by its informational
      // severity. Under json and jsonl they fill stdout alone, so a merged stream stays parseable.
      const view =
        Reflect.get(options, 'format') ?? (host.terminal.stdout.isTTY ? 'records' : 'json');
      if (view !== 'json' && view !== 'jsonl') {
        for (const check of diagnosis.passed ?? []) {
          await out.print(okLine(presentation, check));
        }
        for (const line of diagnosis.lines) {
          await out.print(line);
        }
        if (diagnosis.guidance !== undefined) {
          await out.print(diagnosis.guidance);
        }
      }
      await out.results({ diagnosis, presentation });
    });
}

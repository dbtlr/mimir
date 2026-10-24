/**
 * `version`: the running build's version, bare, whatever the format. The
 * release workflow stamps the version into the build; a source run reports the
 * package's. `json` and `jsonl` print it bare too, as the old main answered
 * `version` before any format was read. The old binary's `--version` flag alias
 * is a deliberate difference: Loom 0.13 has no root flag hook, so `mimir
 * --version` is an unknown option (exit 2) and `mimir version` is the one spelling.
 */
import { Command } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';

import type { Ports } from '../ports';
import { textView } from '../render/views';

const text = textView(({ version }: Readonly<{ version: string }>) => version);

export function versionCommand(ports: Ports) {
  return new Command('version', {
    description: 'Print the version of this build.',
    extensions: [helpCommand({ examples: [{ command: 'version', note: 'for example 0.26.0' }] })],
  })
    .result<{ version: string }>({
      views: { ids: text, json: text, jsonl: text, records: text, table: text },
    })
    .views({ records: text }, { default: 'records' })
    .action(async ({ out }) => {
      await out.results({ version: ports.machine.version });
    });
}

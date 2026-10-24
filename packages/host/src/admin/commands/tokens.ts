/** `tokens`: the device tokens the host has issued, active ones unless `--all`. */
import { Command } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';
import { defaultFormat } from '@mimir/cli/src/default-format';
import { presentationOf } from '@mimir/cli/src/render/presentation';
import type { Presentation } from '@mimir/cli/src/render/presentation';
import { compactJson, prettyJson, recordViews } from '@mimir/cli/src/render/views';
import type { DeviceToken } from '@mimir/core';

import type { AdminPorts } from '../ports';
import { columns, instant } from '../render';

type TokensValue = { tokens: DeviceToken[]; all: boolean; presentation: Presentation };

function tokensText({ all, presentation, tokens }: Readonly<TokensValue>): string {
  if (tokens.length === 0) {
    return all ? 'No device tokens' : 'No paired devices';
  }
  const zone = presentation.zone;
  return columns(
    ['USER', 'DEVICE', 'CREATED', 'LAST USED', 'REVOKED'],
    tokens.map((token) => [
      token.user,
      token.device,
      instant(token.created_at, zone),
      instant(token.last_used_at, zone),
      instant(token.revoked_at, zone),
    ]),
  );
}

export function tokensCommand(ports: AdminPorts) {
  const views = recordViews<TokensValue>({
    json: ({ tokens }) => prettyJson(tokens),
    jsonl: ({ tokens }) => tokens.map((token) => compactJson(token)).join('\n'),
    records: tokensText,
  });
  return new Command('tokens', {
    description:
      'List the device tokens: user, device, created, last used, and revoked. Active tokens only unless --all. Prints a table on a terminal and json when piped.',
    extensions: [
      defaultFormat({ piped: 'json', terminal: 'table' }),
      helpCommand({
        examples: [
          { command: 'tokens', note: 'the paired devices' },
          { command: 'tokens --all', note: 'revoked and rotated tokens too' },
        ],
      }),
    ],
  })
    .option('all', { description: 'Include revoked tokens.', type: 'boolean' })
    .result<TokensValue>({ views })
    .views({ table: views.table }, { default: 'table' })
    .action(async ({ host, options, out }) => {
      const tokens = await (await ports.tokens()).list({ all: options.all });
      await out.results({ all: options.all, presentation: presentationOf(host, false), tokens });
    });
}

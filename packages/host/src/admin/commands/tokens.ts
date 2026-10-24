/** `tokens`: the device tokens the host has issued, active ones unless `--all`. */
import { Command } from '@loomcli/core';
import type { View } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';
import { table } from '@loomcli/plugins/table';
import { defaultFormat } from '@mimir/cli/src/default-format';
import { presentationOf } from '@mimir/cli/src/render/presentation';
import type { Presentation } from '@mimir/cli/src/render/presentation';
import { jsonViews } from '@mimir/cli/src/render/views';
import type { DeviceToken } from '@mimir/core';
import { formatDay } from '@mimir/helpers';

import type { AdminPorts } from '../ports';
import { span } from '../render';

type TokensValue = {
  tokens: DeviceToken[];
  all: boolean;
  now: Date;
  presentation: Presentation;
};

type TokenRow = { device: string; user: string; lastUsed: string; paired: string; revoked: string };

const ACTIVE_COLUMNS = [
  { header: 'DEVICE', key: 'device' },
  { header: 'USER', key: 'user' },
  { header: 'LAST USED', key: 'lastUsed' },
  { header: 'PAIRED', key: 'paired' },
] as const;

/** `--all` adds the revoked date; without it every row would read the same `-`. */
const activeTable = table<TokenRow>({ columns: ACTIVE_COLUMNS });
const allTable = table<TokenRow>({
  columns: [...ACTIVE_COLUMNS, { header: 'REVOKED', key: 'revoked' }],
});

function tokenRow(token: DeviceToken, now: Date, zone: string): TokenRow {
  return {
    device: token.device,
    lastUsed:
      token.last_used_at === null
        ? 'never'
        : `${span(now.getTime() - Date.parse(token.last_used_at))} ago`,
    paired: formatDay(token.created_at, zone),
    revoked: token.revoked_at === null ? '-' : formatDay(token.revoked_at, zone),
    user: token.user,
  };
}

/** The tokens as a Loom table, or the line that says there are none. */
const tokensTable: View<TokensValue> = {
  render: ({ all, now, presentation, tokens }, context) => {
    if (tokens.length === 0) {
      return context.style.escape(all ? 'No device tokens\n' : 'No paired devices\n');
    }
    const rows = tokens.map((token) => tokenRow(token, now, presentation.zone));
    return (all ? allTable : activeTable).render(rows, context);
  },
};

export function tokensCommand(ports: AdminPorts) {
  const views = {
    ...jsonViews<TokensValue>({ json: ({ tokens }) => tokens, jsonl: ({ tokens }) => tokens }),
    records: tokensTable,
    table: tokensTable,
  };
  return new Command('tokens', {
    description:
      'List the device tokens: device, user, last use, and pairing date, plus the revoked date under --all. Active tokens only unless --all. Prints a table on a terminal and json when piped.',
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
      await out.results({
        all: options.all,
        now: ports.now(),
        presentation: presentationOf(host, false),
        tokens,
      });
    });
}

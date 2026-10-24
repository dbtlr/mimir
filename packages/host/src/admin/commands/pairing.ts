/**
 * Pairing administration (ADR 0038 and its 2026-10-20 addendum): a client
 * files a request and shows its code, and the operator decides it here.
 * `pending` lists the live requests, `approve` and `deny` decide one by the
 * code its client shows, and `unpair` revokes a device. Codes are stored
 * hashed, so the operator reads them from the client, never from the host.
 */
import { Command } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';
import { defaultFormat } from '@mimir/cli/src/default-format';
import { MimirUsageError } from '@mimir/cli/src/failures';
import { proseViews } from '@mimir/cli/src/render/machine';
import {
  countLine,
  dimmed,
  noteLabel,
  okLine,
  presentationOf,
} from '@mimir/cli/src/render/presentation';
import type { Presentation } from '@mimir/cli/src/render/presentation';
import { compactJson, prettyJson, recordViews } from '@mimir/cli/src/render/views';
import { MimirError } from '@mimir/contract';
import { formatPairingCode, normalizePairingCode } from '@mimir/core';
import type { PendingPairing } from '@mimir/core';

import type { AdminPorts } from '../ports';
import { columns, span } from '../render';

// ---------------------------------------------------------------------------
// pending
// ---------------------------------------------------------------------------

type PendingValue = { requests: PendingPairing[]; now: Date; presentation: Presentation };

function pendingText({ now, presentation, requests }: Readonly<PendingValue>): string {
  if (requests.length === 0) {
    return 'No pending pairing requests';
  }
  const table = columns(
    ['DEVICE', 'REQUESTED', 'EXPIRES'],
    requests.map((request) => [
      request.device,
      `${span(now.getTime() - Date.parse(request.created_at))} ago`,
      `in ${span(Date.parse(request.expires_at) - now.getTime())}`,
    ]),
  );
  return presentation.isTTY
    ? `${table}\n\n${dimmed("approve one with 'mimir-host approve <code>', using the code its device shows", presentation.plain)}`
    : table;
}

export function pendingCommand(ports: AdminPorts) {
  const views = recordViews<PendingValue>({
    json: ({ requests }) => prettyJson(requests),
    jsonl: ({ requests }) => requests.map((request) => compactJson(request)).join('\n'),
    records: pendingText,
  });
  return new Command('pending', {
    description:
      'List the live pairing requests awaiting a decision: device, age, and expiry. Prints a table on a terminal and json when piped.',
    extensions: [
      defaultFormat({ piped: 'json', terminal: 'table' }),
      helpCommand({ examples: [{ command: 'pending', note: 'who is asking to pair' }] }),
    ],
  })
    .result<PendingValue>({ views })
    .views({ table: views.table }, { default: 'table' })
    .action(async ({ host, out }) => {
      const requests = await (await ports.tokens()).listPending();
      await out.results({ now: ports.now(), presentation: presentationOf(host, false), requests });
    });
}

// ---------------------------------------------------------------------------
// approve, deny
// ---------------------------------------------------------------------------

/** The code as the client prints it, or a usage error for a string that is no code. */
function codeOf(input: string): string {
  const code = normalizePairingCode(input);
  if (code === null) {
    throw new MimirUsageError(
      `${input} is not a pairing code`,
      'a pairing code is eight letters and digits, shown by the device as XXXX-XXXX',
    );
  }
  return formatPairingCode(code);
}

function noLiveRequest(code: string): MimirError {
  return new MimirError(
    'not_found',
    `no live pairing request matches ${code}`,
    "check the code the device shows; 'mimir-host pending' lists the requests awaiting a decision, and a request leaves it once decided",
  );
}

type Decision = { device: string; rotates?: boolean };
type DecisionValue = { decision: Decision; verb: string; presentation: Presentation };

const decisionViews = proseViews(
  ({ decision, presentation, verb }: Readonly<DecisionValue>) => {
    const line = okLine(presentation, `${verb} ${decision.device}`);
    return decision.rotates === true
      ? `${line}\n${noteLabel(presentation.plain)} ${decision.device}'s current token stops working when it collects the new one`
      : line;
  },
  ({ decision }) => compactJson(decision),
);

const codeArgument = {
  description: 'The code the device shows, as XXXX-XXXX; case and the hyphen are optional.',
  required: true,
} as const;

export function approveCommand(ports: AdminPorts) {
  return new Command('approve', {
    description:
      'Approve a pairing request by the code its device shows. The device collects its token on its next poll, which replaces any token it holds.',
    extensions: [
      defaultFormat({ piped: 'json', terminal: 'records' }),
      helpCommand({ examples: [{ command: 'approve K7QM-2P9D', note: 'let the device pair' }] }),
    ],
  })
    .argument('code', codeArgument)
    .result<DecisionValue>({ views: decisionViews })
    .views({ records: decisionViews.records }, { default: 'records' })
    .action(async ({ args, host, out }) => {
      const code = codeOf(args.code);
      const decision = await (await ports.tokens()).approve(code);
      if (decision === null) {
        throw noLiveRequest(code);
      }
      await out.results({ decision, presentation: presentationOf(host, false), verb: 'approved' });
    });
}

export function denyCommand(ports: AdminPorts) {
  return new Command('deny', {
    description:
      'Deny a pairing request by the code its device shows, or withdraw an approval the device has not collected.',
    extensions: [
      defaultFormat({ piped: 'json', terminal: 'records' }),
      helpCommand({ examples: [{ command: 'deny K7QM-2P9D', note: 'refuse the request' }] }),
    ],
  })
    .argument('code', codeArgument)
    .result<DecisionValue>({ views: decisionViews })
    .views({ records: decisionViews.records }, { default: 'records' })
    .action(async ({ args, host, out }) => {
      const code = codeOf(args.code);
      const decision = await (await ports.tokens()).deny(code);
      if (decision === null) {
        throw noLiveRequest(code);
      }
      await out.results({ decision, presentation: presentationOf(host, false), verb: 'denied' });
    });
}

// ---------------------------------------------------------------------------
// unpair
// ---------------------------------------------------------------------------

type Unpaired = { device: string; tokens: number; requests: number };
type UnpairValue = { unpaired: Unpaired; presentation: Presentation };

const unpairViews = proseViews(
  ({ presentation, unpaired }: Readonly<UnpairValue>) => {
    const parts = [
      ...(unpaired.tokens > 0 ? [`${countLine(unpaired.tokens, 'token')} revoked`] : []),
      ...(unpaired.requests > 0 ? [`${countLine(unpaired.requests, 'request')} discarded`] : []),
    ];
    return okLine(presentation, `unpaired ${unpaired.device} (${parts.join(', ')})`);
  },
  ({ unpaired }) => compactJson(unpaired),
);

export function unpairCommand(ports: AdminPorts) {
  return new Command('unpair', {
    description:
      "Revoke a device's token and discard its pairing requests. The token's row stays, marked revoked.",
    extensions: [
      defaultFormat({ piped: 'json', terminal: 'records' }),
      helpCommand({ examples: [{ command: 'unpair laptop', note: 'the device must pair again' }] }),
    ],
  })
    .argument('device', { description: 'The device name it paired with.', required: true })
    .result<UnpairValue>({ views: unpairViews })
    .views({ records: unpairViews.records }, { default: 'records' })
    .action(async ({ args, host, out }) => {
      const removed = await (await ports.tokens()).revoke(args.device);
      if (removed.tokens === 0 && removed.requests === 0) {
        throw new MimirError(
          'not_found',
          `no active token or pairing request for ${args.device}`,
          "'mimir-host tokens' lists the paired devices",
        );
      }
      await out.results({
        presentation: presentationOf(host, false),
        unpaired: { device: args.device, ...removed },
      });
    });
}

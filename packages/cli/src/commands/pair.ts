/**
 * `pair [url]`: connect this machine to a host (ADR 0038). It files a pairing
 * request, shows the code the operator approves on the host, waits for the
 * decision, and only then writes the device credentials and `[host] url`. A
 * denied, expired, cancelled, or failed run writes nothing. It is machine-local
 * and never builds the Engine, so it repairs a broken `[host]` or credentials
 * file. It asks questions only in a terminal; `--yes` and `--no-input` give
 * every question an answer, so a scripted run never blocks.
 */
import { Command, FatalError } from '@loomcli/core';
import type { StandardSchemaV1 } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';
import { confirm, progress, text as ask } from '@loomcli/prompts';
import { MimirError } from '@mimir/contract';
import { formatInstant } from '@mimir/helpers';

import { MimirUsageError } from '../failures';
import type { LocalBoard, Pairing, PairingFiled, PairingHost } from '../machine';
import { text } from '../options';
import type { Ports } from '../ports';
import { proseViews } from '../render/machine';
import { okLine, presentationOf, warnGlyph } from '../render/presentation';
import type { Presentation } from '../render/presentation';
import { compactJson, prettyJson } from '../render/views';

/** What a finished pairing reports. */
export type PairValue = {
  device: string;
  origin: string;
  hostVersion: string;
  presentation: Presentation;
};

const views = proseViews(
  ({ device, hostVersion, origin, presentation }: Readonly<PairValue>) =>
    okLine(presentation, `paired as ${device} with ${origin} (host ${hostVersion})`),
  ({ device, hostVersion, origin }) => prettyJson({ device, host_version: hostVersion, origin }),
  ({ device, hostVersion, origin }) => compactJson({ device, host_version: hostVersion, origin }),
);

/**
 * The device name a machine pairs as when `--device` is absent: its hostname's
 * first DNS label, lowercased. Empty when the hostname has no label.
 */
export function deviceFromHostname(hostname: string): string {
  return (hostname.trim().split('.')[0] ?? '').toLowerCase();
}

/** `HH:MM` of an instant (epoch milliseconds) in `zone`. */
function clockTime(at: number, zone: string): string {
  return formatInstant(at, zone).split(' ')[1] ?? '';
}

/** What the host's own words about a request's life are taken to mean when it states none. */
const DEFAULT_LIFETIME_MS = 10 * 60 * 1000;
/** How long past its expiry the local deadline lets a failing connection retry. */
const DEADLINE_MARGIN_MS = 5000;
/** How long past the deadline a host that keeps answering `pending` is waited on before giving up. */
const PENDING_MARGIN_MS = 60_000;

/**
 * How long the host says the request has left, by the host's own clock: its
 * `expires_at` less its `Date` at filing. Without a usable pair of those, or
 * with an answer that makes no sense, the request is taken to last the
 * default ten minutes. The local clock plays no part, so skew cannot shorten
 * or lengthen the wait.
 */
function remainingMs(filed: PairingFiled): number {
  const expires = Date.parse(filed.expiresAt);
  if (filed.hostNow === undefined || Number.isNaN(expires)) {
    return DEFAULT_LIFETIME_MS;
  }
  const left = expires - filed.hostNow;
  return left > 0 && left <= 24 * 60 * 60 * 1000 ? left : DEFAULT_LIFETIME_MS;
}

/** File the request. The host's own words in a refusal are shown as text, never as marks. */
async function fileRequest(
  pairing: Pairing,
  origin: string,
  device: string,
  escape: (text: string) => string,
): Promise<PairingFiled> {
  try {
    return await pairing.file(origin, device);
  } catch (error) {
    if (error instanceof MimirError) {
      throw new MimirError(error.code, escape(error.message), error.hint);
    }
    throw error;
  }
}

/** A Standard Schema value that accepts a host URL and answers its origin. */
function hostUrl(origin: Pairing['origin']): StandardSchemaV1<string, string> {
  return {
    '~standard': {
      validate: (value) => {
        const found = typeof value === 'string' ? origin(value.trim()) : undefined;
        return found === undefined
          ? { issues: [{ message: 'Enter an http or https URL, such as http://host:64647.' }] }
          : { value: found };
      },
      vendor: 'mimir',
      version: 1,
    },
  };
}

const AGAIN = 'run mimir pair again';

const expired = (device: string): MimirError =>
  new MimirError(
    'invariant',
    `the pairing request for ${device} expired before the host approved it`,
    AGAIN,
  );

/** The request lapsed after a poll failed: the host may have minted the token for an answer that never arrived. */
const maybeCollected = (device: string): MimirError =>
  new MimirError(
    'invariant',
    `the pairing request for ${device} expired after a connection failure: the approval may have been collected before the connection failed`,
    `unpair ${device} on the host (mimir-host unpair ${device}) and run mimir pair again`,
  );

/** The refusal for a config that owns a local board: pairing would leave it behind. */
function storeRefusal(configFile: string, origin: string): MimirError {
  return new MimirError(
    'invariant',
    `${configFile} declares [store]: this install owns a local board, and pairing would leave it behind`,
    `export the board (mimir store export board.json), import it on the host (mimir-host store import - --apply < board.json, inside the host container), remove [store] from ${configFile}, then run mimir pair ${origin}`,
  );
}

/** The refusal for a default install whose SQLite store holds work, or may: pairing would leave it behind. */
function localBoardRefusal(sqliteFile: string, board: LocalBoard, origin: string): MimirError {
  const holds =
    board.status === 'unreadable'
      ? `${sqliteFile} could not be read (${board.reason}) and may hold this install's local board`
      : `${sqliteFile} holds this install's local board`;
  return new MimirError(
    'invariant',
    `${holds}, and pairing would leave it behind`,
    `export the board (mimir store export board.json), import it on the host (mimir-host store import - --apply < board.json, inside the host container), then run mimir pair ${origin} --leave-local-board`,
  );
}

/** The refusal for a host whose window this build is outside; every outcome but `inside` has one. */
function windowRefusal(
  verdict: 'malformed' | 'below-minimum' | 'above-host',
  host: PairingHost,
  origin: string,
  version: string,
): MimirError {
  if (verdict === 'below-minimum') {
    return new MimirError(
      'invariant',
      `this CLI ${version} is older than the host at ${origin} supports (minimum ${host.minClient})`,
      'update this CLI',
    );
  }
  if (verdict === 'above-host') {
    return new MimirError(
      'invariant',
      `this CLI ${version} is newer than the host at ${origin} (${host.version})`,
      `update the host first, then run mimir pair ${origin}`,
    );
  }
  // The host's version string is its own text, so it is not echoed.
  return new MimirError(
    'invariant',
    `this CLI ${version} cannot be compared with the version the host at ${origin} reports`,
    'check that the URL names a mimir host, and update the host and this CLI to released versions',
  );
}

export function pairCommand(ports: Ports) {
  return new Command('pair', {
    description:
      'Pair this machine with a host: request approval, wait for the operator to approve it on the host, then save the device credentials and [host] url. Asks questions only in a terminal.',
    extensions: [
      helpCommand({
        examples: [
          { command: 'pair http://mimir.example:64647', note: 'pair as this machine' },
          { command: 'pair http://mimir.example:64647 --device laptop', note: 'pair under a name' },
          {
            command: 'pair http://mimir.example:64647 -y',
            note: 'replace another host without asking',
          },
          {
            command: 'pair http://mimir.example:64647 --leave-local-board',
            note: 'pair after moving the local board to the host',
          },
        ],
      }),
    ],
  })
    .argument('url', {
      description:
        "The host's http or https URL; only its origin is used. In a terminal, omit it to be asked.",
      required: false,
    })
    .option(
      'device',
      text("The name this machine pairs as. Defaults to the hostname's first label.", 'NAME'),
    )
    .option('yes', {
      description: 'Replace an existing pairing with another host without asking.',
      short: 'y',
      type: 'boolean',
    })
    .option('leave-local-board', {
      description:
        "Pair even though this install's local SQLite board holds work, leaving it behind.",
      type: 'boolean',
    })
    .result<PairValue>({ views })
    .views({ records: views.records }, { default: 'records' })
    .action(async (context) => {
      const { args, host, interactive, options, out, signal, style } = context;
      const pairing = ports.machine.pair;
      const presentation = presentationOf(host, false);
      const note = (line: string) => out.print(style.escape(line));
      const warn = (line: string) =>
        out.print(`${warnGlyph(presentation.plain)} ${style.escape(line)}`);

      let origin: string;
      if (args.url === undefined) {
        if (!interactive) {
          throw new MimirUsageError('pair needs the host URL', 'mimir pair <url>');
        }
        origin = await ask(context, { message: 'Host URL', validate: hostUrl(pairing.origin) });
      } else {
        const given = pairing.origin(args.url);
        if (given === undefined) {
          throw new MimirUsageError(
            `${args.url} is not an http or https URL`,
            'mimir pair http://host:64647',
          );
        }
        origin = given;
      }

      if (pairing.declaresStore()) {
        throw storeRefusal(pairing.configFile, origin);
      }
      // An install that already names a host left its local board behind when it first paired.
      if (!options['leave-local-board'] && pairing.previous() === undefined) {
        const board = await pairing.localBoard();
        if (board.status !== 'empty') {
          throw localBoardRefusal(pairing.sqliteFile, board, origin);
        }
      }

      // The config edit is checked now: once a request exists, a refusal would cost the operator an approval.
      pairing.preflight(origin);

      const hostHealth = await pairing.health(origin);
      const verdict = pairing.window(hostHealth);
      if (verdict !== 'inside') {
        throw windowRefusal(verdict, hostHealth, origin, ports.machine.version);
      }

      const device = options.device ?? deviceFromHostname(pairing.hostname());
      if (device === '') {
        throw new MimirUsageError(
          'this machine has no hostname to name the device by',
          'pass --device <name>',
        );
      }

      // Decided before the request is filed, so a declined run leaves nothing pending.
      const previous = pairing.previous();
      if (previous !== undefined && previous.origin !== origin) {
        // The old host knows this machine by the name it recorded, not necessarily the new one.
        const unpair = `unpair ${previous.device ?? device} on ${previous.origin} (mimir-host unpair ${previous.device ?? device})`;
        if (interactive && !options.yes) {
          const replace = await confirm(context, {
            default: false,
            message: `Replace the pairing with ${previous.origin}? Then ${unpair}`,
          });
          if (!replace) {
            throw new FatalError(`aborted: the pairing with ${previous.origin} is unchanged`);
          }
        }
        await warn(`replacing the pairing with ${previous.origin}; ${unpair}`);
      }

      const filed = await fileRequest(pairing, origin, device, style.escape);
      // The host's clock may differ from this one, so its stated expiry is read as a time
      // left, from its own `Date`, and counted from the moment the request was filed here.
      const lapsesAt = pairing.now() + remainingMs(filed);
      await announce(note, origin, filed, lapsesAt, presentation.zone);

      const waiting = progress(context, { label: 'Waiting for approval' });
      const approved = await waitForDecision(pairing, {
        filed,
        lapsesAt,
        onUnreachable: () =>
          warn(`host unreachable, still waiting until ${clockTime(lapsesAt, presentation.zone)}`),
        origin,
        signal,
      });
      if (approved.status === 'denied') {
        await waiting.fail('Denied');
        throw new MimirError(
          'invariant',
          `the host at ${origin} denied the pairing request for ${device}`,
          AGAIN,
        );
      }
      if (approved.status === 'expired') {
        await waiting.fail('Expired');
        throw approved.afterFailure ? maybeCollected(device) : expired(device);
      }
      await waiting.end('Approved');
      pairing.save({ device: approved.device, origin, token: approved.token });
      await out.results({
        device: approved.device,
        hostVersion: hostHealth.version,
        origin,
        presentation,
      });
    });
}

/** Tell the operator how to approve the request: the code, the command, the console link, and the expiry. */
async function announce(
  note: (line: string) => Promise<void>,
  origin: string,
  filed: PairingFiled,
  lapsesAt: number,
  zone: string,
): Promise<void> {
  await note(`pairing code ${filed.userCode}`);
  await note(`approve with mimir-host approve ${filed.userCode} on the host`);
  await note(`or open ${origin}/pair?code=${filed.userCode}`);
  await note(`the request expires at ${formatInstant(lapsesAt, zone)}`);
}

type Decision =
  | { status: 'denied' }
  | {
      status: 'expired';
      /** A poll failed before the host said expired, so an approval may have been collected unseen. */
      afterFailure: boolean;
    }
  | { status: 'approved'; device: string; token: string };

/**
 * Poll at the host's interval until it decides. While the host answers, only
 * its own `expired` and `denied` end the wait. A poll that cannot reach the
 * host is not a decision: the wait goes on, the first such failure is reported
 * once, and a local deadline (the host's stated time left, counted from here)
 * stops the retrying. A definite failure is thrown by the poll. An approval is
 * never discarded: collecting the token revoked the device's earlier one on the
 * host, so it is returned even if the run was cancelled while the poll was in flight.
 */
async function waitForDecision(
  pairing: Pairing,
  wait: {
    filed: PairingFiled;
    origin: string;
    signal: AbortSignal;
    /** Local epoch milliseconds the request lapses at, by the host's stated time left. */
    lapsesAt: number;
    onUnreachable: () => Promise<void>;
  },
): Promise<Decision> {
  const { filed, origin, signal } = wait;
  const deadline = wait.lapsesAt + DEADLINE_MARGIN_MS;
  let failed = false;
  let reported = false;
  for (;;) {
    await pairing.sleep(filed.interval * 1000, signal);
    const answer = await pairing.poll(origin, filed.pollSecret, signal);
    if (answer.status === 'approved') {
      return answer;
    }
    signal.throwIfAborted();
    if (answer.status === 'pending') {
      // A host that answered proves nothing was collected before this poll.
      failed = false;
      if (!(pairing.now() < deadline + PENDING_MARGIN_MS)) {
        return { afterFailure: false, status: 'expired' };
      }
    }
    if (answer.status === 'denied') {
      return { status: 'denied' };
    }
    if (answer.status === 'expired') {
      return { afterFailure: failed, status: 'expired' };
    }
    if (answer.status === 'unreachable') {
      if (!reported) {
        await wait.onUnreachable();
      }
      reported = true;
      failed = true;
      // Every poll since the first failure failed, so an approval may have been collected unseen.
      if (!(pairing.now() < deadline)) {
        return { afterFailure: true, status: 'expired' };
      }
    }
  }
}

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
import type { Pairing, PairingFiled, PairingHost } from '../machine';
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

/** `HH:MM` of an instant in `zone`. */
function clockTime(iso: string, zone: string): string {
  return formatInstant(iso, zone).split(' ')[1] ?? '';
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

/** The refusal for a config that owns a local board: pairing would leave it behind. */
function storeRefusal(configFile: string, origin: string): MimirError {
  return new MimirError(
    'invariant',
    `${configFile} declares [store]: this install owns a local board, and pairing would leave it behind`,
    `export the board (mimir store export board.json), import it on the host (mimir-host store import - --apply < board.json, inside the host container), remove [store] from ${configFile}, then run mimir pair ${origin}`,
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
    .result<PairValue>({ views })
    .views({}, { default: 'records' })
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

      const filed = await pairing.file(origin, device);
      await announce(note, origin, filed, presentation.zone);

      const waiting = progress(context, { label: 'Waiting for approval' });
      const approved = await waitForDecision(pairing, {
        filed,
        onUnreachable: () =>
          warn(
            `host unreachable, still waiting until ${clockTime(filed.expiresAt, presentation.zone)}`,
          ),
        origin,
        signal,
      });
      if (approved.status !== 'approved') {
        await waiting.fail(approved.status === 'denied' ? 'Denied' : 'Expired');
        throw new MimirError(
          'invariant',
          approved.status === 'denied'
            ? `the host at ${origin} denied the pairing request for ${device}`
            : `the pairing request for ${device} expired before the host approved it`,
          AGAIN,
        );
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
  zone: string,
): Promise<void> {
  await note(`pairing code ${filed.userCode}`);
  await note(`approve with mimir-host approve ${filed.userCode} on the host`);
  await note(`or open ${origin}/pair?code=${filed.userCode}`);
  await note(`the request expires at ${formatInstant(filed.expiresAt, zone)}`);
}

type Decision =
  | { status: 'denied' | 'expired' }
  | { status: 'approved'; device: string; token: string };

/**
 * Poll at the host's interval until it decides or the request lapses. A poll
 * that cannot reach the host is not a decision: the wait goes on, and the first
 * such failure is reported once. A definite failure is thrown by the poll.
 */
async function waitForDecision(
  pairing: Pairing,
  wait: {
    filed: PairingFiled;
    origin: string;
    signal: AbortSignal;
    onUnreachable: () => Promise<void>;
  },
): Promise<Decision> {
  const { filed, origin, signal } = wait;
  const stated = Date.parse(filed.expiresAt);
  // The host states a 10 minute request; an unreadable expiry still bounds the wait.
  const lapses = Number.isNaN(stated) ? pairing.now() + 10 * 60 * 1000 : stated;
  let reported = false;
  for (;;) {
    await pairing.sleep(filed.interval * 1000, signal);
    const answer = await pairing.poll(origin, filed.pollSecret);
    signal.throwIfAborted();
    if (answer.status === 'approved') {
      return answer;
    }
    if (answer.status === 'denied' || answer.status === 'expired') {
      return { status: answer.status };
    }
    if (answer.status === 'unreachable' && !reported) {
      reported = true;
      await wait.onUnreachable();
    }
    if (!(pairing.now() < lapses)) {
      return { status: 'expired' };
    }
  }
}

/**
 * `installation-protocol` and `installation-install`: the handshake core's
 * installer runs against a candidate binary (ADR 0031). Both are hidden, so
 * neither shows in help or in a tool listing; no agent or operator calls them,
 * the installer and the dev sandboxes do.
 */
import { Command, FatalError } from '@loomcli/core';
import type { StringOption } from '@loomcli/core';

import type { Ports } from '../ports';
import { textView } from '../render/views';

/** The installer's refusal. Exit 2, as the old binary answered it. */
class InstallationError extends FatalError {
  static override readonly code: string = 'installation';
  static override readonly exitCode = 2;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InstallationError';
  }
}

const text = textView(({ line }: Readonly<{ line: string }>) => line);

/** The probe: print the protocol line the installer compares against. */
export function installationProtocolCommand(ports: Pick<Ports, 'installation'>) {
  return new Command('installation-protocol', {
    description: 'Print the installation protocol this build speaks.',
    hidden: true,
  })
    .result<{ line: string }>({
      views: { ids: text, json: text, jsonl: text, records: text, table: text },
    })
    .views({ records: text }, { default: 'records' })
    .action(async ({ out }) => {
      await out.results({ line: ports.installation.protocolResponse });
    });
}

const pathOption = (what: string) => ({ description: what, type: 'string' }) satisfies StringOption;

/** The `--name value` pairs core's installer reads, from the options given. */
export function installerArgs(options: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(options).flatMap(([name, value]) =>
    typeof value === 'string' ? [`--${name}`, value] : [],
  );
}

/** The candidate's own install, with core's checks on the options. */
export function installationInstallCommand(ports: Pick<Ports, 'installation'>) {
  return new Command('installation-install', {
    description: 'Install this compiled build as the installation (used by the installer).',
    hidden: true,
  })
    .option('target', pathOption('Where to install the binary.'))
    .option('mode', pathOption('live or sandbox.'))
    .option('config', pathOption('The config directory.'))
    .option('data', pathOption('The data directory.'))
    .option('cache', pathOption('The cache directory.'))
    .option('sandbox-authority', pathOption('The sandbox authority, for sandbox mode.'))
    .action(({ options }) => {
      // Core validates the set and the values.
      try {
        ports.installation.install(installerArgs(options));
      } catch (error) {
        throw new InstallationError(error instanceof Error ? error.message : String(error), {
          cause: error,
        });
      }
    });
}

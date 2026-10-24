/**
 * `bind [KEY]`: the clone's project binding (ADR 0036). With a KEY it writes
 * git config `mimir.project`, which is the default `-s` from then on, and
 * records the clone's origin on the project when the project has none. Bare,
 * it prints the clone's project, resolving it from the origin remote when git
 * config has none, and fails as unbound. Git config is the whole state: this
 * command never writes the retired `.mimir.toml`.
 */
import { Command, FatalError } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';

import type { BindingCheck } from '../machine';
import type { Ports } from '../ports';
import { okLine, presentationOf, warnGlyph } from '../render/presentation';
import type { Presentation } from '../render/presentation';
import { recordViews } from '../render/views';

/** The retired checked-in binding file (ADR 0011); `bind` only notes that it is ignored. */
export const LEGACY_BINDING_FILE = '.mimir.toml';

/** The clone is bound to no project. Exit 1. */
export class UnboundError extends FatalError {
  static override readonly code: string = 'unbound';

  constructor(message: string) {
    super(message);
    this.name = 'UnboundError';
  }
}

/** What a bind reported: the project, how the clone came to it, and the styling. */
export type BindValue =
  | { kind: 'check'; key: string; source: 'git-config' | 'origin' }
  | {
      kind: 'set';
      key: string;
      presentation: Presentation;
      configKey: string;
      recordedRemote?: string;
    };

const proseOf = (value: Readonly<BindValue>): string => {
  if (value.kind === 'check') {
    return value.key;
  }
  const bound = okLine(value.presentation, `bound to ${value.key} (git config ${value.configKey})`);
  return value.recordedRemote === undefined
    ? bound
    : `${bound}\n${okLine(value.presentation, `recorded the origin ${value.recordedRemote} on ${value.key}`)}`;
};

const wireOf = (value: Readonly<BindValue>) =>
  value.kind === 'check'
    ? { bound: { project: value.key, source: value.source } }
    : { bound: { project: value.key, recordedRemote: value.recordedRemote } };

const views = recordViews({
  compact: true,
  ids: (value: Readonly<BindValue>) => value.key,
  json: wireOf,
  records: proseOf,
});

/** The refusal for a clone with no project, naming the candidates of an ambiguous origin. */
function unbound(found: Extract<BindingCheck, { state: 'unbound' }>): UnboundError {
  const several =
    found.reason === 'ambiguous'
      ? ` (several projects match this origin: ${found.candidates.join(', ')})`
      : '';
  return new UnboundError(`unbound: run mimir bind KEY${several}`);
}

export function bindCommand(ports: Ports) {
  const { configKey } = ports.machine.binding;
  return new Command('bind', {
    description: `Bind this clone to a project: write git config ${configKey}, the default --scope from then on. Bare, print the clone's bound project and fail when it is unbound.`,
    extensions: [
      helpCommand({
        examples: [
          { command: 'bind MMR', note: `write git config ${configKey}` },
          { command: 'bind', note: 'print the bound key; exit 1 when unbound' },
        ],
      }),
    ],
  })
    .argument('key', {
      description: "An existing project key. Omit to print the clone's bound project.",
      required: false,
    })
    .result<BindValue>({ views })
    .views({ records: views.records }, { default: 'records' })
    .action(async ({ args, host, out }) => {
      const { binding } = ports.machine;
      if (args.key === undefined) {
        const notices: string[] = [];
        const found = await binding.check((line) => notices.push(line));
        for (const line of notices) {
          await out.print(line);
        }
        if (found.state === 'unbound') {
          throw unbound(found);
        }
        await out.results({ key: found.key, kind: 'check', source: found.source });
        return;
      }
      const { recordedRemote } = await binding.bind(args.key);
      const presentation = presentationOf(host, false);
      await out.results({
        configKey,
        key: args.key,
        kind: 'set',
        presentation,
        ...(recordedRemote === undefined ? {} : { recordedRemote }),
      });
      if (binding.legacyFilePresent()) {
        await out.print(
          `${warnGlyph(presentation.plain)} ${LEGACY_BINDING_FILE} is ignored now; you can delete it`,
        );
      }
    });
}

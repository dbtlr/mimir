import { Command } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';
import {
  encodeDecision,
  DECISION_CLASS_VALUES,
  DECISION_LIFECYCLE_VALUES,
  engineSchemas,
  parseEngineInput,
} from '@mimir/contract';
import type { DecisionView } from '@mimir/contract';

import { MimirUsageError } from '../failures';
import { asciiOption, text, writeHints } from '../options';
import type { Ports } from '../ports';
import { decisionEchoViews, renderDecision } from '../render/decisions';
import type { DecisionValue } from '../render/decisions';
import { presentationOf } from '../render/presentation';
import type { Presentation } from '../render/presentation';
import { recordViews } from '../render/views';
import { boardProject, boundProject } from '../scope';

function numberOf(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new MimirUsageError('option numbers must be positive whole numbers');
  }
  return Number(value);
}
function detailsOf(values: string[], options: string[]): (string | null)[] {
  const details = options.map((): string | null => null);
  for (const value of values) {
    const match = /^([1-9][0-9]*):[ \t]*(.*)$/s.exec(value);
    if (!match) {
      throw new MimirUsageError(
        '--detail must be "N: text"; pass a positive option number with no spaces or leading zero',
      );
    }
    const n = Number(match[1]);
    if (!Number.isSafeInteger(n) || n > options.length) {
      throw new MimirUsageError('--detail names no option; pass a listed option number');
    }
    const detail = match[2] ?? '';
    if (!detail.trim()) {
      throw new MimirUsageError('--detail is blank; pass nonblank text after N:');
    }
    if (details[n - 1] !== null) {
      throw new MimirUsageError('--detail names an option twice; name each option once');
    }
    details[n - 1] = detail;
  }
  return details;
}

export function decideCommand(ports: Ports) {
  return new Command('decide', {
    description: 'Record a provisional answer without stopping work.',
    extensions: [
      helpCommand({
        examples: [
          {
            command:
              'decide "Where?" --option Here --option There --recommend 1 --class product -p MMR',
            note: 'take an answer',
          },
        ],
      }),
      mcpCommand({ annotations: writeHints }),
    ],
  })
    .argument('question', { description: 'The question answered.', required: true })
    .option('option', { ...text('An option; repeat at least twice.'), multiple: true })
    .option('detail', { ...text('Option context as N: text; repeat.'), multiple: true })
    .option('recommend', { ...text('The recommended option number.', 'n'), required: true })
    .option('take', text('The option taken; defaults to recommend.', 'n'))
    .option('class', { ...text('product, architecture, or other.'), required: true })
    .option('why', text('The rationale.'))
    .option('delivery', text('The nonterminal delivery (KEY-dN).'))
    .option('task', { ...text('A task built on this answer; repeat.'), multiple: true })
    .option('project', { ...text('The project; defaults to the clone binding.'), short: 'p' })
    .option('ascii', asciiOption)
    .result<DecisionValue>({ views: decisionEchoViews })
    .views({ records: decisionEchoViews.records }, { default: 'records' })
    .action(async ({ args, host, options, out, passthrough }) => {
      if (passthrough.length) {
        throw new MimirUsageError('quote the question as one argument');
      }
      const cls = DECISION_CLASS_VALUES.find((c) => c === options.class);
      if (!cls) {
        throw new MimirUsageError('--class must be product, architecture, or other');
      }
      const project =
        options.project ??
        (options.delivery
          ? undefined
          : await boundProject(ports, undefined, (line) => {
              void out.print(line);
            }));
      const recommended = numberOf(options.recommend);
      if (recommended === undefined) {
        throw new MimirUsageError('pass --recommend N');
      }
      const decision = await (
        await ports.engine()
      ).decide({
        class: cls,
        delivery: options.delivery,
        option_details: detailsOf(options.detail, options.option),
        options: options.option,
        project,
        question: args.question,
        recommended,
        taken: numberOf(options.take),
        tasks: options.task,
        why: options.why,
      });
      await out.results({
        decision: encodeDecision(decision),
        presentation: presentationOf(host, options.ascii),
      });
    });
}
export function decisionAnswerCommand(ports: Ports, verb: 'confirm' | 'overturn') {
  return new Command(verb, {
    description: `${verb === 'confirm' ? 'Confirm' : 'Overturn'} a provisional decision.`,
    extensions: [
      helpCommand({
        examples: [{ command: `${verb} MMR-q1 "Answer"`, note: 'settle the answer' }],
      }),
      mcpCommand({ annotations: writeHints }),
    ],
  })
    .argument('id', { description: 'The decision (KEY-qN).', required: true })
    .argument('note', { description: 'The outcome note.' })
    .option('option', { ...text('Another listed option.', 'n'), hidden: verb === 'confirm' })
    .option('ascii', asciiOption)
    .result<DecisionValue>({ views: decisionEchoViews })
    .views({ records: decisionEchoViews.records }, { default: 'records' })
    .action(async ({ args, host, options, out, passthrough }) => {
      if (passthrough.length) {
        throw new MimirUsageError('quote the outcome note as one argument');
      }
      if (verb === 'confirm' && options.option !== undefined) {
        throw new MimirUsageError('--option applies only to overturn');
      }
      const engine = await ports.engine();
      const decision =
        verb === 'confirm'
          ? await engine.confirm({ id: args.id, note: args.note })
          : await engine.overturn({
              id: args.id,
              note: args.note,
              option: numberOf(options.option),
            });
      await out.results({
        decision: encodeDecision(decision),
        presentation: presentationOf(host, options.ascii),
      });
    });
}

type DecisionsValue = { decisions: DecisionView[]; presentation: Presentation };
const listViews = recordViews<DecisionsValue>({
  ids: (v) => v.decisions.map((d) => d.id).join('\n'),
  json: (v) => ({ decisions: v.decisions, total: v.decisions.length }),
  jsonl: (v) => v.decisions,
  records: (v) =>
    v.decisions.length
      ? v.decisions.map((d) => renderDecision(d, v.presentation)).join('\n\n')
      : 'No decisions.',
});

export function decisionsCommand(ports: Ports) {
  return new Command('decisions', {
    description: "Read one project's decisions, oldest first; provisional by default.",
    extensions: [
      helpCommand({
        examples: [
          {
            command: 'decisions --class product --class architecture --linked',
            note: 'read decisions counted toward the cap',
          },
        ],
      }),
      mcpCommand({ annotations: { openWorld: false, readOnly: true } }),
    ],
  })
    .option('project', { ...text('The project key; defaults to the clone binding.'), short: 'p' })
    .option('status', text('provisional (default), confirmed, overturned, or all.'))
    .option('class', {
      ...text('product, architecture, or other; repeat for alternatives.'),
      multiple: true,
    })
    .option('delivery', text('Only decisions linked to this delivery (KEY-dN).'))
    .option('linked', {
      description: 'At least one linked task is not abandoned.',
      // Preserve an explicit false through Loom so Engine validation can refuse it.
      polarity: 'both',
      type: 'boolean',
    })
    .option('ascii', asciiOption)
    .result<DecisionsValue>({ views: listViews })
    .views({ table: listViews.table }, { default: 'table' })
    .action(async ({ host, options, out, supplied }) => {
      const status = [...DECISION_LIFECYCLE_VALUES, 'all' as const].find(
        (s) => s === options.status,
      );
      if (options.status !== undefined && !status) {
        throw new MimirUsageError('--status must be provisional, confirmed, overturned, or all');
      }
      // `--linked` only narrows; there is no "only unlinked" filter, so an explicit
      // false (--no-linked, or MCP `linked: false`) is refused rather than ignored.
      if (supplied.options.linked !== undefined && !options.linked) {
        throw new MimirUsageError(
          '--linked takes no false value: omit it to leave links unfiltered',
        );
      }
      const classes = options.class.map((value) => {
        const cls = DECISION_CLASS_VALUES.find((c) => c === value);
        if (!cls) {
          throw new MimirUsageError('--class must be product, architecture, or other');
        }
        return cls;
      });
      const project = await boardProject(
        ports,
        options.project,
        'decisions',
        (line) => {
          void out.print(line);
        },
        undefined,
        '-p',
      );
      const decisions = (
        await (
          await ports.engine()
        ).decisions(
          parseEngineInput(engineSchemas.decisions.input, {
            classes,
            delivery: options.delivery,
            linked: options.linked ? true : undefined,
            project,
            status,
          }),
        )
      ).map(encodeDecision);
      await out.results({ decisions, presentation: presentationOf(host, options.ascii) });
    });
}

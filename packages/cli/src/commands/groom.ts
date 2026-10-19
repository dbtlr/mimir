/**
 * `groom <ids> <state> [note…]`: record how ready tasks are to start (ADR
 * 0033). A note is required for `needs_answers`; the Engine enforces that.
 */
import { Command } from '@loomcli/core';
import { helpCommand } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';
import { GROOMING_VALUES } from '@mimir/contract';
import { isMember } from '@mimir/helpers';

import { MimirUsageError } from '../failures';
import { nodeToken, splitCsv, withListHint } from '../node-input';
import { asciiOption, writeHints } from '../options';
import { reasonWords } from '../parse';
import type { Ports } from '../ports';
import { okLine, presentationOf } from '../render/presentation';
import { noticeViews } from '../render/writes';
import type { Notice } from '../render/writes';

const STATE_HINT = 'groom MMR-12 needs_answers "which store owns the lock?"';

export function groomCommand(ports: Ports) {
  return new Command('groom', {
    description: `Mark tasks ${GROOMING_VALUES.join(' | ')}.`,
    extensions: [
      helpCommand({
        examples: [
          { command: 'groom MMR-12 groomed', note: 'ready to start' },
          {
            command: 'groom MMR-12,MMR-13 groomed "scoped in the design"',
            note: 'several tasks',
          },
          {
            command: 'groom MMR-14 needs_answers "which store owns the lock?"',
            note: 'blocked on a question',
          },
        ],
      }),
      mcpCommand({
        annotations: { ...writeHints, idempotent: true },
      }),
    ],
  })
    .argument('ids', {
      description: 'The tasks: ids (KEY-seq), comma- or space-separated.',
      required: true,
    })
    .argument('state', {
      description: `One of: ${GROOMING_VALUES.join(', ')}.`,
      required: true,
    })
    .argument('note', {
      description: 'Why; required for needs_answers.',
      variadic: true,
    })
    .option('ascii', asciiOption)
    .result<Notice>({ views: noticeViews })
    .views({}, { default: 'records' })
    .action(async ({ args, host, options, out, passthrough }) => {
      // Ids run up to the first state word, each possibly comma-separated; the
      // rest is the note. Loom's declared `state` is only the second word.
      const tail = [args.ids, args.state, ...args.note];
      const stateAt = tail.findIndex((token) => isMember(token, GROOMING_VALUES));
      const tokens = (stateAt === -1 ? tail : tail.slice(0, stateAt)).flatMap(splitCsv);
      if (tokens.length === 0) {
        throw new MimirUsageError('groom requires ids (KEY-seq)', 'groom MMR-12,MMR-13 groomed');
      }
      const state = tail[stateAt] ?? '';
      if (!isMember(state, GROOMING_VALUES)) {
        // A tail of ids only forgot the state; otherwise the first token that is
        // not a well-formed id is the misspelled state.
        const unknown = tokens.find((token) => ports.grammar.idKind(token) === undefined);
        throw new MimirUsageError(
          unknown === undefined
            ? `groom requires a state (${GROOMING_VALUES.join('|')})`
            : `unknown grooming state '${unknown}' (expected ${GROOMING_VALUES.join('|')})`,
          STATE_HINT,
        );
      }
      const ids = tokens.map((token) => nodeToken(ports.grammar, token, 'task'));
      const note = reasonWords(tail.slice(stateAt + 1), passthrough);
      const engine = await ports.engine();
      const groomed = await withListHint(ids, () =>
        engine.groom({ ids, note: note === '' ? undefined : note, state }),
      );
      const written = groomed.map((node) => node.id);
      await out.results({
        ids: written.join('\n'),
        json: { groomed: { ids: written, state } },
        line: okLine(
          presentationOf(host, options.ascii),
          `groomed ${written.join(', ')} · ${state}`,
        ),
      });
    });
}

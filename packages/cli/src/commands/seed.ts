/**
 * The seed verbs that write: `seed` files one, `promote` turns one into work,
 * and `reject` and `resolve` settle one. Each calls the Engine and echoes the
 * seed it changed.
 */
import { Command } from '@loomcli/core';
import { helpCommand, helpInput } from '@loomcli/plugins/help/extension';
import { mcpCommand } from '@loomcli/plugins/mcp/extension';
import { intentEncoders, SEED_KIND_VALUES } from '@mimir/contract';
import type { SeedKind } from '@mimir/contract';

import { MimirUsageError } from '../failures';
import { asciiOption, scopeOption, tagOption, text, writeHints } from '../options';
import { parsePriority, parseSeedKind, parseSize, reasonWords } from '../parse';
import type { Ports } from '../ports';
import { presentationOf } from '../render/presentation';
import { seedEcho, seedEchoViews } from '../render/seeds';
import type { SeedEcho } from '../render/seeds';
import { boundProject, targetProject } from '../scope';

const boundOption = {
  ...scopeOption,
  description: "The project this clone is bound to, for this run. Defaults to the clone's binding.",
};

/** The seed id `verb` takes, refused as usage when the token is not shaped like one. */
function requireSeedId(ports: Ports, verb: string, token: string): string {
  if (token.trim() === '' || ports.grammar.idKind(token) !== 'seed') {
    throw new MimirUsageError(`${verb} takes a seed id (KEY-sN), got ${token}`);
  }
  return token;
}

/** The required `-k`/`--kind`, narrowed to the closed seed-kind set. */
function requireKind(kind: string | undefined): SeedKind {
  if (kind === undefined) {
    throw new MimirUsageError(`seed requires -k <${SEED_KIND_VALUES.join('|')}>`);
  }
  return parseSeedKind(kind);
}

export function seedCommand(ports: Ports) {
  return new Command('seed', {
    description:
      'File a seed: an idea, bug, or feature request on a project, to be triaged later. The title is one quoted argument.',
    extensions: [
      helpCommand({
        examples: [
          { command: 'seed "Cache the plan" -k idea', note: 'file an idea on the bound project' },
          {
            command: 'seed "Add a hook" -k feature -p XX --desc "Needed by MMR."',
            note: 'file against another project; the bound project becomes the requester',
          },
        ],
      }),
      mcpCommand({ annotations: writeHints }),
    ],
  })
    .argument('title', { description: 'The seed title, one quoted argument.', required: true })
    .option('kind', {
      description: `What the seed is: ${SEED_KIND_VALUES.join(', ')}.`,
      extensions: [helpInput({ placeholder: 'kind' })],
      short: 'k',
      type: 'string',
    })
    .option('project', {
      description: 'The project to file against. Defaults to the clone binding.',
      extensions: [helpInput({ placeholder: 'KEY' })],
      short: 'p',
      type: 'string',
    })
    .option('desc', text('The seed description.'))
    .option('scope', boundOption)
    .option('ascii', asciiOption)
    .result<SeedEcho>({ views: seedEchoViews })
    .views({ records: seedEchoViews.records }, { default: 'records' })
    .action(async ({ args, host, options, out }) => {
      if (args.title.trim() === '') {
        throw new MimirUsageError('seed requires a title');
      }
      const kind = requireKind(options.kind);
      const notify = (line: string): void => {
        void out.print(line);
      };
      const bound = await boundProject(ports, options.scope, notify);
      const project = targetProject(options.project, bound, {
        hint: 'pass -p KEY or bind a board first (mimir bind KEY)',
        message: 'seed requires a target project',
      });
      // The requester is the bound board only when filing into a different one.
      const requester = bound !== undefined && bound !== project ? bound : null;
      const engine = await ports.engine();
      const seed = intentEncoders.seed.parse(
        await engine.seedCreate({
          description: options.desc,
          kind,
          project,
          requester,
          title: args.title,
        }),
      );
      await out.results(
        seedEcho(
          ports,
          seed,
          `filed ${seed.id} · ${seed.kind}`,
          presentationOf(host, options.ascii),
        ),
      );
    });
}

export function promoteCommand(ports: Ports) {
  return new Command('promote', {
    description:
      'Promote a seed into work: spawn a task from it, or record existing work with --link.',
    extensions: [
      helpCommand({
        examples: [
          { command: 'promote MMR-s3', note: 'spawn a task from the seed' },
          { command: 'promote MMR-s3 --parent MMR-12 -p p1', note: 'under a phase, at p1' },
          { command: 'promote MMR-s3 --link MMR-40', note: 'record work that already exists' },
        ],
      }),
      mcpCommand({ annotations: writeHints }),
    ],
  })
    .argument('id', { description: 'The seed, KEY-sN.', required: true })
    .option('title', text("Override the spawned task's title."))
    .option('desc', text("Override the spawned task's description."))
    .option('parent', text('Where the spawned task goes.', 'ID'))
    .option('link', text('Existing work to record instead of spawning. Takes one id.', 'ID'))
    .option('priority', {
      description: "The spawned task's priority.",
      extensions: [helpInput({ placeholder: 'p0|p1|p2|p3' })],
      short: 'p',
      type: 'string',
    })
    .option('size', {
      description: "The spawned task's size (an unambiguous prefix works).",
      extensions: [helpInput({ placeholder: 'size' })],
      type: 'string',
    })
    .option('tag', { ...tagOption, description: 'Tag the spawned task. Repeat for more.' })
    .option('ascii', asciiOption)
    .result<SeedEcho>({ views: seedEchoViews })
    .views({ records: seedEchoViews.records }, { default: 'records' })
    .action(async ({ args, host, options, out }) => {
      const id = requireSeedId(ports, 'promote', args.id);
      const priority = parsePriority(options.priority);
      const size = parseSize(options.size);
      const engine = await ports.engine();
      const promotion = intentEncoders.seedPromotion.parse(
        await engine.seedPromote({
          description: options.desc,
          id,
          link: options.link,
          parent: options.parent,
          priority,
          size,
          tags: options.tag.length > 0 ? options.tag : undefined,
          title: options.title,
        }),
      );
      const { created, seed, spawnedId } = promotion;
      await out.results({
        idsTarget: spawnedId,
        presentation: presentationOf(host, options.ascii),
        seed,
        signpost:
          created === undefined
            ? `promoted ${seed.id} · recorded existing work`
            : `promoted ${seed.id} · spawned ${created}`,
        wire: ports.wire.promotion(seed, created),
      });
    });
}

/** `reject` and `resolve` settle a seed with a reason; they differ only in the verb and the Engine call. */
function settleCommand(ports: Ports, verb: 'reject' | 'resolve') {
  const settled = verb === 'reject' ? 'rejected' : 'resolved';
  return new Command(verb, {
    description:
      verb === 'reject'
        ? 'Reject a seed: it will not be done. The reason is recorded.'
        : 'Resolve a seed: what it asked for is done. The reason is recorded.',
    extensions: [
      helpCommand({
        examples: [
          verb === 'reject'
            ? {
                command: 'reject MMR-s3 out of scope for this cycle',
                note: 'the reason is the rest of the line',
              }
            : {
                command: 'resolve MMR-s3 shipped in MMR-40',
                note: 'the reason is the rest of the line',
              },
        ],
      }),
      mcpCommand({ annotations: { ...writeHints, idempotent: false } }),
    ],
  })
    .argument('id', { description: 'The seed, KEY-sN.', required: true })
    .argument('reason', {
      description: 'Why, in the rest of the line. Required, but may follow --.',
      variadic: true,
    })
    .option('ascii', asciiOption)
    .result<SeedEcho>({ views: seedEchoViews })
    .views({ records: seedEchoViews.records }, { default: 'records' })
    .action(async ({ args, host, options, out, passthrough }) => {
      const id = requireSeedId(ports, verb, args.id);
      const reason = reasonWords(args.reason, passthrough);
      if (reason.trim() === '') {
        throw new MimirUsageError(`${verb} requires a reason`);
      }
      const engine = await ports.engine();
      const raw =
        verb === 'reject'
          ? await engine.seedReject({ id, reason })
          : await engine.seedResolve({ id, reason });
      const seed = intentEncoders.seed.parse(raw);
      await out.results(
        seedEcho(
          ports,
          seed,
          `${settled} ${seed.id} · ${reason}`,
          presentationOf(host, options.ascii),
        ),
      );
    });
}

export const rejectCommand = (ports: Ports) => settleCommand(ports, 'reject');
export const resolveCommand = (ports: Ports) => settleCommand(ports, 'resolve');

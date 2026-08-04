import type { Scratchpad } from '@mimir/contract';

import { createScratchpadService } from '../core';
import type { ArtifactRecord, Store } from '../core';
import type { Format, Io } from '../presentation';
import { usage } from './errors';

type ScratchValues = {
  scope?: string;
  title?: string;
  link?: string[];
  'clear-links'?: boolean;
  'expected-updated-at'?: string;
  file?: string;
  summary?: string;
  tag?: string[];
  force?: boolean;
  reason?: string;
};

export type ScratchContext = {
  boundScope?: string;
  format: Format;
  io: Io;
  positionals: string[];
  store: Store;
  values: ScratchValues;
};

const SCRATCH_SUBCOMMANDS = [
  'create',
  'list',
  'agenda',
  'get',
  'update',
  'checkpoint',
  'freeze',
  'discard',
] as const;
type ScratchSubcommand = (typeof SCRATCH_SUBCOMMANDS)[number];

/** Validate the noun-group token before callers acquire the vault-backed Store. */
export function scratchSubcommand(positionals: readonly string[]): ScratchSubcommand {
  const sub = positionals[1];
  if (
    sub === 'agenda' &&
    positionals[2] !== 'add' &&
    positionals[2] !== 'complete' &&
    positionals[2] !== 'supersede'
  ) {
    throw usage('scratch agenda requires add, complete, or supersede');
  }
  switch (sub) {
    case 'create':
    case 'list':
    case 'agenda':
    case 'get':
    case 'update':
    case 'checkpoint':
    case 'freeze':
    case 'discard': {
      return sub;
    }
    case undefined: {
      throw usage('scratch requires a subcommand');
    }
    default: {
      throw usage(`unknown scratch subcommand: ${sub}`);
    }
  }
}

function unreachable(value: never): never {
  throw new Error(`unreachable Scratchpad subcommand: ${String(value)}`);
}

const wire = (pad: Scratchpad) => ({
  agenda: pad.agenda,
  created_at: pad.createdAt,
  freezing_at: pad.freezingAt,
  id: pad.id,
  journal: pad.journal,
  linked_work: pad.anchors,
  project: pad.project,
  title: pad.title,
  updated_at: pad.updatedAt,
});

const receipt = (pad: Scratchpad) => ({
  id: pad.id,
  open_agenda: pad.agenda.filter((item) => item.state === 'open').length,
  project: pad.project,
  title: pad.title,
  updated_at: pad.updatedAt,
});

function emit(value: Record<string, unknown>, format: Format, io: Io): void {
  if (format === 'json' || format === 'jsonl') {
    io.write(JSON.stringify(value));
    return;
  }
  if (format === 'ids') {
    io.write(String(value.id ?? value.artifact));
    return;
  }
  io.write(
    Object.entries(value)
      .map(([key, item]) => `${key.replaceAll('_', ' ')}  ${renderValue(item)}`)
      .join('\n'),
  );
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function required(value: string | undefined, message: string): string {
  if (value === undefined || value.trim() === '') {
    throw usage(message);
  }
  return value;
}

function guard(values: ScratchValues): { expectedUpdatedAt: string } {
  return {
    expectedUpdatedAt: required(
      values['expected-updated-at'],
      'scratch mutation requires --expected-updated-at <timestamp>',
    ),
  };
}

function integer(value: string | undefined, noun: string): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw usage(`scratch agenda ${noun} requires a positive item number`);
  }
  return parsed;
}

function artifactReceipt(artifact: ArtifactRecord) {
  return {
    created_at: artifact.created_at,
    id: `${artifact.key}-a${String(artifact.seq)}`,
    linked_work: artifact.links,
    project: artifact.key,
    summary: artifact.summary,
    tags: artifact.tags,
    title: artifact.title,
  };
}

/** Dispatch the `scratch` noun group over the canonical Scratchpad service. */
export async function cmdScratch(c: ScratchContext): Promise<number> {
  const sub = scratchSubcommand(c.positionals);
  const service = createScratchpadService(c.store.scratchpads, c.store.artifacts);

  if (sub === 'create') {
    const project = c.values.scope ?? c.boundScope;
    if (project === undefined || project === 'all') {
      throw usage('scratch create needs a project', 'bind a project or pass -s KEY');
    }
    emit(
      receipt(
        await service.create({
          anchors: c.values.link,
          project,
          title: required(
            c.values.title ?? (c.positionals.slice(2).join(' ') || undefined),
            'scratch create requires a title',
          ),
        }),
      ),
      c.format,
      c.io,
    );
    return 0;
  }

  if (sub === 'list') {
    const project = c.values.scope === 'all' ? undefined : (c.values.scope ?? c.boundScope);
    const pads = (await service.list(project)).toSorted(
      (a, b) =>
        Number(b.freezingAt !== null) - Number(a.freezingAt !== null) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.id.localeCompare(b.id),
    );
    const values = pads.map((pad) => {
      const summary = receipt(pad);
      return Object.assign(summary, {
        state: pad.freezingAt === null ? ('active' as const) : ('freezing' as const),
      });
    });
    if (c.format === 'ids') {
      c.io.write(values.map((pad) => pad.id).join('\n'));
    } else if (c.format === 'json') {
      c.io.write(JSON.stringify({ scratchpads: values, total: values.length }));
    } else if (c.format === 'jsonl') {
      c.io.write(values.map((pad) => JSON.stringify(pad)).join('\n'));
    } else {
      c.io.write(
        values.length === 0
          ? '0 scratchpads'
          : values
              .map(
                (pad) =>
                  `${pad.state === 'freezing' ? 'freezing  ' : ''}${pad.id}  ${pad.project}  ${pad.title}  ${pad.updated_at}`,
              )
              .join('\n'),
      );
    }
    return 0;
  }

  if (sub === 'agenda') {
    const action = c.positionals[2];
    if (action !== 'add' && action !== 'complete' && action !== 'supersede') {
      throw usage('scratch agenda requires add, complete, or supersede');
    }
    const id = required(c.positionals[3], `scratch agenda ${action} requires a UUID`);
    if (action === 'add') {
      emit(
        receipt(
          await service.agendaAdd(id, {
            ...guard(c.values),
            content: required(
              c.positionals.slice(4).join(' ') || undefined,
              'scratch agenda add requires content',
            ),
          }),
        ),
        c.format,
        c.io,
      );
    } else if (action === 'complete') {
      emit(
        receipt(
          await service.agendaComplete(id, {
            ...guard(c.values),
            number: integer(c.positionals[4], 'complete'),
          }),
        ),
        c.format,
        c.io,
      );
    } else if (action === 'supersede') {
      emit(
        receipt(
          await service.agendaSupersede(id, {
            ...guard(c.values),
            number: integer(c.positionals[4], 'supersede'),
            reason: required(
              c.values.reason ?? (c.positionals.slice(5).join(' ') || undefined),
              'scratch agenda supersede requires a reason',
            ),
          }),
        ),
        c.format,
        c.io,
      );
    }
    return 0;
  }

  const id = required(c.positionals[2], `scratch ${sub} requires a UUID`);
  if (sub === 'get') {
    emit(wire(await service.get(id)), c.format, c.io);
    return 0;
  }
  if (sub === 'update') {
    if (c.values['clear-links'] === true && (c.values.link?.length ?? 0) > 0) {
      throw usage('scratch update cannot combine --clear-links and --link');
    }
    emit(
      receipt(
        await service.updateMetadata(id, {
          ...guard(c.values),
          anchors: c.values['clear-links'] === true ? [] : c.values.link,
          title: c.values.title,
        }),
      ),
      c.format,
      c.io,
    );
    return 0;
  }
  if (sub === 'checkpoint') {
    const inline = c.positionals.slice(3).join(' ') || undefined;
    if (inline !== undefined && c.values.file !== undefined) {
      throw usage('scratch checkpoint accepts either inline content or --file, not both');
    }
    const content = c.values.file === undefined ? inline : await Bun.file(c.values.file).text();
    emit(
      receipt(
        await service.checkpoint(id, {
          ...guard(c.values),
          content: required(content, 'scratch checkpoint requires content or --file'),
        }),
      ),
      c.format,
      c.io,
    );
    return 0;
  }
  if (sub === 'freeze') {
    emit(
      artifactReceipt(
        await service.freeze(id, {
          ...guard(c.values),
          summary: required(c.values.summary, 'scratch freeze requires --summary'),
          tags: c.values.tag,
        }),
      ),
      c.format,
      c.io,
    );
    return 0;
  }
  if (sub === 'discard') {
    await service.discard(id, {
      ...guard(c.values),
      force: c.values.force,
      reason: c.values.reason,
    });
    emit({ id, result: 'discarded' }, c.format, c.io);
    return 0;
  }
  return unreachable(sub);
}

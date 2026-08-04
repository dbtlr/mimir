import { randomUUID } from 'node:crypto';

import type { Scratchpad, ScratchpadAgendaItem } from '@mimir/contract';

import type { ArtifactRecord, ArtifactStore } from '../artifacts/store';
import { conflict, notFound, validation } from '../errors';
import type { Project } from '../model';
import { normalizeSummary } from '../mutations/data';
import { now } from '../time';
import { encodeScratchpadBody } from './codec';
import type { ScratchpadStore } from './store';

export type ScratchpadMutationGuard = { expectedUpdatedAt: string };

export type ScratchpadService = ReturnType<typeof createScratchpadService>;

function assertWorking(scratchpad: Scratchpad): void {
  if (scratchpad.freezingAt !== null) {
    throw validation(`${scratchpad.id} is freezing and cannot accept working mutations`);
  }
}

function assertGuard(scratchpad: Scratchpad, expectedUpdatedAt: string): void {
  if (scratchpad.updatedAt !== expectedUpdatedAt) {
    throw validation('the scratchpad changed concurrently', 'reload it and retry the mutation');
  }
}

export function createScratchpadService(
  scratchpads: ScratchpadStore,
  artifacts: ArtifactStore,
  projects: { loadProjects: () => Promise<readonly Project[]> },
  deps: { clock?: () => string; uuid?: () => string } = {},
) {
  const clock = deps.clock ?? now;
  const uuid = deps.uuid ?? randomUUID;

  const loadRequired = async (id: string): Promise<Scratchpad> => {
    const scratchpad = await scratchpads.load(id);
    if (scratchpad === undefined) {
      throw notFound(`${id} doesn't exist`);
    }
    return scratchpad;
  };

  const stampAfter = (current: string): string => {
    const candidate = clock();
    return candidate > current
      ? candidate
      : new Date(new Date(current).valueOf() + 1).toISOString();
  };

  const mutate = async (
    id: string,
    guard: ScratchpadMutationGuard,
    change: (scratchpad: Scratchpad) => Scratchpad,
  ): Promise<Scratchpad> => {
    const current = await loadRequired(id);
    assertWorking(current);
    assertGuard(current, guard.expectedUpdatedAt);
    const replacement = {
      ...change(current),
      updatedAt: stampAfter(current.updatedAt),
    };
    await scratchpads.replace(replacement, current.updatedAt);
    return replacement;
  };

  return {
    async agendaAdd(
      id: string,
      input: ScratchpadMutationGuard & { content: string },
    ): Promise<Scratchpad> {
      if (input.content.trim() === '') {
        throw validation('agenda content is required');
      }
      return mutate(id, input, (scratchpad) => ({
        ...scratchpad,
        agenda: [
          ...scratchpad.agenda,
          {
            content: input.content.trim(),
            number: scratchpad.agenda.length + 1,
            reason: null,
            state: 'open',
          },
        ],
      }));
    },

    async agendaComplete(
      id: string,
      input: ScratchpadMutationGuard & { number: number },
    ): Promise<Scratchpad> {
      return mutate(id, input, (scratchpad) => ({
        ...scratchpad,
        agenda: transitionAgenda(scratchpad.agenda, input.number, 'done'),
      }));
    },

    async agendaSupersede(
      id: string,
      input: ScratchpadMutationGuard & { number: number; reason: string },
    ): Promise<Scratchpad> {
      if (input.reason.trim() === '') {
        throw validation('superseding an Agenda item requires a reason');
      }
      return mutate(id, input, (scratchpad) => ({
        ...scratchpad,
        agenda: transitionAgenda(
          scratchpad.agenda,
          input.number,
          'superseded',
          input.reason.trim(),
        ),
      }));
    },

    async checkpoint(
      id: string,
      input: ScratchpadMutationGuard & { content: string },
    ): Promise<Scratchpad> {
      if (input.content.trim() === '') {
        throw validation('checkpoint content is required');
      }
      return mutate(id, input, (scratchpad) => ({
        ...scratchpad,
        journal: [
          ...scratchpad.journal,
          {
            at: clock(),
            content: input.content.trim(),
            number: scratchpad.journal.length + 1,
          },
        ],
      }));
    },

    async create(input: {
      project: string;
      title: string;
      anchors?: string[];
    }): Promise<Scratchpad> {
      if (input.title.trim() === '') {
        throw validation('scratchpad create requires a title');
      }
      const project = (await projects.loadProjects()).find(
        (candidate) => candidate.key === input.project,
      );
      if (project === undefined) {
        throw notFound(`project ${input.project} doesn't exist`);
      }
      if (project.archived_at !== null) {
        throw conflict(
          `project ${project.key} is archived — no changes are allowed`,
          `unarchive it first: mimir unarchive ${project.key}`,
        );
      }
      const timestamp = clock();
      const scratchpad: Scratchpad = {
        agenda: [],
        anchors: input.anchors === undefined ? [] : [...new Set(input.anchors)],
        createdAt: timestamp,
        freezingAt: null,
        id: uuid(),
        journal: [],
        project: input.project,
        title: input.title.trim(),
        updatedAt: timestamp,
      };
      await scratchpads.create(scratchpad);
      return scratchpad;
    },

    async discard(
      id: string,
      input: ScratchpadMutationGuard & { force?: boolean; reason?: string },
    ): Promise<void> {
      const scratchpad = await loadRequired(id);
      assertWorking(scratchpad);
      assertGuard(scratchpad, input.expectedUpdatedAt);
      const open = scratchpad.agenda.filter((item) => item.state === 'open');
      if (open.length > 0 && input.force !== true) {
        throw validation(
          `discard refused with open Agenda items: ${open.map((item) => `${item.number}. ${item.content}`).join('; ')}`,
          'settle the items or retry with force and a reason',
        );
      }
      if (input.force === true && (input.reason?.trim() ?? '') === '') {
        throw validation('forced discard requires a reason');
      }
      await scratchpads.delete(id, scratchpad.updatedAt);
    },

    async freeze(
      id: string,
      input: ScratchpadMutationGuard & { summary: string; tags?: string[] },
    ): Promise<ArtifactRecord & { content: string }> {
      const summary = normalizeSummary(input.summary);
      if (summary === null) {
        throw validation('freeze requires a summary');
      }

      let scratchpad = await scratchpads.load(id);
      const recovered = await artifacts.findBySourceScratch(id);
      if (scratchpad === undefined) {
        if (recovered !== undefined) {
          return recovered;
        }
        throw notFound(`${id} doesn't exist`);
      }
      assertGuard(scratchpad, input.expectedUpdatedAt);

      if (scratchpad.freezingAt === null) {
        const stamp = stampAfter(scratchpad.updatedAt);
        const staged = { ...scratchpad, freezingAt: stamp, updatedAt: stamp };
        await scratchpads.replace(staged, scratchpad.updatedAt);
        scratchpad = staged;
      }

      const artifact =
        recovered ??
        (await artifacts.create({
          content: encodeScratchpadBody(scratchpad),
          key: scratchpad.project,
          links: scratchpad.anchors,
          sourceScratch: scratchpad.id,
          summary,
          tags: [...new Set(['scratchpad', ...(input.tags ?? [])])],
          title: scratchpad.title,
        }));
      await scratchpads.delete(scratchpad.id, scratchpad.updatedAt);
      return artifact;
    },

    get: (id: string) => loadRequired(id),

    list: (project?: string) => scratchpads.list(project),

    async updateMetadata(
      id: string,
      input: ScratchpadMutationGuard & { title?: string; anchors?: string[] },
    ): Promise<Scratchpad> {
      if (input.title !== undefined && input.title.trim() === '') {
        throw validation('scratchpad title cannot be blank');
      }
      return mutate(id, input, (scratchpad) => ({
        ...scratchpad,
        anchors: input.anchors === undefined ? scratchpad.anchors : [...new Set(input.anchors)],
        title: input.title?.trim() ?? scratchpad.title,
      }));
    },
  };
}

function transitionAgenda(
  agenda: readonly ScratchpadAgendaItem[],
  number: number,
  state: 'done' | 'superseded',
  reason: string | null = null,
): ScratchpadAgendaItem[] {
  const item = agenda.find((candidate) => candidate.number === number);
  if (item === undefined) {
    throw notFound(`Agenda item ${String(number)} doesn't exist`);
  }
  if (item.state !== 'open') {
    throw validation(`Agenda item ${String(number)} is already ${item.state}`);
  }
  return agenda.map((candidate) =>
    candidate.number === number ? { ...candidate, reason, state } : candidate,
  );
}

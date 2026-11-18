import type { ReviewRead } from './notification-events';

/*
 * Review reads for the notifier's tests: only the fields the notifier uses,
 * built from short member descriptions. `queue` follows the order given.
 */

export type FixtureMember = FixtureBody & {
  /** The project the member's row sits under; the review's own default when absent. */
  project?: string;
};

type FixtureBody =
  | { delivery: { hold?: string | null; id: string; seq: number; title: string }; kind: 'delivery' }
  | {
      decision: { delivery: string | null; id: string; question: string };
      kind: 'decision';
    }
  | {
      kind: 'task';
      question?: string | null;
      reason: 'blocked' | 'needs_answers';
      task: { hold?: string | null; id: string; title: string };
    };

function memberId(member: FixtureMember): string {
  if (member.kind === 'delivery') {
    return member.delivery.id;
  }
  return member.kind === 'decision' ? member.decision.id : member.task.id;
}

function rowOf(member: FixtureMember, project: string) {
  if (member.kind === 'delivery') {
    return {
      delivery: {
        hold_reason: member.delivery.hold ?? null,
        id: member.delivery.id,
        lifecycle: 'blocked',
        phase: 'MMR-2',
        project,
        seq: member.delivery.seq,
        title: member.delivery.title,
        updated_at: new Date(0),
      },
      kind: 'delivery',
    };
  }
  if (member.kind === 'decision') {
    return {
      decision: { ...member.decision, project_key: project },
      kind: 'decision',
      workBuiltOnIt: false,
    };
  }
  return {
    kind: 'task',
    question: member.question ?? null,
    reason: member.reason,
    stale: false,
    task: { holdReason: member.task.hold ?? null, id: member.task.id, title: member.task.title },
  };
}

/** The needs-you read for `members`; a member without its own project sits in `project`. */
export function reviewOf(members: FixtureMember[], project = 'MMR'): ReviewRead {
  const groups = new Map<string, unknown[]>();
  for (const member of members) {
    const key = member.project ?? project;
    groups.set(key, [...(groups.get(key) ?? []), rowOf(member, key)]);
  }
  const queue = members.map((member) => ({
    id: memberId(member),
    kind: member.kind,
  }));
  // Only the fields the notifier reads are built.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {
    needsYou: [...groups].map(([key, rows]) => ({ project: { key, name: key }, rows })),
    queue,
  } as unknown as ReviewRead;
}

export const stoppedDelivery = (
  id: string,
  seq: number,
  title = 'Ship it',
  hold: string | null = 'CI is red',
) => ({ delivery: { hold, id, seq, title }, kind: 'delivery' }) satisfies FixtureMember;

export const decision = (
  id: string,
  delivery: string | null,
  question = 'Which store?',
  project?: string,
) => ({ decision: { delivery, id, question }, kind: 'decision', project }) satisfies FixtureMember;

export const blockedTask = (
  id: string,
  title = 'Wire it',
  hold: string | null = 'Need a key',
  question: string | null = null,
) =>
  ({
    kind: 'task',
    question,
    reason: 'blocked',
    task: { hold, id, title },
  }) satisfies FixtureMember;

export const askingTask = (
  id: string,
  title = 'Groom it',
  question: string | null = 'Which API?',
  hold: string | null = null,
) =>
  ({
    kind: 'task',
    question,
    reason: 'needs_answers',
    task: { hold, id, title },
  }) satisfies FixtureMember;

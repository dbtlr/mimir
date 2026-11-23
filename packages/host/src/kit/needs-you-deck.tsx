import type { EngineNode } from '@mimir/contract';
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { ReviewReport } from '../api/view-queries';
import { NeedsYouDeckView } from '../components/needs-you-deck-view';
import type { NeedsYouWrites } from '../components/needs-you-deck-view';
import { toast } from '../components/patterns/notice';
import { Reason } from '../components/patterns/reason';
import { ActionButton } from '../components/ui/action-button';
import { Section } from './section';

/*
 * The Needs you deck's real module (ADR 0019, MMR-721 refinement) over a
 * fixture review report: every kind of card, a long title, a stop with no
 * reason, a bundle with no tasks, and a project missing from the report's
 * projects, with a control for a three-digit queue. Clear stop and the answer
 * take a moment and then drop their card from the fixture, as a refetch
 * would, or are refused. Review N decisions opens the walkthrough's real
 * address. The Chromium harness serves this demo too (e2e/needs-you-deck.test.ts).
 */

type Row = ReviewReport['needsYou'][number]['rows'][number];

const NOW = Date.now();
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000);

function task(
  id: string,
  title: string,
  fields: Partial<EngineNode> & Pick<EngineNode, 'status'>,
): EngineNode {
  return {
    createdAt: minutesAgo(60 * 24 * 7),
    id,
    parent: `${id.slice(0, id.indexOf('-'))}-1`,
    title,
    type: 'task',
    updatedAt: minutesAgo(60),
    ...fields,
  };
}

function question(id: string, title: string, asked: string, minutes: number): Row {
  return {
    kind: 'task',
    question: asked,
    reason: 'needs_answers',
    stale: false,
    task: task(id, title, {
      grooming: 'needs_answers',
      status: 'ready',
      updatedAt: minutesAgo(minutes),
    }),
  };
}

function blockedOnYou(id: string, title: string, reason: string, minutes: number): Row {
  return {
    kind: 'task',
    question: null,
    reason: 'blocked',
    stale: false,
    task: task(id, title, {
      blockOwner: 'you',
      hold: 'blocked',
      holdReason: reason,
      priority: 'p1',
      size: 'small',
      status: 'blocked',
      updatedAt: minutesAgo(minutes),
    }),
  };
}

function stop(id: string, title: string, reason: string | null, minutes: number): Row {
  const project = id.slice(0, id.indexOf('-'));
  return {
    delivery: {
      hold_reason: reason,
      id,
      lifecycle: 'running',
      phase: `${project}-2`,
      project,
      seq: Number(id.slice(id.indexOf('-d') + 2)),
      title,
      updated_at: minutesAgo(minutes),
    },
    kind: 'delivery',
  };
}

function decision(id: string, delivery: string | null, tasks: string[], minutes: number): Row {
  const at = minutesAgo(minutes);
  return {
    decision: {
      class: 'product',
      created_at: at,
      delivery,
      id,
      lifecycle: 'provisional',
      option_details: [null, null],
      options: ['Keep it', 'Drop it'],
      outcome_note: null,
      overturn_option: null,
      project_key: id.slice(0, id.indexOf('-')),
      question: `Question ${id}?`,
      recommended: 1,
      seq: Number(id.slice(id.indexOf('-q') + 2)),
      taken: 1,
      tasks,
      updated_at: at,
      why: null,
    },
    kind: 'decision',
    workBuiltOnIt: tasks.length > 0,
  };
}

const LM_TASKS = ['LM-601', 'LM-602', 'LM-603', 'LM-604', 'LM-605', 'LM-606', 'LM-607', 'LM-608'];

/** The fixture's rows, in the needs-you order: stops, decisions with work, blocks, questions, other decisions. */
const ROWS: Row[] = [
  stop(
    'FLT-d2',
    'Rolling host upgrades',
    'Stopped by its time cap after 4 hours. FLT-88’s drain step hung on asgard, waiting for a lease that never expired. Clearing the stop wakes the delivery’s agent, which picks up at FLT-88.',
    25,
  ),
  stop(
    'MMR-d9',
    'Offline outbox',
    'The outbox migration needs a decision on whether to keep queued writes older than seven days.',
    120,
  ),
  ...Array.from({ length: 12 }, (_, at) =>
    decision(
      `LM-q${String(at + 1)}`,
      'LM-d3',
      [LM_TASKS[at % LM_TASKS.length] ?? 'LM-601'],
      40 + at,
    ),
  ),
  decision('FLT-q1', 'FLT-d2', ['FLT-88', 'FLT-89'], 60),
  decision('FLT-q2', 'FLT-d2', ['FLT-90', 'FLT-91'], 70),
  decision('FLT-q3', 'FLT-d2', [], 80),
  blockedOnYou(
    'MMR-688',
    'Rotate the host’s release signing key',
    'Add the new key to the release runner’s secrets.',
    60 * 24,
  ),
  blockedOnYou(
    'LM-571',
    'Publish the signed macOS build to the release channel once the notarization account is approved and the build passes its checks',
    'Approve the notarization account in the Apple developer portal.',
    60 * 72,
  ),
  question(
    'MMR-731',
    'Show a run’s cost on the delivery page',
    'Should cost show for each run, or summed for the whole delivery?',
    300,
  ),
  question(
    'HUGI-15',
    'Keep run logs and make them readable',
    'Where are logs read: in the console, or only from the CLI?',
    60 * 30,
  ),
  question(
    'LM-640',
    'Print a channel’s state as JSON',
    'Should the JSON include retired channels?',
    60 * 48,
  ),
  stop('LM-d5', 'Retire the legacy channel index', null, 60 * 50),
  decision('MMR-q41', null, [], 360),
  decision('MMR-q42', null, [], 380),
  decision('MMR-q43', null, [], 400),
];

/** Questions enough to take the queue past a hundred. */
const MANY: Row[] = Array.from({ length: 110 }, (_, at) =>
  question(
    `MMR-${String(900 + at)}`,
    `Queued question ${String(at + 1)}`,
    'Which way?',
    60 * 50 + at,
  ),
);

const idOf = (row: Row): string => {
  if (row.kind === 'task') {
    return row.task.id;
  }
  return row.kind === 'decision' ? row.decision.id : row.delivery.id;
};
const projectOf = (row: Row) => idOf(row).slice(0, idOf(row).indexOf('-'));

/** Hugi is left out of the report's projects, so its cards show its key alone. */
const PROJECTS = new Map([
  ['FLT', 'Fleet'],
  ['LM', 'Loom CLI'],
  ['MMR', 'Mimir'],
]);

/** The fixture report over `rows`, its queue in their order and its groups by project. */
function reportOf(rows: readonly Row[]): ReviewReport {
  const keys = [...new Set(rows.map(projectOf))];
  const project = ([key, name]: [string, string]) => ({
    goingCold: 0,
    inFlight: 0,
    key,
    live: 0,
    name,
    needsYou: rows.filter((row) => projectOf(row) === key).length,
    triage: 0,
  });
  return {
    goingCold: [],
    lastFinished: null,
    needsYou: keys.map((key) => ({
      project: { key, name: PROJECTS.get(key) ?? key },
      rows: rows.filter((row) => projectOf(row) === key),
    })),
    needsYouFacts: {
      bundles: [
        { set: { id: 'LM-d3', kind: 'delivery' }, tasks: LM_TASKS },
        {
          set: { id: 'FLT-d2', kind: 'delivery' },
          tasks: ['FLT-88', 'FLT-89', 'FLT-90', 'FLT-91'],
        },
        { set: { key: 'MMR', kind: 'project' }, tasks: [] },
      ],
      deliveries: [
        {
          id: 'FLT-d2',
          phase: { id: 'FLT-2', title: 'Fleet 2.1: host upgrades' },
          title: 'Rolling host upgrades',
        },
        { id: 'MMR-d9', phase: { id: 'MMR-2', title: null }, title: 'Offline outbox' },
        {
          id: 'LM-d3',
          phase: { id: 'LM-2', title: 'Loom 3.0: release channels' },
          title: 'Release channels',
        },
        {
          id: 'LM-d5',
          phase: { id: 'LM-2', title: 'Loom 3.0: release channels' },
          title: 'Retire the legacy channel index',
        },
      ],
    },
    now: [],
    projects: [...PROJECTS].map(project),
    queue: rows.map((row) => ({ id: idOf(row), kind: row.kind })),
    runnable: [],
    shipped: [],
    triage: [],
  };
}

/** How long a fixture write takes, so its in-flight state shows. */
const WRITE_MS = 600;

function wait(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** What the kit's answer dialog does: drop the task, or refuse. */
const Answering = createContext<(task: string) => Promise<void>>(async () => undefined);

/** The answer dialog's stand-in: the console's Reason pattern, as `GroomingAnswerDialog` builds on it. */
function KitAnswerDialog({
  nodeId,
  question: asked,
  offline,
  onClose,
}: {
  nodeId: string;
  question: string | null;
  offline: boolean;
  onClose: () => void;
}) {
  const answer = useContext(Answering);
  return (
    <Reason
      open
      required
      onClose={onClose}
      title="Answer"
      label="Answer (required)"
      placeholder="Answer (required) — saved as a note on the task"
      lead={
        asked === null ? undefined : <blockquote className="text-meta text-ink">{asked}</blockquote>
      }
      commitHeld={offline}
      commits={[{ label: 'Answer', onCommit: () => answer(nodeId) }]}
    />
  );
}

function Control({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <ActionButton size="sm" variant="outline" onClick={onClick}>
      {children}
    </ActionButton>
  );
}

/**
 * The deck over the fixture and its controls; also the Chromium harness's
 * page, which can start it with only the records `only` names.
 */
export function NeedsYouDeckDemo({ only }: { only?: readonly string[] }) {
  const [rows, setRows] = useState<readonly Row[]>(() =>
    only === undefined ? ROWS : ROWS.filter((row) => only.includes(idOf(row))),
  );
  const [offline, setOffline] = useState(false);
  const [refuse, setRefuse] = useState(false);
  // Read by a write once it has waited, so a write follows the toggle as it stands then.
  const refusing = useRef(false);
  const report = useMemo(() => reportOf(rows), [rows]);

  // A write that lands drops its row, as the refetch after it would; a refused one toasts.
  const write = useCallback(async (kind: Row['kind'], id: string) => {
    await wait(WRITE_MS);
    if (refusing.current) {
      toast.error(`The fixture refused ${id}.`);
      throw new Error('refused');
    }
    setRows((current) => current.filter((row) => row.kind !== kind || idOf(row) !== id));
  }, []);
  const writes = useMemo<NeedsYouWrites>(
    () => ({ AnswerDialog: KitAnswerDialog, clearStop: (id) => write('delivery', id) }),
    [write],
  );
  const answer = useCallback((id: string) => write('task', id), [write]);

  return (
    <Answering.Provider value={answer}>
      <div className="flex flex-col gap-3" data-kit="needs-you-deck">
        <div className="flex flex-wrap gap-2">
          <Control onClick={() => setRows(ROWS)}>Fixture</Control>
          <Control onClick={() => setRows([...ROWS, ...MANY])}>Three-digit queue</Control>
          <Control onClick={() => setRows([])}>Nothing needs you</Control>
          <Control onClick={() => setOffline((value) => !value)}>
            {offline ? 'Go online' : 'Go offline'}
          </Control>
          <Control
            onClick={() => {
              refusing.current = !refuse;
              setRefuse(!refuse);
            }}
          >
            {refuse ? 'Let writes land' : 'Refuse writes'}
          </Control>
        </div>
        <NeedsYouDeckView report={report} writes={writes} offline={offline} seeAll={{ to: '/' }} />
      </div>
    </Answering.Provider>
  );
}

export function NeedsYouDeckKit() {
  return (
    <Section title="Needs you deck over a review report">
      <p className="m-0 text-meta text-ink-dim">
        The deck’s real module over a fixture report. Clear stop and Answer take a moment, then drop
        their card as a refetch would, unless writes are refused.
      </p>
      <div className="max-w-[900px]">
        <NeedsYouDeckDemo />
      </div>
    </Section>
  );
}

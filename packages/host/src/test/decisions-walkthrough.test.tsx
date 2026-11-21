import type { ConsoleOutput } from '@mimir/contract';
import { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { answerDecisions } from '../api/fns/deliveries';
import { tree } from '../api/fns/shell';
import { deliveryPage, review } from '../api/fns/views';
import { toast } from '../components/patterns/notice';
import { pruneDrafts, readDraft, writeDraft } from '../lib/decision-drafts';
import { consoleRoutes } from '../router';
import { serveBrowse } from './browse-fns';
import { engineProject, engineTree } from './engine-fixtures';
import { engineTask } from './node-fixtures';
import { serveNodes } from './node-fns';
import { renderRoute } from './router';
import { serveShell } from './shell-fns';
import { engineReview, engineWork, stripRow } from './views-fixtures';
import { serveViews } from './views-fns';

vi.mock('../api/fns/deliveries');
vi.mock('../api/fns/browse');
vi.mock('../api/fns/nodes');
vi.mock('../api/fns/shell');
vi.mock('../api/fns/views');
vi.mock('../components/patterns/notice', () => ({
  NoticeHost: () => null,
  toast: { error: vi.fn(), success: vi.fn() },
}));

const stamp = new Date('2026-11-16T12:00:00Z');
type Page = ConsoleOutput<'deliveryPage'>;
type Decision = Page['decisions'][number];

/** A provisional decision of delivery MMR-d3; `seq` also numbers its id. */
function decision(seq: number, over: Partial<Decision> = {}): Decision {
  const options = over.options ?? ['Keep', 'Remove', 'Merge'];
  return {
    class: 'product',
    created_at: stamp,
    delivery: 'MMR-d3',
    history: [],
    id: `MMR-q${String(seq)}`,
    lifecycle: 'provisional',
    option_details: options.map(() => null),
    options,
    outcome_note: null,
    overturn_option: null,
    project_key: 'MMR',
    question: `Question ${String(seq)}?`,
    recommended: 1,
    seq,
    taken: 1,
    tasks: ['MMR-3'],
    updated_at: stamp,
    why: null,
    ...over,
  };
}

/** q3 is listed first on purpose: the walkthrough reads oldest first. */
function decisions(): Decision[] {
  return [
    decision(3, { options: ['Alpha', 'Beta'], recommended: 1, tasks: ['MMR-3', 'MMR-4'] }),
    decision(1, { recommended: 2, why: 'It was cheaper.' }),
    decision(2, { options: ['Yes', 'No'], recommended: 2, taken: 2, tasks: [] }),
  ];
}

const task = (id: string, title: string) => engineTask({ id, status: 'in_progress', title });

function page(list: Decision[] = decisions()): Page {
  return {
    decisions: list,
    delivery: {
      agreement: 'Ship it',
      branch: 'delivery/console',
      created_at: stamp,
      declined: [],
      elapsed_minutes: 42,
      external_ref: null,
      follow_ups: [],
      harness: null,
      history: [],
      hold: 'none',
      hold_reason: null,
      host: null,
      id: 'MMR-d3',
      journal: { artifacts: [], scratchpad: null },
      lifecycle: 'running',
      limitations: [],
      members: ['MMR-3', 'MMR-4'],
      phase: 'MMR-2',
      project_key: 'MMR',
      seq: 3,
      session: null,
      time_cap_minutes: null,
      title: 'Deliver the console',
      updated_at: stamp,
    },
    followUps: [],
    journal: [],
    members: [task('MMR-3', 'Build the page'), task('MMR-4', 'Wire the rail')],
    now: [],
    phase: engineTask({ id: 'MMR-2', status: 'in_progress', title: 'Console phase' }),
  };
}

/** A needs-you row for a decision with no delivery. */
function projectRow(seq: number) {
  return {
    decision: decision(seq, { delivery: null, tasks: ['MMR-5'] }),
    kind: 'decision' as const,
    workBuiltOnIt: true,
  };
}

const recorded = (id: string, outcome: 'confirmed' | 'overturned', tasks: string[] = []) => ({
  id,
  outcome,
  record: { ...decision(Number(id.slice(5))), tasks },
});

beforeEach(() => {
  localStorage.clear();
  serveBrowse();
  serveNodes({ nodes: [engineProject({ id: 'MMR', title: 'Mimir' })] });
  serveShell({ projects: [engineProject({ id: 'MMR', title: 'Mimir' })] });
  serveViews();
  vi.mocked(deliveryPage).mockResolvedValue(page());
  vi.mocked(answerDecisions).mockImplementation(async ({ data }) => ({
    results: data.answers.map((a) =>
      recorded(a.id, a.verdict === 'confirm' ? 'confirmed' : 'overturned'),
    ),
    wake: { state: 'sent' },
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5000 } } });

async function openDelivery(path = '/p/MMR/d3?mode=decisions', qc = client()) {
  const view = await renderRoute(consoleRoutes, path, qc);
  const layer = await screen.findByRole('dialog');
  return { ...view, layer, qc };
}
async function openProject(rows = [projectRow(2), projectRow(1)]) {
  serveViews({ projects: { MMR: engineWork({ needsYou: rows }) } });
  vi.mocked(tree).mockResolvedValue(
    engineTree({ id: 'MMR', status: 'ready', type: 'project' }, [
      engineTree({
        id: 'MMR-5',
        parent: 'MMR',
        status: 'ready',
        title: 'Project task',
        type: 'task',
      }),
    ]),
  );
  const view = await renderRoute(consoleRoutes, '/p/MMR?mode=decisions', client());
  return { ...view, layer: await screen.findByRole('dialog') };
}

const heading = (layer: HTMLElement, name: string | RegExp) =>
  within(layer).findByRole('heading', { name });
const button = (layer: HTMLElement, name: string | RegExp) =>
  within(layer).getByRole('button', { name });
const next = (layer: HTMLElement) =>
  button(layer, /(Confirm|Overturn|Use my answer) and (continue|review)/);
const pick = (layer: HTMLElement, name: string | RegExp) =>
  fireEvent.click(within(layer).getByRole('radio', { name }));

/** Walk from the first step to the check step, confirming each answer as it stands. */
async function toCheck(layer: HTMLElement) {
  fireEvent.click(next(layer));
  await heading(layer, 'Question 2?');
  fireEvent.click(next(layer));
  await heading(layer, 'Question 3?');
  fireEvent.click(next(layer));
  await heading(layer, 'Check your answers');
}

test('a delivery address opens its provisional decisions, oldest first', async () => {
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  expect(within(layer).getByText('1 of 3')).toBeInTheDocument();
  expect(layer).toHaveAccessibleName('Deliver the console MMR-d3');
  const rail = within(layer).getByRole('navigation', { name: 'Decisions' });
  const order = within(rail)
    .getAllByRole('button')
    .map((b) => b.textContent);
  expect(order[0]).toContain('Question 1?');
  expect(order[1]).toContain('Question 2?');
  expect(order[2]).toContain('Question 3?');
  expect(order[3]).toContain('Check and send');
  expect(button(layer, 'Close the walkthrough')).toBeInTheDocument();
});

test('a project address opens its decisions with no delivery, oldest first, titled from its tree', async () => {
  const { layer } = await openProject();
  await heading(layer, 'Question 1?');
  expect(layer).toHaveAccessibleName('Decisions without a delivery MMR');
  expect(within(layer).getByText('1 of 2')).toBeInTheDocument();
  const built = within(layer).getByText('Built on this answer').parentElement!;
  expect(built).toHaveTextContent('MMR-5');
  expect(built).toHaveTextContent('Project task');
});

test('a mode it does not know is dropped and shows the page', async () => {
  const { router } = await renderRoute(consoleRoutes, '/p/MMR/d3?mode=other', client());
  await screen.findByRole('heading', { name: 'Deliver the console' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(router.state.location.search).not.toHaveProperty('mode', 'other');
});

test('the taken option is selected and flagged, with the recommendation named when it differs', async () => {
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  const group = within(layer).getByRole('radiogroup', { name: 'Your answer to MMR-q1' });
  expect(within(group).getByRole('radio', { name: /^Keep/ })).toBeChecked();
  expect(within(group).getByRole('radio', { name: /^Keep/ })).toHaveAccessibleName(
    /Agent's answer/,
  );
  expect(within(group).getByRole('radio', { name: /^Remove/ })).toHaveAccessibleName(
    /Agent recommends/,
  );
  expect(within(group).getByRole('radio', { name: 'Something else' })).not.toBeChecked();
  expect(layer).toHaveTextContent('It took Keep and kept building. It recommends Remove.');
  expect(layer).toHaveTextContent('It was cheaper.');
  expect(layer).toHaveTextContent('MMR-3Build the page');
});

test('the effect line and the step button follow the selection', async () => {
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  expect(layer).toHaveTextContent('Confirming changes nothing. MMR-3 stays as built.');
  expect(button(layer, 'Confirm and continue (MMR-q1)')).toBeEnabled();
  pick(layer, /^Remove/);
  expect(layer).toHaveTextContent('Overturning sends MMR-3 back for rework.');
  expect(button(layer, 'Overturn and continue (MMR-q1)')).toBeEnabled();
  pick(layer, 'Something else');
  expect(layer).toHaveTextContent(
    'Your answer overturns this decision and sends MMR-3 back for rework.',
  );
  expect(button(layer, 'Use my answer and continue (MMR-q1)')).toBeDisabled();
});

test('Something else hides the note box and sends its text as the note, with no option', async () => {
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  const note = within(layer).getByRole('textbox', { name: 'Add a note for the agent (optional)' });
  fireEvent.change(note, { target: { value: 'ignored' } });
  pick(layer, 'Something else');
  expect(
    within(layer).queryByRole('textbox', { name: 'Add a note for the agent (optional)' }),
  ).toBeNull();
  expect(
    within(within(layer).getByRole('radiogroup')).queryByRole('textbox', {
      name: 'Your own answer',
    }),
  ).toBeNull();
  fireEvent.change(within(layer).getByRole('textbox', { name: 'Your own answer' }), {
    target: { value: ' Drop it entirely ' },
  });
  fireEvent.click(button(layer, 'Use my answer and continue (MMR-q1)'));
  await heading(layer, 'Question 2?');
  fireEvent.click(next(layer));
  await heading(layer, 'Question 3?');
  fireEvent.click(next(layer));
  await heading(layer, 'Check your answers');
  expect(layer).toHaveTextContent('OverturnedDrop it entirely');
  fireEvent.click(button(layer, 'Send 3 answers'));
  await heading(layer, 'Answers sent');
  expect(vi.mocked(answerDecisions).mock.calls[0]![0].data.answers[0]).toStrictEqual({
    id: 'MMR-q1',
    note: 'Drop it entirely',
    verdict: 'overturn',
  });
});

test('an overturn to another option carries its note, and a confirm its note', async () => {
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  pick(layer, /^Merge/);
  fireEvent.change(
    within(layer).getByRole('textbox', { name: 'Add a note for the agent (optional)' }),
    { target: { value: 'Merge is closer' } },
  );
  fireEvent.click(next(layer));
  await heading(layer, 'Question 2?');
  fireEvent.change(
    within(layer).getByRole('textbox', { name: 'Add a note for the agent (optional)' }),
    { target: { value: 'Agreed' } },
  );
  fireEvent.click(next(layer));
  await heading(layer, 'Question 3?');
  fireEvent.click(next(layer));
  await heading(layer, 'Check your answers');
  expect(layer).toHaveTextContent('Redoes MMR-3');
  expect(layer).toHaveTextContent('Nothing to redo');
  fireEvent.click(button(layer, 'Send 3 answers'));
  await heading(layer, 'Answers sent');
  expect(vi.mocked(answerDecisions).mock.calls[0]![0].data.answers.slice(0, 2)).toStrictEqual([
    { id: 'MMR-q1', note: 'Merge is closer', option: 3, verdict: 'overturn' },
    { id: 'MMR-q2', note: 'Agreed', verdict: 'confirm' },
  ]);
});

test('Back returns to the step before and Change returns from the check step, keeping answers', async () => {
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  expect(button(layer, 'Back')).toBeDisabled();
  pick(layer, /^Remove/);
  fireEvent.click(next(layer));
  await heading(layer, 'Question 2?');
  fireEvent.click(button(layer, 'Back'));
  await heading(layer, 'Question 1?');
  expect(within(layer).getByRole('radio', { name: /^Remove/ })).toBeChecked();
  fireEvent.click(next(layer));
  await heading(layer, 'Question 2?');
  fireEvent.click(next(layer));
  await heading(layer, 'Question 3?');
  fireEvent.click(next(layer));
  await heading(layer, 'Check your answers');
  fireEvent.click(button(layer, 'Change your answer to MMR-q2'));
  await heading(layer, 'Question 2?');
  // The rail marks answered steps and opens them again.
  const rail = within(layer).getByRole('navigation', { name: 'Decisions' });
  expect(within(rail).getByRole('button', { name: /Question 1\?/ })).toHaveTextContent(
    'OverturnedRemove',
  );
  fireEvent.click(within(rail).getByRole('button', { name: /Question 1\?/ }));
  await heading(layer, 'Question 1?');
});

test('Send writes every answer once, in order, for the delivery', async () => {
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  await toCheck(layer);
  expect(layer).toHaveTextContent(
    'Sending records every answer and wakes the agent on MMR-d3 once if any answer overturns.',
  );
  fireEvent.click(button(layer, 'Send 3 answers'));
  await heading(layer, 'Answers sent');
  expect(answerDecisions).toHaveBeenCalledTimes(1);
  expect(vi.mocked(answerDecisions).mock.calls[0]![0].data).toMatchObject({
    answers: [
      { id: 'MMR-q1', verdict: 'confirm' },
      { id: 'MMR-q2', verdict: 'confirm' },
      { id: 'MMR-q3', verdict: 'confirm' },
    ],
    delivery: 'MMR-d3',
  });
});

test('a project walkthrough sends with a null delivery and says "Answers recorded"', async () => {
  const { layer } = await openProject();
  await heading(layer, 'Question 1?');
  fireEvent.click(next(layer));
  await heading(layer, 'Question 2?');
  fireEvent.click(button(layer, 'Confirm and review (MMR-q2)'));
  await heading(layer, 'Check your answers');
  expect(layer).toHaveTextContent('Sending records every answer.');
  fireEvent.click(button(layer, 'Send 2 answers'));
  await heading(layer, 'Answers recorded');
  expect(vi.mocked(answerDecisions).mock.calls[0]![0].data.delivery).toBeNull();
  expect(within(layer).getByRole('link', { name: 'Back to MMR' })).toHaveAttribute(
    'href',
    '/p/MMR',
  );
});

test('a single decision has no check step: its step commits and reads send', async () => {
  vi.mocked(deliveryPage).mockResolvedValue(page([decision(1)]));
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  expect(within(layer).queryByRole('navigation', { name: 'Decisions' })?.textContent).not.toContain(
    'Check and send',
  );
  expect(button(layer, 'Confirm and send (MMR-q1)')).toBeEnabled();
  pick(layer, /^Remove/);
  expect(button(layer, 'Overturn and send (MMR-q1)')).toBeEnabled();
  pick(layer, 'Something else');
  expect(button(layer, 'Send my answer (MMR-q1)')).toBeDisabled();
  pick(layer, /^Keep/);
  fireEvent.click(button(layer, 'Confirm and send (MMR-q1)'));
  await heading(layer, 'Answers sent');
  expect(vi.mocked(answerDecisions).mock.calls[0]![0].data.answers).toStrictEqual([
    { id: 'MMR-q1', verdict: 'confirm' },
  ]);
});

test('the done screen lists refused and failed answers with reasons, the rework, and the next set', async () => {
  vi.mocked(answerDecisions).mockResolvedValue({
    results: [
      recorded('MMR-q1', 'overturned', ['MMR-3']),
      { id: 'MMR-q2', outcome: 'refused', reason: 'MMR-q2 is already confirmed' },
      { id: 'MMR-q3', outcome: 'failed' },
    ],
    wake: { state: 'sent' },
  });
  const other = decision(9, { delivery: 'MMR-d4', question: 'Elsewhere?' });
  serveViews({
    review: engineReview({
      needsYou: [
        {
          project: { key: 'MMR', name: 'Mimir' },
          rows: [{ decision: other, kind: 'decision', workBuiltOnIt: true }],
        },
      ],
      projects: [stripRow({ key: 'MMR', name: 'Mimir' }, { needsYou: 1 })],
      queue: [{ id: 'MMR-q9', kind: 'decision' }],
    }),
  });
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  await toCheck(layer);
  fireEvent.click(button(layer, 'Send 3 answers'));
  await heading(layer, 'Answers sent');
  expect(layer).toHaveTextContent('MMR-3 goes back for rework.');
  const refused = within(layer).getByRole('list', { name: 'Not recorded' });
  expect(refused).toHaveTextContent('Question 2?MMR-q2 is already confirmed');
  expect(refused).toHaveTextContent('Question 3?');
  expect(layer).toHaveTextContent('MMR-d4 has 1 decision for you');
  expect(within(layer).getByRole('link', { name: 'Review it' })).toHaveAttribute(
    'href',
    '/p/MMR/d4?mode=decisions',
  );
  expect(within(layer).getByRole('link', { name: 'Back to MMR-d3' })).toHaveAttribute(
    'href',
    '/p/MMR/d3',
  );
});

test('drafts restore on reopening, clear for recorded answers, and stay for refused ones', async () => {
  writeDraft('MMR-q1', { answer: '', choice: 3, note: 'Kept note', set: 'MMR-d3' });
  writeDraft('MMR-q8', { answer: '', choice: 1, note: 'gone', set: 'MMR-d3' });
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  expect(within(layer).getByRole('radio', { name: /^Merge/ })).toBeChecked();
  expect(
    within(layer).getByRole('textbox', { name: 'Add a note for the agent (optional)' }),
  ).toHaveValue('Kept note');
  // A draft whose decision is not in the set is removed on opening.
  expect(readDraft('MMR-q8')).toBeNull();
  // Changes are written as they are made.
  pick(layer, /^Remove/);
  expect(readDraft('MMR-q1')).toMatchObject({ choice: 2, note: 'Kept note', set: 'MMR-d3' });
  vi.mocked(answerDecisions).mockResolvedValue({
    results: [
      recorded('MMR-q1', 'overturned'),
      recorded('MMR-q2', 'confirmed'),
      { id: 'MMR-q3', outcome: 'refused', reason: 'answered elsewhere' },
    ],
    wake: { state: 'sent' },
  });
  fireEvent.change(
    within(layer).getByRole('textbox', { name: 'Add a note for the agent (optional)' }),
    { target: { value: 'Final note' } },
  );
  fireEvent.click(next(layer));
  await heading(layer, 'Question 2?');
  pick(layer, /^Yes/);
  fireEvent.click(next(layer));
  await heading(layer, 'Question 3?');
  pick(layer, /^Beta/);
  fireEvent.click(next(layer));
  await heading(layer, 'Check your answers');
  fireEvent.click(button(layer, 'Send 3 answers'));
  await heading(layer, 'Answers sent');
  expect(readDraft('MMR-q1')).toBeNull();
  expect(readDraft('MMR-q2')).toBeNull();
  expect(readDraft('MMR-q3')).toMatchObject({ choice: 2 });
});

test('focus lands on each screen heading and never on a committing button', async () => {
  const { layer } = await openDelivery();
  const first = await heading(layer, 'Question 1?');
  await waitFor(() => {
    expect(first).toHaveFocus();
  });
  fireEvent.click(next(layer));
  const second = await heading(layer, 'Question 2?');
  await waitFor(() => {
    expect(second).toHaveFocus();
  });
  fireEvent.click(next(layer));
  fireEvent.click(next(layer));
  const check = await heading(layer, 'Check your answers');
  await waitFor(() => {
    expect(check).toHaveFocus();
  });
  expect(button(layer, 'Send 3 answers')).not.toHaveFocus();
  fireEvent.click(button(layer, 'Send 3 answers'));
  const done = await heading(layer, 'Answers sent');
  await waitFor(() => {
    expect(done).toHaveFocus();
  });
});

/*
 * A double click's second click lands on the next screen's button in the same
 * place: `detail` 2 on a button that was not there for the first.
 */
test('a double click on Continue moves exactly one step', async () => {
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  fireEvent.click(next(layer), { detail: 1 });
  await heading(layer, 'Question 2?');
  fireEvent.click(next(layer), { detail: 2 });
  await act(() => Promise.resolve());
  expect(within(layer).getByRole('heading', { name: 'Question 2?' })).toBeInTheDocument();
  // A key's activation has no click count, and still moves on.
  fireEvent.click(next(layer), { detail: 0 });
  await heading(layer, 'Question 3?');
});

test('a double click on Review shows the check step and writes nothing', async () => {
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  fireEvent.click(next(layer));
  await heading(layer, 'Question 2?');
  fireEvent.click(next(layer));
  await heading(layer, 'Question 3?');
  fireEvent.click(next(layer), { detail: 1 });
  await heading(layer, 'Check your answers');
  fireEvent.click(button(layer, 'Send 3 answers'), { detail: 2 });
  await act(() => Promise.resolve());
  expect(answerDecisions).not.toHaveBeenCalled();
  expect(within(layer).getByRole('heading', { name: 'Check your answers' })).toBeInTheDocument();
  fireEvent.click(button(layer, 'Send 3 answers'), { detail: 0 });
  await heading(layer, 'Answers sent');
  expect(answerDecisions).toHaveBeenCalledTimes(1);
});

test('offline disables Send while stepping still works', async () => {
  const { layer, qc } = await openDelivery();
  await heading(layer, 'Question 1?');
  await toCheck(layer);
  vi.mocked(deliveryPage).mockRejectedValue(new Error('unreachable'));
  await qc.refetchQueries({ queryKey: ['nodes', 'delivery', 'MMR-d3'] });
  await waitFor(() => {
    expect(within(layer).getByRole('status')).toHaveTextContent('Offline');
  });
  expect(button(layer, 'Send 3 answers')).toBeDisabled();
  expect(button(layer, 'Back')).toBeEnabled();
});

test('offline disables the one-decision commit', async () => {
  vi.mocked(deliveryPage).mockResolvedValue(page([decision(1)]));
  const { layer, qc } = await openDelivery();
  await heading(layer, 'Question 1?');
  vi.mocked(deliveryPage).mockRejectedValue(new Error('unreachable'));
  await qc.refetchQueries({ queryKey: ['nodes', 'delivery', 'MMR-d3'] });
  await waitFor(() => {
    expect(button(layer, 'Confirm and send (MMR-q1)')).toBeDisabled();
  });
});

test('a decision that leaves the live read says so and is left out of Send', async () => {
  const { layer, qc } = await openDelivery();
  await heading(layer, 'Question 1?');
  vi.mocked(deliveryPage).mockResolvedValue(page(decisions().filter((d) => d.id !== 'MMR-q2')));
  await qc.refetchQueries({ queryKey: ['nodes', 'delivery', 'MMR-d3'] });
  fireEvent.click(next(layer));
  await heading(layer, 'Question 2?');
  expect(layer).toHaveTextContent('This decision no longer waits on you');
  expect(within(layer).queryByRole('radiogroup')).toBeNull();
  fireEvent.click(button(layer, /^Continue/));
  await heading(layer, 'Question 3?');
  fireEvent.click(next(layer));
  await heading(layer, 'Check your answers');
  expect(layer).not.toHaveTextContent('Question 2?Confirmed');
  fireEvent.click(button(layer, 'Send 2 answers'));
  await heading(layer, 'Answers sent');
  expect(vi.mocked(answerDecisions).mock.calls[0]![0].data.answers.map((a) => a.id)).toStrictEqual([
    'MMR-q1',
    'MMR-q3',
  ]);
});

test('a decision resolved elsewhere while its answers hold focus returns focus to the step heading', async () => {
  const { layer, qc } = await openDelivery();
  const question = await heading(layer, 'Question 1?');
  const answer = within(layer).getByRole('radio', { name: /^Keep/ });
  act(() => answer.focus());
  expect(answer).toHaveFocus();
  vi.mocked(deliveryPage).mockResolvedValue(page(decisions().filter((d) => d.id !== 'MMR-q1')));
  await act(() => qc.refetchQueries({ queryKey: ['nodes', 'delivery', 'MMR-d3'] }));
  await waitFor(() => expect(layer).toHaveTextContent('This decision no longer waits on you'));
  await waitFor(() => expect(question).toHaveFocus());
});

test('a decision resolved elsewhere while its note holds focus returns focus to the step heading', async () => {
  const { layer, qc } = await openDelivery();
  const question = await heading(layer, 'Question 1?');
  const note = within(layer).getByRole('textbox', { name: /Add a note/ });
  act(() => note.focus());
  vi.mocked(deliveryPage).mockResolvedValue(page(decisions().filter((d) => d.id !== 'MMR-q1')));
  await act(() => qc.refetchQueries({ queryKey: ['nodes', 'delivery', 'MMR-d3'] }));
  await waitFor(() => expect(within(layer).queryByRole('textbox')).toBeNull());
  await waitFor(() => expect(question).toHaveFocus());
});

test('a check-step entry that drops out while its Change holds focus returns focus to the heading', async () => {
  const { layer, qc } = await openDelivery();
  await heading(layer, 'Question 1?');
  await toCheck(layer);
  const check = await heading(layer, 'Check your answers');
  const change = button(layer, 'Change your answer to MMR-q2');
  act(() => change.focus());
  vi.mocked(deliveryPage).mockResolvedValue(page(decisions().filter((d) => d.id !== 'MMR-q2')));
  await act(() => qc.refetchQueries({ queryKey: ['nodes', 'delivery', 'MMR-d3'] }));
  await waitFor(() => expect(change).not.toBeInTheDocument());
  await waitFor(() => expect(check).toHaveFocus());
});

test('a write in flight disables Send, Back, Change, and Close', async () => {
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof answerDecisions>>>();
  vi.mocked(answerDecisions).mockReturnValue(gate.promise);
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  await toCheck(layer);
  fireEvent.click(button(layer, 'Send 3 answers'));
  await waitFor(() => {
    expect(button(layer, 'Sending…')).toBeDisabled();
  });
  expect(button(layer, 'Back')).toBeDisabled();
  expect(button(layer, 'Change your answer to MMR-q1')).toBeDisabled();
  expect(button(layer, 'Close the walkthrough')).toBeDisabled();
  gate.resolve({ results: [recorded('MMR-q1', 'confirmed')], wake: { state: 'sent' } });
  await heading(layer, 'Answers sent');
});

test('Close leaves the mode and shows the page', async () => {
  const { layer, router } = await openDelivery();
  await heading(layer, 'Question 1?');
  fireEvent.click(button(layer, 'Close the walkthrough'));
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  expect(router.state.location.pathname).toBe('/p/MMR/d3');
  expect(router.state.location.search).not.toHaveProperty('mode', 'decisions');
  await screen.findByRole('heading', { name: 'Deliver the console' });
});

test('an empty set says nothing waits and links back', async () => {
  vi.mocked(deliveryPage).mockResolvedValue(page([]));
  const { layer } = await openDelivery();
  await heading(layer, 'Nothing waits on you here');
  expect(within(layer).getByRole('link', { name: 'Back to MMR-d3' })).toBeInTheDocument();
});

test('the review read is not requested before a send', async () => {
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  expect(review).not.toHaveBeenCalled();
});

test('an opening holds the oldest 100 decisions and keeps the drafts of the rest', async () => {
  const many = Array.from({ length: 101 }, (_, i) => decision(101 - i));
  vi.mocked(deliveryPage).mockResolvedValue(page(many));
  writeDraft('MMR-q101', { answer: '', choice: 2, note: 'Later', set: 'MMR-d3' });
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  expect(within(layer).getByText('1 of 100')).toBeInTheDocument();
  const rail = within(layer).getByRole('navigation', { name: 'Decisions' });
  expect(rail).toHaveTextContent('Question 100?');
  expect(rail).not.toHaveTextContent('Question 101?');
  expect(readDraft('MMR-q101')).toMatchObject({ note: 'Later' });
});

test('a decision that joins the live read after opening waits for the next opening', async () => {
  const { layer, qc } = await openDelivery();
  await heading(layer, 'Question 1?');
  vi.mocked(deliveryPage).mockResolvedValue(page([...decisions(), decision(4)]));
  await qc.refetchQueries({ queryKey: ['nodes', 'delivery', 'MMR-d3'] });
  expect(within(layer).getByText('1 of 3')).toBeInTheDocument();
  await toCheck(layer);
  expect(layer).not.toHaveTextContent('Question 4?');
  fireEvent.click(button(layer, 'Send 3 answers'));
  await heading(layer, 'Answers sent');
  expect(vi.mocked(answerDecisions).mock.calls[0]![0].data.answers.map((a) => a.id)).toStrictEqual([
    'MMR-q1',
    'MMR-q2',
    'MMR-q3',
  ]);
});

test('Escape does nothing while a Send is in flight', async () => {
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof answerDecisions>>>();
  vi.mocked(answerDecisions).mockReturnValue(gate.promise);
  const { layer, router } = await openDelivery();
  await heading(layer, 'Question 1?');
  await toCheck(layer);
  fireEvent.click(button(layer, 'Send 3 answers'));
  await waitFor(() => {
    expect(button(layer, 'Sending…')).toBeDisabled();
  });
  fireEvent.keyDown(within(layer).getByRole('heading', { name: 'Check your answers' }), {
    key: 'Escape',
  });
  expect(screen.getByRole('dialog')).toBe(layer);
  expect(router.state.location.search).toHaveProperty('mode', 'decisions');
  gate.resolve({ results: [recorded('MMR-q1', 'confirmed')], wake: { state: 'sent' } });
  await heading(layer, 'Answers sent');
});

test('the rail cannot reach Send while an answer that waits is a blank Something else', async () => {
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  pick(layer, 'Something else');
  fireEvent.change(within(layer).getByRole('textbox', { name: 'Your own answer' }), {
    target: { value: 'Drop it' },
  });
  await toCheck(layer);
  const rail = within(layer).getByRole('navigation', { name: 'Decisions' });
  fireEvent.click(within(rail).getByRole('button', { name: /Question 1\?/ }));
  await heading(layer, 'Question 1?');
  fireEvent.change(within(layer).getByRole('textbox', { name: 'Your own answer' }), {
    target: { value: '  ' },
  });
  expect(within(rail).getByRole('button', { name: 'Check and send' })).toBeDisabled();
  pick(layer, /^Keep/);
  expect(within(rail).getByRole('button', { name: 'Check and send' })).toBeEnabled();
});

/** MMR-q1's Note chip on the page beneath the layer, which leaves once the read drops MMR-q1. */
const noteChip = () => document.querySelector('[aria-label^="Note for MMR-q1"]');

test('a Send in flight keeps its answers on screen when the read drops them first', async () => {
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof answerDecisions>>>();
  vi.mocked(answerDecisions).mockReturnValue(gate.promise);
  const { layer, qc } = await openDelivery();
  await heading(layer, 'Question 1?');
  await toCheck(layer);
  fireEvent.click(button(layer, 'Send 3 answers'));
  await waitFor(() => {
    expect(button(layer, 'Sending…')).toBeDisabled();
  });
  // The write's refetch lands before its answer: the read no longer holds the sent decisions.
  expect(noteChip()).not.toBeNull();
  vi.mocked(deliveryPage).mockResolvedValue(page([]));
  qc.setQueryData(['nodes', 'delivery', 'MMR-d3'], page([]));
  // The page beneath drops the decision once the read lands.
  await waitFor(() => {
    expect(noteChip()).toBeNull();
  });
  expect(button(layer, 'Sending…')).toBeDisabled();
  expect(within(layer).getAllByRole('button', { name: /^Change your answer/ })).toHaveLength(3);
  expect(layer).not.toHaveTextContent('No longer waits on you');
  gate.resolve({ results: [recorded('MMR-q1', 'confirmed')], wake: { state: 'sent' } });
  await heading(layer, 'Answers sent');
});

test('a failed Send returns focus to Send once the write ends', async () => {
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof answerDecisions>>>();
  vi.mocked(answerDecisions).mockReturnValue(gate.promise);
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  await toCheck(layer);
  const send = button(layer, 'Send 3 answers');
  send.focus();
  fireEvent.click(send);
  await waitFor(() => {
    expect(send).toBeDisabled();
  });
  // Focus falls to the page while the write runs, as a disabled control drops it in a browser;
  // jsdom keeps it on a disabled button, so the page reports itself focused instead.
  const refocus = vi.spyOn(send, 'focus');
  const active = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(document.body);
  try {
    gate.reject(new Error('Host unreachable'));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Host unreachable');
    });
    await waitFor(() => {
      expect(refocus).toHaveBeenCalledTimes(1);
    });
  } finally {
    active.mockRestore();
  }
});

test('a failed Send leaves focus where the operator moved it', async () => {
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof answerDecisions>>>();
  vi.mocked(answerDecisions).mockReturnValue(gate.promise);
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  await toCheck(layer);
  const send = button(layer, 'Send 3 answers');
  fireEvent.click(send);
  await waitFor(() => {
    expect(send).toBeDisabled();
  });
  const heading2 = within(layer).getByRole('heading', { name: 'Check your answers' });
  heading2.focus();
  gate.reject(new Error('Host unreachable'));
  await waitFor(() => {
    expect(toast.error).toHaveBeenCalledWith('Host unreachable');
  });
  await waitFor(() => {
    expect(send).toBeEnabled();
  });
  expect(heading2).toHaveFocus();
});

/** Leave q1 a blank "Something else", then reach the check step through the last step's button. */
async function toCheckWithBlank(layer: HTMLElement) {
  await heading(layer, 'Question 1?');
  await toCheck(layer);
  const rail = within(layer).getByRole('navigation', { name: 'Decisions' });
  fireEvent.click(within(rail).getByRole('button', { name: /Question 1\?/ }));
  await heading(layer, 'Question 1?');
  pick(layer, 'Something else');
  fireEvent.click(within(rail).getByRole('button', { name: /Question 3\?/ }));
  await heading(layer, 'Question 3?');
  fireEvent.click(button(layer, 'Confirm and review (MMR-q3)'));
  await heading(layer, 'Check your answers');
}

test('a blank Something else reaching the check step through the last step cannot be sent', async () => {
  const { layer } = await openDelivery();
  await toCheckWithBlank(layer);
  const send = button(layer, 'Send 3 answers');
  expect(send).toBeDisabled();
  fireEvent.click(send);
  expect(answerDecisions).not.toHaveBeenCalled();
});

test('the check step says why Send waits, only while a blank own answer waits', async () => {
  const { layer } = await openDelivery();
  await toCheckWithBlank(layer);
  const reason = 'Write your own answer to "Question 1?", or pick another answer, before sending.';
  expect(within(layer).getByText(reason)).toBeInTheDocument();
  fireEvent.click(button(layer, 'Change your answer to MMR-q1'));
  await heading(layer, 'Question 1?');
  pick(layer, /^Keep/);
  fireEvent.click(next(layer));
  await heading(layer, 'Question 2?');
  fireEvent.click(next(layer));
  await heading(layer, 'Question 3?');
  fireEvent.click(next(layer));
  await heading(layer, 'Check your answers');
  expect(within(layer).queryByText(reason)).toBeNull();
  expect(button(layer, 'Send 3 answers')).toBeEnabled();
});

test('after a failed Send, a decision that leaves the read is no longer shown or sent', async () => {
  vi.mocked(answerDecisions).mockRejectedValueOnce(new Error('Host unreachable'));
  const { layer, qc } = await openDelivery();
  await heading(layer, 'Question 1?');
  await toCheck(layer);
  fireEvent.click(button(layer, 'Send 3 answers'));
  await waitFor(() => {
    expect(toast.error).toHaveBeenCalledWith('Host unreachable');
  });
  await waitFor(() => {
    expect(button(layer, 'Send 3 answers')).toBeEnabled();
  });
  vi.mocked(deliveryPage).mockResolvedValue(page(decisions().filter((d) => d.id !== 'MMR-q2')));
  await qc.refetchQueries({ queryKey: ['nodes', 'delivery', 'MMR-d3'] });
  await waitFor(() => {
    expect(button(layer, 'Send 2 answers')).toBeEnabled();
  });
  fireEvent.click(button(layer, 'Send 2 answers'));
  await heading(layer, 'Answers sent');
  expect(vi.mocked(answerDecisions).mock.calls[1]![0].data.answers.map((a) => a.id)).toStrictEqual([
    'MMR-q1',
    'MMR-q3',
  ]);
});

test('the rail’s entries cannot be activated while a Send writes', async () => {
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof answerDecisions>>>();
  vi.mocked(answerDecisions).mockReturnValue(gate.promise);
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  await toCheck(layer);
  fireEvent.click(button(layer, 'Send 3 answers'));
  await waitFor(() => {
    expect(button(layer, 'Sending…')).toBeDisabled();
  });
  const rail = within(layer).getByRole('navigation', { name: 'Decisions' });
  for (const entry of within(rail).getAllByRole('button')) {
    expect(entry).toBeDisabled();
  }
  gate.resolve({ results: [recorded('MMR-q1', 'confirmed')], wake: { state: 'sent' } });
  await heading(layer, 'Answers sent');
});

test('Send activated twice before the write resolves writes once', async () => {
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof answerDecisions>>>();
  vi.mocked(answerDecisions).mockReturnValue(gate.promise);
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  await toCheck(layer);
  const send = button(layer, 'Send 3 answers');
  // Both activations land before React re-renders the button disabled.
  act(() => {
    send.click();
    send.click();
  });
  gate.resolve({ results: [recorded('MMR-q1', 'confirmed')], wake: { state: 'sent' } });
  await heading(layer, 'Answers sent');
  expect(answerDecisions).toHaveBeenCalledTimes(1);
});

test('the set is fixed from the fresh read, not a stale cached one', async () => {
  const qc = client();
  qc.setQueryData(['nodes', 'delivery', 'MMR-d3'], page([decision(1)]), {
    updatedAt: Date.now() - 24 * 60 * 60_000,
  });
  const { layer } = await openDelivery('/p/MMR/d3?mode=decisions', qc);
  await heading(layer, 'Question 1?');
  // The fresh read holds three decisions; the stale one held one.
  await waitFor(() => {
    expect(within(layer).getByText('1 of 3')).toBeInTheDocument();
  });
});

test('a restored draft moves to the opened set, so pruning its old set keeps it', async () => {
  writeDraft('MMR-q1', { answer: '', choice: 3, note: 'Moved', set: 'MMR-d9' });
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  expect(
    within(layer).getByRole('textbox', { name: 'Add a note for the agent (optional)' }),
  ).toHaveValue('Moved');
  pruneDrafts('MMR-d9', []);
  expect(readDraft('MMR-q1')).toMatchObject({ note: 'Moved', set: 'MMR-d3' });
});

const DETAIL = 'First line\nSecond line';
const withDetail = () => [
  decision(1, { option_details: [null, DETAIL, null], recommended: 2 }),
  decision(2, { option_details: [null, null], options: ['Yes', 'No'], taken: 2 }),
];

test('an option detail sits under its option, out of the radio name, and described by it', async () => {
  vi.mocked(deliveryPage).mockResolvedValue(page(withDetail()));
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  const remove = within(layer).getByRole('radio', { name: /^Remove/ });
  expect(remove).toHaveAccessibleName('Remove, Agent recommends');
  expect(remove).toHaveAccessibleDescription(DETAIL);
  expect(within(layer).getByRole('radio', { name: /^Keep/ })).not.toHaveAttribute(
    'aria-describedby',
  );
  expect(within(layer).getByRole('radio', { name: 'Something else' })).not.toHaveAttribute(
    'aria-describedby',
  );
  const detail = within(layer).getByText(/First line/);
  expect(detail.className).toContain('whitespace-pre-line');
  expect(detail.textContent).toBe(DETAIL);
});

test('clicking the detail selects its option; the clamp lifts when selected', async () => {
  vi.mocked(deliveryPage).mockResolvedValue(page(withDetail()));
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  const detail = within(layer).getByText(/First line/);
  expect(detail).toHaveClass('line-clamp-2', 'md:line-clamp-3');
  fireEvent.click(detail);
  expect(within(layer).getByRole('radio', { name: /^Remove/ })).toBeChecked();
  expect(detail).not.toHaveClass('line-clamp-2');
  expect(detail).not.toHaveClass('md:line-clamp-3');
});

test('clicking a detail while a Send writes leaves the selection alone', async () => {
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof answerDecisions>>>();
  vi.mocked(answerDecisions).mockReturnValue(gate.promise);
  vi.mocked(deliveryPage).mockResolvedValue(page([withDetail()[0]!]));
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  fireEvent.click(button(layer, 'Confirm and send (MMR-q1)'));
  await waitFor(() => {
    expect(button(layer, 'Sending…')).toBeDisabled();
  });
  fireEvent.click(within(layer).getByText(/First line/));
  expect(within(layer).getByRole('radio', { name: /^Keep/ })).toBeChecked();
  expect(within(layer).getByRole('radio', { name: /^Remove/ })).not.toBeChecked();
  gate.resolve({ results: [recorded('MMR-q1', 'confirmed')], wake: { state: 'sent' } });
  await heading(layer, 'Answers sent');
});

test('details show nowhere but the answers: not the briefing, rail, or check step', async () => {
  vi.mocked(deliveryPage).mockResolvedValue(page(withDetail()));
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  pick(layer, /^Remove/);
  expect(within(layer).getAllByText(/First line/)).toHaveLength(1);
  expect(within(layer).getByRole('navigation', { name: 'Decisions' })).not.toHaveTextContent(
    'First line',
  );
  fireEvent.click(next(layer));
  await heading(layer, 'Question 2?');
  fireEvent.click(next(layer));
  await heading(layer, 'Check your answers');
  expect(layer).not.toHaveTextContent('First line');
});

test('a decision with no details renders no description', async () => {
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  for (const radio of within(layer).getAllByRole('radio')) {
    expect(radio).not.toHaveAttribute('aria-describedby');
  }
});

test('only a decision step carries the meta line: the check step and the done screen have none', async () => {
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  expect(layer).toHaveTextContent('Agent');
  await toCheck(layer);
  expect(layer).not.toHaveTextContent('Before you send');
  fireEvent.click(button(layer, 'Send 3 answers'));
  const done = await heading(layer, 'Answers sent');
  expect(done.previousElementSibling).toBeNull();
  expect(layer).not.toHaveTextContent('Done');
});

test('a chosen Something else reads ink-bright, as every chosen answer does', async () => {
  const { layer } = await openDelivery();
  await heading(layer, 'Question 1?');
  const label = within(layer).getByText('Something else');
  expect(label).toHaveClass('text-ink-dim');
  pick(layer, 'Something else');
  expect(within(layer).getByText('Something else')).toHaveClass('text-ink-bright');
  expect(within(layer).getByText('Something else')).not.toHaveClass('text-ink-dim');
});

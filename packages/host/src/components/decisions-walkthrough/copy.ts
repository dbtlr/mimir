/*
 * The decisions walkthrough's words that follow the operator's selection
 * (ADR 0019, MMR-703 refinement): the reply bar's effect line, the step
 * button's label, and the line under the check step. Pure, so each wording is
 * tested without rendering.
 */

/** What a selection does to its decision: confirm the answer taken, overturn to another option, or to the operator's own words. */
export type Verdict = 'confirm' | 'overturn' | 'custom';

/** Where the step's button leads: the next step, the check step, or straight to the write. */
export type StepTarget = 'continue' | 'review' | 'send';

/** Task ids as a comma list. */
function idList(tasks: readonly string[]): string {
  return tasks.join(', ');
}

/** The reply bar's effect line for the selected answer. */
export function effectLine(verdict: Verdict, tasks: readonly string[]): string {
  const ids = idList(tasks);
  if (verdict === 'confirm') {
    if (tasks.length === 0) {
      return 'Confirming changes nothing.';
    }
    return `Confirming changes nothing. ${ids} ${tasks.length === 1 ? 'stays' : 'stay'} as built.`;
  }
  if (verdict === 'overturn') {
    return tasks.length === 0
      ? 'Overturning records this answer.'
      : `Overturning sends ${ids} back for rework.`;
  }
  return tasks.length === 0
    ? 'Your answer overturns this decision.'
    : `Your answer overturns this decision and sends ${ids} back for rework.`;
}

/** The step button's label: "Confirm and continue", "Send my answer", and the rest. */
export function stepButtonLabel(verdict: Verdict, target: StepTarget): string {
  if (verdict === 'custom') {
    return target === 'send' ? 'Send my answer' : `Use my answer and ${target}`;
  }
  return `${verdict === 'confirm' ? 'Confirm' : 'Overturn'} and ${target}`;
}

/** The check step's effect for one decision. */
export function checkEffect(verdict: Verdict, tasks: readonly string[]): string {
  return verdict === 'confirm' || tasks.length === 0
    ? 'Nothing to redo'
    : `Redoes ${idList(tasks)}`;
}

/** The line under the check step's list: what Send does. `delivery` is null for a project's set. */
export function sendLine(delivery: string | null): string {
  return delivery === null
    ? 'Sending records every answer.'
    : `Sending records every answer and wakes the agent on ${delivery} once if any answer overturns.`;
}

/** "Send 3 answers", "Send 1 answer". */
export function sendLabel(count: number): string {
  return `Send ${String(count)} ${count === 1 ? 'answer' : 'answers'}`;
}

/** "3 decisions", "1 decision". */
export function decisionCount(count: number): string {
  return `${String(count)} ${count === 1 ? 'decision' : 'decisions'}`;
}

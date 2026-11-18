import { z } from 'zod';

/**
 * The decisions walkthrough's unsent answers (ADR 0019, MMR-703 refinement:
 * Drafts). Each decision's selected answer, its own-answer text, and its note
 * are kept in localStorage under the decision's id, per browser, so closing
 * the walkthrough or losing the tab keeps them. A draft never sends by
 * itself: only Send writes. Storage that is missing or refuses a write is
 * ignored, and the walkthrough works without drafts.
 */

const KEY_PREFIX = 'mimir-decision-draft:';

const draftSchema = z.object({
  /** The "Something else" text. */
  answer: z.string(),
  /** The option number selected, or `custom` for "Something else". */
  choice: z.union([z.number().int().positive(), z.literal('custom')]),
  /** The note for the agent. */
  note: z.string(),
  /** The walkthrough's set the draft was written in: a delivery id, or a project key. */
  set: z.string(),
});

export type DecisionDraft = z.infer<typeof draftSchema>;

/** The draft kept for a decision; null when none is kept, or storage is unreadable or corrupt. */
export function readDraft(decision: string): DecisionDraft | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + decision);
    if (raw === null) {
      return null;
    }
    const parsed = draftSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Keep a decision's draft, replacing any earlier one. */
export function writeDraft(decision: string, draft: DecisionDraft): void {
  try {
    localStorage.setItem(KEY_PREFIX + decision, JSON.stringify(draft));
  } catch {
    // private mode / storage disabled: the draft just isn't kept
  }
}

/** Drop a decision's draft, as when its answer is recorded. */
export function removeDraft(decision: string): void {
  try {
    localStorage.removeItem(KEY_PREFIX + decision);
  } catch {
    // storage disabled: nothing was kept
  }
}

/**
 * Drop the drafts written in `set` whose decision is not among `decisions`:
 * a walkthrough opening removes the drafts of decisions that left its set.
 * Drafts written in other sets stay.
 */
export function pruneDrafts(set: string, decisions: readonly string[]): void {
  const keep = new Set(decisions);
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === null || !key.startsWith(KEY_PREFIX)) {
        continue;
      }
      const decision = key.slice(KEY_PREFIX.length);
      if (!keep.has(decision) && readDraft(decision)?.set === set) {
        stale.push(key);
      }
    }
    for (const key of stale) {
      localStorage.removeItem(key);
    }
  } catch {
    // storage disabled: nothing was kept
  }
}

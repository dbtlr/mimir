/*
 * Whether this browser has answered Home's one-time notifications card
 * (ADR 0045, MMR-734). Kept in localStorage, per browser: Turn on and Not now
 * each retire the card for good. Storage that cannot be read counts as
 * unanswered, so the card still shows; a write that fails leaves it to show
 * again on the next load.
 */

const STORAGE_KEY = 'mimir.push.suggestionAnswered';

/** Whether this browser has answered the card. */
export function suggestionAnswered(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/** Retire the card in this browser. */
export function answerSuggestion(): void {
  try {
    localStorage.setItem(STORAGE_KEY, new Date().toISOString());
  } catch {
    // Storage is full or blocked: the card may show again, which is the safe miss.
  }
}

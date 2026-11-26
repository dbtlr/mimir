import { Quiet } from '../../src/components/patterns/feed/quiet';
import { ActionButton } from '../../src/components/ui/action-button';

/**
 * Body copy and a label side by side, for the line-height checks
 * (e2e/type-rhythm.test.ts): a bare `text-body` paragraph, a quiet state, and
 * the default ActionButton, whose label is not prose (DESIGN.md, Type).
 */
export function TypeRhythmPage() {
  return (
    <main className="p-4">
      <p data-probe="body" className="max-w-prose text-body text-ink">
        A paragraph of body copy that runs long enough to wrap onto a second line at a phone width,
        so its line box shows.
      </p>
      <Quiet>Nothing needs you.</Quiet>
      <ActionButton>Resolve</ActionButton>
    </main>
  );
}

// Shared test seam module, not a test body.
// oxlint-disable vitest/require-hook
import { nodeWork, projectWork, review } from '../api/fns/views';
import type { ReviewReport, WorkReport } from '../api/view-queries';
import { engineReview, engineWork } from './views-fixtures';

/*
 * The composite pages' server functions served from a small world. A test file
 * that renders the shell or a page reading them mocks the module first —
 * `vi.mock('../api/fns/views')` at the top of the file — and then calls
 * `serveViews`, which answers each function from the world it is given. A case
 * that needs one answer of its own overrides that function after, with
 * `vi.mocked(fn).mockResolvedValueOnce(...)`, and asserts the call by function:
 * `expect(projectWork).toHaveBeenCalledWith({ data: {...} })`. See setup.ts.
 */

export type ViewsWorld = {
  /** What the review function answers. */
  review: ReviewReport;
  /** Project work reports by project key; a key without one answers an empty page. */
  projects: Record<string, WorkReport>;
  /** Container work reports by node id; an id without one answers an empty page. */
  nodes: Record<string, WorkReport>;
};

/** Answer the views' server functions from `world`; the returned state is live. */
export function serveViews(world: Partial<ViewsWorld> = {}): ViewsWorld {
  const state: ViewsWorld = { nodes: {}, projects: {}, review: engineReview(), ...world };
  vi.mocked(review).mockImplementation(async () => state.review);
  vi.mocked(projectWork).mockImplementation(
    async ({ data }) =>
      state.projects[data.project] ??
      engineWork({ scope: { id: data.project, kind: 'project', title: data.project } }),
  );
  vi.mocked(nodeWork).mockImplementation(
    async ({ data }) =>
      state.nodes[data.id] ??
      engineWork({ scope: { id: data.id, kind: 'initiative', title: data.id } }),
  );
  return state;
}

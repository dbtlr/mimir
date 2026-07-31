/** The mutation surface — high-level verbs, each a single transaction (ADR 0003). */
export { archiveProject, releasedByArchive, unarchiveProject } from './archive';
export { assertProjectActive } from './common';
export {
  abandonTask,
  completeTask,
  reopenTask,
  returnTask,
  startTask,
  submitTask,
} from './lifecycle';
export { blockTask, parkTask, unblockTask, unparkTask } from './hold';
// The resume-handle machinery (MMR-320) is internal to the mutation verbs — only
// its patch type crosses the boundary (`createNode`'s input, the op registry's
// `run`). Keeping the functions off the index keeps the mutation surface exactly
// the verbs (the CAS-guard coverage test in `store-norn/writer.test.ts`).
export type { HandleFields } from './handles';
export { depend, undepend } from './dependency';
export { moveNode } from './structure';
export {
  type ArtifactUpdateFields,
  type AttachArtifactInput,
  type AttachLinkHints,
  type AttachTargets,
  type NarrowUpdateKind,
  type UpdateFieldKey,
  type UpdateFields,
  type UpdateProjectFields,
  annotate,
  attachArtifact,
  inapplicableUpdateFields,
  reorder,
  resolveAttachTargets,
  updateArtifact,
  updateNode,
  updateProject,
} from './data';
export { type EntityRef, tagEntities, untagEntities } from './tags';

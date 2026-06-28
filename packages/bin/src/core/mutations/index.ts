/** The mutation surface — high-level verbs, each a single transaction (ADR 0003). */
export {
  abandonTask,
  completeTask,
  reopenTask,
  returnTask,
  startTask,
  submitTask,
} from './lifecycle';
export { blockTask, parkTask, unblockTask, unparkTask } from './hold';
export { depend, undepend } from './dependency';
export { moveNode } from './structure';
export {
  type ArtifactUpdateFields,
  type AttachArtifactInput,
  type UpdateFields,
  type UpdateProjectFields,
  annotate,
  attachArtifact,
  reorder,
  updateArtifact,
  updateNode,
  updateProject,
} from './data';
export { type EntityRef, tagEntities, untagEntities } from './tags';

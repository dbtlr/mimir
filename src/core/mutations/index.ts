/** The mutation surface — high-level verbs, each a single transaction (ADR 0003). */
export { abandonTask, completeTask, startTask } from "./lifecycle";
export { blockTask, parkTask, unblockTask, unparkTask } from "./hold";
export { depend, undepend } from "./dependency";
export { moveNode } from "./structure";
export {
  type AttachArtifactInput,
  type UpdateFields,
  annotate,
  attachArtifact,
  reorder,
  updateNode,
} from "./data";
export { type EntityRef, tagEntities, untagEntities } from "./tags";

/**
 * Shared DTOs, enums, Engine schemas, and domain error identity (ADR 0034).
 * No core, store, or transport imports: this is the bottom of the type stack.
 */
export * from './enums';
export * from './dto';
export * from './fields';
export * from './ops';
export * from './query';
export * from './seed-lane';
export type * from './wire';
export * from './engine';
export * from './errors';
export * from './health';
export * from './version';

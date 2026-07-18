/**
 * The contract layer — pure DTO + enum types shared by the transports and the
 * UI package (ADR 0010). No runtime logic, no imports from `db`/`core`/
 * transports: it is the bottom of the type stack.
 */
export * from './enums';
export * from './dto';
export * from './fields';
export * from './query';
export type * from './wire';

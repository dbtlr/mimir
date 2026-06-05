/**
 * The contract layer — pure DTO + enum types shared by the transports and
 * (eventually) the extracted UI package (ADR 0010). No runtime, no imports
 * from `db`/`core`/transports: it is the bottom of the type stack.
 *
 * Phase 1 seeds the enum leaf (`./enums`). Phase 2 adds the Task DTO and the
 * output-format shapes from the output-contract reference.
 */
export * from "./enums";

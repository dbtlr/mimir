/**
 * The contract layer — pure DTO + enum types shared by the transports and
 * (eventually) the extracted UI package (ADR 0010). No runtime, no imports
 * from `db`/`core`/transports: it is the bottom of the type stack.
 *
 * Phase 2 fills this with the Task DTO, the closed State-word vocabulary
 * (ADR 0008), and the output-format shapes from the output-contract reference.
 */
export {};

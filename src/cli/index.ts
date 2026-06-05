/**
 * The CLI transport — renders the core's intent layer for a human at a
 * terminal (count-led output, isatty format defaults, the table/records/ids/
 * json/jsonl formats). Imports `core` + `contract` only.
 */
export { runCli } from "./run";
export type { Io } from "./render";

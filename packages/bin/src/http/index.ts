/**
 * The HTTP transport — the resource envelope (ADR 0012): conventional REST
 * over the core for the operator-console UI (`mimir serve`). Imports `core` +
 * `contract` only.
 */
export { type ServeOptions, createServer } from "./server";

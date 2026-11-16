// Fills web-stream globals the vmThreads jsdom context leaves out, not a test body.
// It must run as its own setup file before setup.ts: setup.ts loads
// @tanstack/react-start, whose RPC frame decoder builds a
// ByteLengthQueuingStrategy when the module loads.
//
// Setup runs in Node, which owns these classes, and every export is copied, so
// the module is read whole.
// oxlint-disable-next-line import/no-namespace, import/no-nodejs-modules
import * as streamWeb from 'node:stream/web';

for (const [name, value] of Object.entries(streamWeb)) {
  if (!(name in globalThis)) {
    Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
  }
}

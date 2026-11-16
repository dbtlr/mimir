// Fills the web-stream globals a vmThreads jsdom context leaves out.
//
// It is the first setup file, so it runs before any module imports
// @tanstack/react-start, whose RPC frame decoder builds a
// ByteLengthQueuingStrategy when the module loads. setup.ts mocks that package,
// and the mock's factory loads the real one.
//
// Setup runs in Node, which owns these classes, and every missing export is
// copied, so the module is read whole.
// oxlint-disable-next-line import/no-namespace, import/no-nodejs-modules
import * as streamWeb from 'node:stream/web';

for (const [name, value] of Object.entries(streamWeb)) {
  if (!(name in globalThis)) {
    Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
  }
}

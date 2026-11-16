// Fills the web-stream globals a vmThreads jsdom context leaves out.
//
// The globals must exist before a test file imports @tanstack/react-start,
// whose RPC frame decoder builds a ByteLengthQueuingStrategy when the module
// loads (setup.ts's mock of that package loads the real one). Every setup file
// runs before a test file's imports, so the position in setupFiles does not
// matter; it is listed first by convention.
//
// Only the browser's own stream globals are copied, and only when missing:
// node:stream/web also exports names a browser lacks (ReadableStreamTee, a
// default export). The classes are Node's, so every file in a worker shares
// them; a test that patches one restores it.
// oxlint-disable-next-line import/no-nodejs-modules -- setup runs in Node, which owns these classes
import {
  ByteLengthQueuingStrategy,
  CompressionStream,
  CountQueuingStrategy,
  DecompressionStream,
  ReadableByteStreamController,
  ReadableStream,
  ReadableStreamBYOBReader,
  ReadableStreamBYOBRequest,
  ReadableStreamDefaultController,
  ReadableStreamDefaultReader,
  TextDecoderStream,
  TextEncoderStream,
  TransformStream,
  TransformStreamDefaultController,
  WritableStream,
  WritableStreamDefaultController,
  WritableStreamDefaultWriter,
} from 'node:stream/web';

const BROWSER_STREAM_GLOBALS = {
  ByteLengthQueuingStrategy,
  CompressionStream,
  CountQueuingStrategy,
  DecompressionStream,
  ReadableByteStreamController,
  ReadableStream,
  ReadableStreamBYOBReader,
  ReadableStreamBYOBRequest,
  ReadableStreamDefaultController,
  ReadableStreamDefaultReader,
  TextDecoderStream,
  TextEncoderStream,
  TransformStream,
  TransformStreamDefaultController,
  WritableStream,
  WritableStreamDefaultController,
  WritableStreamDefaultWriter,
};

for (const [name, value] of Object.entries(BROWSER_STREAM_GLOBALS)) {
  if (!(name in globalThis)) {
    Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
  }
}

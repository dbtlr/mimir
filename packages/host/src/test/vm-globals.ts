// Fills the web-stream globals a vmThreads jsdom context leaves out.
//
// It is the first setup file, so it runs before any module imports
// @tanstack/react-start, whose RPC frame decoder builds a
// ByteLengthQueuingStrategy when the module loads. setup.ts mocks that package,
// and the mock's factory loads the real one.
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

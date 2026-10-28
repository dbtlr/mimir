/**
 * The Application module Loom's toolchain reads: `loom init` takes the
 * Application's `postInstall` declaration from it to render `install.sh`, and
 * `loom build` carries it beside the entry. The source refuses every ask, so
 * importing the module touches no store, and the entry (`main.ts`) is what
 * runs the real one.
 */
import { createApp } from './app';

export const application = createApp({
  git: {
    originUrl: () => Promise.resolve(undefined),
    readConfig: () => Promise.resolve(undefined),
    writeConfig: () => Promise.resolve(false),
  },
  store: () => Promise.reject(new Error('The toolchain Application opens no store.')),
});

/// <reference types="vite/client" />
// Ambient module augmentation — these must stay `interface` to merge with vite's.
// oxlint-disable typescript/consistent-type-definitions

/** Typed env — `VITE_API_BASE` is the dev-loop API origin (see api/client.ts). */
interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

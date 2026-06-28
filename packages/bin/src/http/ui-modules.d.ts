/**
 * Ambient modules for the generated asset manifest's Bun file-type imports
 * (`import x from "../../../ui/dist/..." with { type: "file" }`): each import
 * resolves to a path string `Bun.file` can open — embedded in the binary
 * after `bun build --compile`, on disk otherwise.
 */
declare module '*.html' {
  const path: string;
  export default path;
}
declare module '*.js' {
  const path: string;
  export default path;
}
declare module '*.css' {
  const path: string;
  export default path;
}
declare module '*.svg' {
  const path: string;
  export default path;
}
declare module '*.webmanifest' {
  const path: string;
  export default path;
}
declare module '*.woff2' {
  const path: string;
  export default path;
}
declare module '*.png' {
  const path: string;
  export default path;
}
declare module '*.ico' {
  const path: string;
  export default path;
}
declare module '*.txt' {
  const path: string;
  export default path;
}

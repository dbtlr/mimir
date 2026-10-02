/** Markdown imported `with { type: "text" }` — Bun inlines it as a string. */
declare module '*.md' {
  const text: string;
  export default text;
}

/** YAML imported `with { type: "text" }` — the skill's Codex metadata, inlined verbatim. */
declare module '*.yaml' {
  const text: string;
  export default text;
}

/** Markdown imported `with { type: "text" }` — Bun inlines it as a string. */
declare module "*.md" {
  const text: string;
  export default text;
}

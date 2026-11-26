/** `text` with its first letter in capitals: "needs answers" reads "Needs answers". */
export function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

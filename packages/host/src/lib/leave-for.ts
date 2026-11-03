/** Send the browser to another site, such as T3's connect screen. Tests mock this module. */
export function leaveFor(url: string): void {
  globalThis.location.assign(url);
}

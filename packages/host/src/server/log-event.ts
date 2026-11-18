/**
 * Log one named host event as a JSON line: `event`, its fields, and `time`
 * (an ISO instant from `clock`). The one form the host's named events share.
 */
export function logEvent(
  sink: { clock: () => number; log: (line: string) => void },
  event: string,
  fields: Record<string, number | string> = {},
): void {
  sink.log(JSON.stringify({ event, ...fields, time: new Date(sink.clock()).toISOString() }));
}

/**
 * The service lifecycle event log (MMR-47): one JSONL record per service
 * verb / self-update, discoverable by `service status`. A plain file, never
 * the SQLite store — ops state is consumer state (ADR 0002). Load-bearing
 * assumption: the file is append-only with no rotation — event rate is
 * human-frequency (verbs + self-updates), so the whole-file read stays cheap.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type ServiceEventName =
  | 'install'
  | 'start'
  | 'stop'
  | 'restart'
  | 'uninstall'
  | 'self-update';

export interface ServiceEvent {
  at: string;
  event: ServiceEventName;
  source: 'cli' | 'self-update';
  version: string;
  ok: boolean;
  detail?: string;
}

export const LOG_DIR = join(homedir(), 'Library', 'Logs', 'mimir');
export const EVENTS_FILE = join(LOG_DIR, 'service-events.jsonl');
export const SERVE_LOG_FILE = join(LOG_DIR, 'serve.log');

export function appendEvent(file: string, event: Omit<ServiceEvent, 'at'>): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

/** The last `n` events, oldest-first; corrupt lines are skipped, not fatal. */
export function recentEvents(file: string, n: number): ServiceEvent[] {
  if (n <= 0) return [];
  if (!existsSync(file)) return [];
  const events: ServiceEvent[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line) as ServiceEvent);
    } catch {
      // a torn or hand-mangled line must not take status down
    }
  }
  return events.slice(-n);
}

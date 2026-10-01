/**
 * The supervisor seam (MMR-47, MMR-54): `service` verbs speak this interface.
 * launchd (macOS) and systemd user units (Linux) implement it; each instance is
 * bound to one unit name, which the per-installation naming in ./units derives.
 */
import { MimirError } from '../core';
import type { ExecResult } from '../exec';

export type ServiceInfo = {
  loaded: boolean;
  running: boolean;
  pid?: number;
};

export type Supervisor = {
  install: (serviceFile: string) => Promise<void>;
  uninstall: () => Promise<void>;
  start: (serviceFile: string) => Promise<void>;
  stop: () => Promise<void>;
  restart: () => Promise<void>;
  info: () => Promise<ServiceInfo>;
};

/** The `validation` error a nonzero supervisor-tool exit raises, shared so the
 *  message and category cannot drift between backends. */
export function supervisorError(
  tool: string,
  verb: string,
  failure: string,
  result: ExecResult,
): MimirError {
  return new MimirError(
    'validation',
    `${tool} ${verb} failed (${String(result.code)}): ${failure}`,
    result.stderr.trim() === '' ? undefined : result.stderr.trim(),
  );
}

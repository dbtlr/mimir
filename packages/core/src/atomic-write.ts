import { randomBytes } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Write `text` to `file` atomically: a private temporary file beside the
 * target, synced, then renamed over it. A reader sees the old file or the new
 * one, never a partial write, and the new file has exactly `mode` whatever the
 * umask. The directory is synced after the rename so the new entry survives a
 * crash. The directory must exist.
 */
export function writeFileAtomic(file: string, text: string, mode: number): void {
  const temporary = join(
    dirname(file),
    `.${basename(file)}.${String(process.pid)}.${randomBytes(6).toString('hex')}`,
  );
  // `wx` refuses an existing path, a planted symlink included.
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    try {
      fchmodSync(descriptor, mode);
      writeFileSync(descriptor, text);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  syncDirectory(dirname(file));
}

/** Best effort: a platform that cannot fsync a directory keeps the completed write. */
function syncDirectory(directory: string): void {
  let descriptor: number;
  try {
    descriptor = openSync(directory, 'r');
  } catch {
    return;
  }
  try {
    fsyncSync(descriptor);
  } catch {
    // The rename has landed; only its durability across a crash is unconfirmed.
  } finally {
    closeSync(descriptor);
  }
}

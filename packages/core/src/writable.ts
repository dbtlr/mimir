import { accessSync, constants, existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { invariant } from './errors';

/** The nearest directory at or above `path` that exists. */
function nearestExisting(path: string): string {
  let at = path;
  while (!existsSync(at)) {
    const parent = dirname(at);
    if (parent === at) {
      return at;
    }
    at = parent;
  }
  return at;
}

function refuseUnwritable(path: string): never {
  throw invariant(
    `${path} is not writable by this user`,
    `make it writable (chmod u+w ${path}), then run the command again`,
  );
}

function requireWritable(path: string): void {
  try {
    accessSync(path, constants.W_OK);
  } catch {
    refuseUnwritable(path);
  }
}

/**
 * Refuse, before a long step starts, a file this user could not write: the
 * file itself when it exists, and the directory the write lands in (the
 * nearest existing ancestor when the directory is yet to be created), since
 * files here are replaced atomically beside their target.
 */
export function assertWritable(file: string): void {
  if (existsSync(file)) {
    requireWritable(file);
  }
  requireWritable(nearestExisting(dirname(file)));
}

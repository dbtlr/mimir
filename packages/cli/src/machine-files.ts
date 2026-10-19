/**
 * The filesystem edge of `store export` and `store import`: the Machine port
 * reads and writes transfer documents through these, so a command never
 * touches a file itself.
 */
import { existsSync, statSync, writeFileSync } from 'node:fs';

import type { DocumentRead, DocumentWrite } from './machine';

/** The `code` of a Node filesystem error, or undefined for anything else. */
function errnoCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code: unknown = error.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/** The text of the document at `file`, or the reason it cannot be read. */
export async function readDocumentFile(file: string): Promise<DocumentRead> {
  if (!existsSync(file)) {
    return { kind: 'refused', reason: 'missing' };
  }
  // A directory passes the existence check and then fails as a raw runtime
  // error on the read, which names neither the verb nor the reason.
  if (statSync(file).isDirectory()) {
    return { kind: 'refused', reason: 'not-a-file' };
  }
  return { kind: 'text', text: await Bun.file(file).text() };
}

/**
 * Write `text` to a new file. The create is exclusive (`wx`), so a file that
 * appears between a caller's check and this write is refused, never overwritten.
 */
export function writeDocumentFile(file: string, text: string): DocumentWrite {
  try {
    writeFileSync(file, text, { flag: 'wx' });
  } catch (error) {
    if (errnoCode(error) === 'EEXIST') {
      return 'exists';
    }
    throw error;
  }
  return 'written';
}

/** Whether a file or directory already stands at `file`. */
export const documentExists = (file: string): boolean => existsSync(file);

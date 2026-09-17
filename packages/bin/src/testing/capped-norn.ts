import { invariant } from '../core/errors';
import { NornClient } from '../core/store-norn/client';
import type { NornDocument, NornFindArgs } from '../core/store-norn/client';
import { collapse } from '../core/store-norn/decode';

/** Model the response cap at the external client seam, including section content
 * that Norn returns even when the caller only wants section failures. */
export class CappedNornClient extends NornClient {
  readonly rejected: string[] = [];
  readonly finds: NornFindArgs[] = [];
  readonly reads: string[][] = [];

  readonly documents: NornDocument[];
  readonly cap: number;

  constructor(documents: NornDocument[], cap: number) {
    super({ vaultPath: '/test/vault' });
    this.documents = documents;
    this.cap = cap;
  }

  private response<T>(operation: string, value: T): Promise<T> {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > this.cap) {
      this.rejected.push(operation);
      return Promise.reject(invariant(`norn ${operation}: MCP error -32000: Connection closed`));
    }
    return Promise.resolve(value);
  }

  override find(args: NornFindArgs): Promise<NornDocument[]> {
    this.finds.push(args);
    const docs = this.documents.filter((doc) => {
      const fm = doc.frontmatter;
      return (
        (args.in ?? []).every((entry) => {
          const [field = '', values = ''] = entry.split(':');
          return values.split(',').includes(String(fm?.[field]));
        }) &&
        (args.eq ?? []).every((entry) => {
          const [field = '', value = ''] = entry.split(':');
          return (collapse(fm?.[field]) ?? fm?.[field]) === value;
        })
      );
    });
    return this.response(
      'find',
      docs.map((doc) => this.project(doc, args.col ?? ['.frontmatter'])),
    );
  }

  private project(doc: NornDocument, columns: string[]): NornDocument {
    const result: NornDocument = { path: doc.path };
    for (const column of columns) {
      const field = column.replace(/^\./, '');
      if (field in doc) {
        result[field] = doc[field];
      }
    }
    return result;
  }

  override get(targets: string[], col = '.frontmatter'): Promise<unknown[]> {
    this.reads.push(targets);
    return this.response(
      'get',
      this.documents
        .filter((doc) => targets.includes(doc.path))
        .map((doc) => this.project(doc, col.split(','))),
    );
  }

  override async sectionFailures(targets: string[], sections: string[]): Promise<string[]> {
    const docs = this.documents.filter((doc) => targets.includes(doc.path));
    await this.response(
      'sections',
      docs.map((doc) => ({ path: doc.path, sections: { [sections[0] ?? '']: doc.body } })),
    );
    return docs
      .filter((doc) => !String(doc.body).includes(`## ${sections[0]}\n`))
      .map((doc) => doc.path);
  }

  override validate(): Promise<unknown> {
    return Promise.resolve({ findings: [] });
  }
}

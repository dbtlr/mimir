/**
 * The retired contract of the old MCP server (ADR 0037): every tool it
 * registered and each tool's input schema as `tools/list` advertised it, frozen
 * from that server before it was retired. It records
 * what an agent could call, not what the Loom server does today; the capability
 * map (`mcp-capabilities.ts`) is diffed against it so a tool or an input that
 * changed cannot go unrecorded. Generated once and never edited by hand: it
 * changes only if the contract itself is amended. Test-only data.
 */

/** One input of a retired tool: its JSON Schema, of which only `type` is compared. */
export type RetiredInput = { type?: string } & Readonly<Record<string, unknown>>;

/** A retired tool's inputs by name, and which of them were required. */
export type RetiredToolSchema = {
  readonly properties: Readonly<Record<string, RetiredInput>>;
  readonly required: readonly string[];
};

export const RETIRED_MCP_TOOLS: Readonly<Record<string, RetiredToolSchema>> = {
  abandon: {
    properties: {
      id: {
        type: 'string',
      },
      reason: {
        type: 'string',
      },
    },
    required: ['id'],
  },
  annotate: {
    properties: {
      content: {
        type: 'string',
      },
      id: {
        type: 'string',
      },
    },
    required: ['content', 'id'],
  },
  archive: {
    properties: {
      key: {
        type: 'string',
      },
      reason: {
        type: 'string',
      },
    },
    required: ['key'],
  },
  artifacts: {
    properties: {
      after: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      atOrAfter: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      atOrBefore: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      before: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      limit: {
        exclusiveMinimum: 0,
        maximum: 9007199254740991,
        type: 'integer',
      },
      offset: {
        maximum: 9007199254740991,
        minimum: 0,
        type: 'integer',
      },
      on: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      q: {
        type: 'string',
      },
      scope: {
        type: 'string',
      },
      tag: {
        type: 'string',
      },
      tz: {
        type: 'string',
      },
    },
    required: [],
  },
  attach: {
    properties: {
      content: {
        type: 'string',
      },
      links: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      node: {
        type: 'string',
      },
      project: {
        type: 'string',
      },
      summary: {
        type: 'string',
      },
      tags: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      title: {
        type: 'string',
      },
    },
    required: ['content', 'title'],
  },
  block: {
    properties: {
      id: {
        type: 'string',
      },
      on: {
        enum: ['you', 'others'],
        type: 'string',
      },
      reason: {
        type: 'string',
      },
    },
    required: ['id'],
  },
  create: {
    properties: {
      branch: {
        type: 'string',
      },
      description: {
        type: 'string',
      },
      externalRef: {
        type: 'string',
      },
      groomed: {
        type: 'boolean',
      },
      harness: {
        type: 'string',
      },
      host: {
        type: 'string',
      },
      key: {
        type: 'string',
      },
      name: {
        type: 'string',
      },
      openEnded: {
        type: 'boolean',
      },
      parent: {
        type: 'string',
      },
      priority: {
        enum: ['p0', 'p1', 'p2', 'p3'],
        type: 'string',
      },
      remote: {
        type: 'string',
      },
      session: {
        type: 'string',
      },
      size: {
        enum: ['small', 'medium', 'large'],
        type: 'string',
      },
      summary: {
        type: 'string',
      },
      tags: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      target: {
        type: 'string',
      },
      title: {
        type: 'string',
      },
      type: {
        enum: ['project', 'initiative', 'phase', 'task'],
        type: 'string',
      },
      upstream: {
        type: 'string',
      },
    },
    required: ['type'],
  },
  depend: {
    properties: {
      id: {
        type: 'string',
      },
      on: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
    },
    required: ['id', 'on'],
  },
  done: {
    properties: {
      id: {
        type: 'string',
      },
    },
    required: ['id'],
  },
  get: {
    properties: {
      facets: {
        items: {
          enum: [
            'deps',
            'annotations',
            'artifacts',
            'history',
            'tags',
            'children',
            'distribution',
            'content',
          ],
          type: 'string',
        },
        type: 'array',
      },
      id: {
        type: 'string',
      },
    },
    required: ['id'],
  },
  get_seed: {
    properties: {
      content: {
        type: 'boolean',
      },
      id: {
        type: 'string',
      },
    },
    required: ['id'],
  },
  groom: {
    properties: {
      ids: {
        items: {
          type: 'string',
        },
        minItems: 1,
        type: 'array',
      },
      note: {
        type: 'string',
      },
      state: {
        enum: ['not_groomed', 'needs_answers', 'groomed'],
        type: 'string',
      },
    },
    required: ['ids', 'state'],
  },
  list: {
    properties: {
      after: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      atOrAfter: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      atOrBefore: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      before: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      eq: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      has: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      in: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      is: {
        items: {
          enum: ['stale', 'blocking', 'orphaned'],
          type: 'string',
        },
        type: 'array',
      },
      limit: {
        exclusiveMinimum: 0,
        maximum: 9007199254740991,
        type: 'integer',
      },
      missing: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      notEq: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      notIn: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      notIs: {
        items: {
          enum: ['stale', 'blocking', 'orphaned'],
          type: 'string',
        },
        type: 'array',
      },
      on: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      priority: {
        enum: ['p0', 'p1', 'p2', 'p3'],
        type: 'string',
      },
      q: {
        type: 'string',
      },
      scope: {
        type: 'string',
      },
      size: {
        enum: ['small', 'medium', 'large'],
        type: 'string',
      },
      status: {
        enum: [
          'ready',
          'awaiting',
          'blocked',
          'parked',
          'queued',
          'in_progress',
          'under_review',
          'done',
          'abandoned',
          'live',
          'terminal',
          'all',
        ],
        type: 'string',
      },
      tag: {
        type: 'string',
      },
      tz: {
        type: 'string',
      },
    },
    required: [],
  },
  move: {
    properties: {
      id: {
        type: 'string',
      },
      to: {
        type: 'string',
      },
    },
    required: ['id', 'to'],
  },
  next: {
    properties: {
      after: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      atOrAfter: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      atOrBefore: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      before: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      eq: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      has: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      in: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      is: {
        items: {
          enum: ['stale', 'blocking', 'orphaned'],
          type: 'string',
        },
        type: 'array',
      },
      limit: {
        exclusiveMinimum: 0,
        maximum: 9007199254740991,
        type: 'integer',
      },
      missing: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      notEq: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      notIn: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      notIs: {
        items: {
          enum: ['stale', 'blocking', 'orphaned'],
          type: 'string',
        },
        type: 'array',
      },
      on: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      priority: {
        enum: ['p0', 'p1', 'p2', 'p3'],
        type: 'string',
      },
      q: {
        type: 'string',
      },
      scope: {
        type: 'string',
      },
      size: {
        enum: ['small', 'medium', 'large'],
        type: 'string',
      },
      tz: {
        type: 'string',
      },
    },
    required: [],
  },
  overview: {
    properties: {
      scope: {
        type: 'string',
      },
    },
    required: [],
  },
  park: {
    properties: {
      id: {
        type: 'string',
      },
      reason: {
        type: 'string',
      },
    },
    required: ['id'],
  },
  projects: {
    properties: {
      status: {
        enum: ['active', 'archived', 'all'],
        type: 'string',
      },
    },
    required: [],
  },
  promote: {
    properties: {
      description: {
        type: 'string',
      },
      id: {
        type: 'string',
      },
      link: {
        type: 'string',
      },
      parent: {
        type: 'string',
      },
      priority: {
        enum: ['p0', 'p1', 'p2', 'p3'],
        type: 'string',
      },
      size: {
        enum: ['small', 'medium', 'large'],
        type: 'string',
      },
      tags: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      title: {
        type: 'string',
      },
    },
    required: ['id'],
  },
  queue: {
    properties: {
      branch: {
        type: 'string',
      },
      harness: {
        type: 'string',
      },
      host: {
        type: 'string',
      },
      id: {
        type: 'string',
      },
      session: {
        minLength: 1,
        type: 'string',
      },
    },
    required: ['id', 'session'],
  },
  reject: {
    properties: {
      id: {
        type: 'string',
      },
      reason: {
        type: 'string',
      },
    },
    required: ['id', 'reason'],
  },
  reopen: {
    properties: {
      id: {
        type: 'string',
      },
      reason: {
        type: 'string',
      },
    },
    required: ['id'],
  },
  reorder: {
    properties: {
      id: {
        type: 'string',
      },
      position: {
        enum: ['top', 'bottom', 'before', 'after'],
        type: 'string',
      },
      ref: {
        type: 'string',
      },
    },
    required: ['id', 'position'],
  },
  resolve: {
    properties: {
      id: {
        type: 'string',
      },
      reason: {
        type: 'string',
      },
    },
    required: ['id', 'reason'],
  },
  return: {
    properties: {
      id: {
        type: 'string',
      },
      reason: {
        type: 'string',
      },
    },
    required: ['id'],
  },
  scratch_agenda_add: {
    properties: {
      content: {
        type: 'string',
      },
      expected_updated_at: {
        type: 'string',
      },
      id: {
        type: 'string',
      },
    },
    required: ['expected_updated_at', 'id', 'content'],
  },
  scratch_agenda_complete: {
    properties: {
      expected_updated_at: {
        type: 'string',
      },
      id: {
        type: 'string',
      },
      number: {
        exclusiveMinimum: 0,
        maximum: 9007199254740991,
        type: 'integer',
      },
    },
    required: ['expected_updated_at', 'id', 'number'],
  },
  scratch_agenda_supersede: {
    properties: {
      expected_updated_at: {
        type: 'string',
      },
      id: {
        type: 'string',
      },
      number: {
        exclusiveMinimum: 0,
        maximum: 9007199254740991,
        type: 'integer',
      },
      reason: {
        type: 'string',
      },
    },
    required: ['expected_updated_at', 'id', 'number', 'reason'],
  },
  scratch_checkpoint: {
    properties: {
      content: {
        type: 'string',
      },
      expected_updated_at: {
        type: 'string',
      },
      id: {
        type: 'string',
      },
    },
    required: ['expected_updated_at', 'id', 'content'],
  },
  scratch_create: {
    properties: {
      linked_work: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      scope: {
        type: 'string',
      },
      title: {
        type: 'string',
      },
    },
    required: ['title'],
  },
  scratch_discard: {
    properties: {
      expected_updated_at: {
        type: 'string',
      },
      force: {
        type: 'boolean',
      },
      id: {
        type: 'string',
      },
      reason: {
        type: 'string',
      },
    },
    required: ['expected_updated_at', 'id'],
  },
  scratch_freeze: {
    properties: {
      expected_updated_at: {
        type: 'string',
      },
      id: {
        type: 'string',
      },
      summary: {
        type: 'string',
      },
      tags: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
    },
    required: ['expected_updated_at', 'id', 'summary'],
  },
  scratch_get: {
    properties: {
      id: {
        type: 'string',
      },
    },
    required: ['id'],
  },
  scratch_list: {
    properties: {
      scope: {
        type: 'string',
      },
    },
    required: [],
  },
  scratch_update: {
    properties: {
      expected_updated_at: {
        type: 'string',
      },
      id: {
        type: 'string',
      },
      linked_work: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      title: {
        type: 'string',
      },
    },
    required: ['expected_updated_at', 'id'],
  },
  search: {
    properties: {
      limit: {
        exclusiveMinimum: 0,
        maximum: 9007199254740991,
        type: 'integer',
      },
      query: {
        type: 'string',
      },
      scope: {
        type: 'string',
      },
    },
    required: ['query'],
  },
  seed: {
    properties: {
      description: {
        type: 'string',
      },
      kind: {
        enum: ['idea', 'bug', 'feature'],
        type: 'string',
      },
      project: {
        type: 'string',
      },
      title: {
        type: 'string',
      },
    },
    required: ['kind', 'title'],
  },
  seeds: {
    properties: {
      after: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      atOrAfter: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      atOrBefore: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      before: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      on: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
      project: {
        type: 'string',
      },
      requester: {
        type: 'string',
      },
      sort: {
        enum: ['asc', 'desc'],
        type: 'string',
      },
      status: {
        enum: ['new', 'parked', 'promoted', 'resolved', 'rejected', 'live', 'all'],
        type: 'string',
      },
      tz: {
        type: 'string',
      },
    },
    required: [],
  },
  start: {
    properties: {
      branch: {
        type: 'string',
      },
      harness: {
        type: 'string',
      },
      host: {
        type: 'string',
      },
      id: {
        type: 'string',
      },
      session: {
        type: 'string',
      },
      workerHarness: {
        type: 'string',
      },
      workerSession: {
        type: 'string',
      },
    },
    required: ['id'],
  },
  status: {
    properties: {
      id: {
        type: 'string',
      },
    },
    required: ['id'],
  },
  submit: {
    properties: {
      id: {
        type: 'string',
      },
    },
    required: ['id'],
  },
  tag: {
    properties: {
      ids: {
        items: {
          type: 'string',
        },
        minItems: 1,
        type: 'array',
      },
      tags: {
        items: {
          type: 'string',
        },
        minItems: 1,
        type: 'array',
      },
    },
    required: ['ids', 'tags'],
  },
  triage: {
    properties: {
      board: {
        type: 'string',
      },
      dryRun: {
        type: 'boolean',
      },
    },
    required: [],
  },
  unarchive: {
    properties: {
      key: {
        type: 'string',
      },
    },
    required: ['key'],
  },
  unblock: {
    properties: {
      id: {
        type: 'string',
      },
    },
    required: ['id'],
  },
  undepend: {
    properties: {
      id: {
        type: 'string',
      },
      on: {
        items: {
          type: 'string',
        },
        type: 'array',
      },
    },
    required: ['id', 'on'],
  },
  unpark: {
    properties: {
      id: {
        type: 'string',
      },
    },
    required: ['id'],
  },
  unqueue: {
    properties: {
      id: {
        type: 'string',
      },
      reason: {
        minLength: 1,
        type: 'string',
      },
    },
    required: ['id', 'reason'],
  },
  untag: {
    properties: {
      ids: {
        items: {
          type: 'string',
        },
        minItems: 1,
        type: 'array',
      },
      tags: {
        items: {
          type: 'string',
        },
        minItems: 1,
        type: 'array',
      },
    },
    required: ['ids', 'tags'],
  },
  update: {
    properties: {
      branch: {
        type: 'string',
      },
      description: {
        type: 'string',
      },
      externalRef: {
        type: 'string',
      },
      harness: {
        type: 'string',
      },
      host: {
        type: 'string',
      },
      id: {
        type: 'string',
      },
      kind: {
        enum: ['idea', 'bug', 'feature'],
        type: 'string',
      },
      name: {
        type: 'string',
      },
      next: {
        type: 'string',
      },
      openEnded: {
        type: 'boolean',
      },
      pinned: {
        type: 'boolean',
      },
      priority: {
        enum: ['p0', 'p1', 'p2', 'p3'],
        type: 'string',
      },
      remote: {
        type: 'string',
      },
      session: {
        type: 'string',
      },
      size: {
        enum: ['small', 'medium', 'large'],
        type: 'string',
      },
      summary: {
        type: 'string',
      },
      target: {
        type: 'string',
      },
      title: {
        type: 'string',
      },
      upstream: {
        type: 'string',
      },
      workerHarness: {
        type: 'string',
      },
      workerSession: {
        type: 'string',
      },
    },
    required: ['id'],
  },
};

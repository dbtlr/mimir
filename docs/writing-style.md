# Documentation writing guide

Mimir's public documentation should be easy to read and easy to verify.

## Write for the reader

- Lead with the outcome or action. Add background only when it helps the reader
  make a decision.
- Prefer short sentences, concrete nouns, and active verbs.
- Keep paragraphs focused. Use a list or table only when it makes comparison or
  sequence clearer.
- Explain one workflow at a time. Link to deeper material instead of interrupting
  the workflow with every edge case.
- Use Mimir's public terms consistently: project, initiative, phase, task,
  Artifact, Scratchpad, Seed, linked work, and operator console.

## Avoid synthetic prose

Do not use language that sounds generated, promotional, or detached from the
product. In particular, avoid:

- canned openings such as "in today's fast-paced world";
- fake quotations, invented reader questions, or claims about what "you might
  be wondering";
- vague praise such as "powerful," "seamless," "robust," or "game-changing"
  when a concrete capability would say more;
- repetitive summary sections that restate the preceding paragraph;
- decorative headings, excessive bold text, emoji, or long strings of dashes;
- rhetorical contrasts in the form "not only X, but also Y";
- narrating the writing process or referring to an assistant, model, prompt, or
  generated content.

Read the finished page aloud. If a sentence sounds like a sales template rather
than a person explaining Mimir, rewrite it.

## Keep claims current

Verify user-facing behavior against its owning surface before publishing:

| Claim | Primary source |
| --- | --- |
| CLI commands and flags | `bun run mimir --help` and command help |
| Agent tools | `packages/bin/src/mcp/server.ts` |
| HTTP behavior | `packages/bin/src/http/server.ts` and integration tests |
| Console workflows | `packages/ui/src/router.tsx`, components, and mutations |
| Stored model and invariants | `docs/schema-reference.md` and accepted ADRs |
| Installation and service behavior | `install.sh` and `docs/guides/` |

Prefer workflow examples over exhaustive command listings. CLI help owns exact
syntax; guides own intent, sequence, and the reason a workflow matters.

## Refresh screenshots

Screenshots use the generated demo workspace, never a personal vault:

```sh
bun run fixtures:vault .dev/docs-fixture
MIMIR_VAULT=.dev/docs-fixture bun run mimir serve --port 64748 --no-hunt
```

Capture a dark 1440 × 900 viewport after the page settles:

| File | Route |
| --- | --- |
| `docs/assets/console-overview.png` | `/` |
| `docs/assets/console-project.png` | `/p/AUR?node=AUR-3` |

Regenerate the fixture immediately before capture. Inspect both images at full
size and at the width used by the rendered Markdown page.

## Review checklist

- Every feature claim matches the current source-built product.
- Examples use fictional names and contain no personal paths or workspace data.
- Links resolve from the page containing them.
- Images have useful alt text and remain legible at the rendered width.
- The page can be skimmed by reading its first sentence and headings.
- Removing a sentence would lose useful information; otherwise remove it.

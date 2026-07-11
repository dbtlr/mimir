import refAuthoring from '../../../../.claude/skills/mimir/references/authoring.md' with { type: 'text' };
import refQuerying from '../../../../.claude/skills/mimir/references/querying.md' with { type: 'text' };
import refSeeds from '../../../../.claude/skills/mimir/references/seeds.md' with { type: 'text' };
import refSetup from '../../../../.claude/skills/mimir/references/setup.md' with { type: 'text' };
import refStatusModel from '../../../../.claude/skills/mimir/references/status-model.md' with { type: 'text' };
import refTags from '../../../../.claude/skills/mimir/references/tags.md' with { type: 'text' };
/**
 * The agent skill, embedded in the binary at compile time (text imports) so
 * `mimir skill install` works anywhere the binary is and the installed skill
 * can never skew from the surface this binary actually speaks (MMR-24).
 * Imports point at the canonical in-repo copy (`.claude/skills/mimir/`) —
 * the single source; a second checked-in copy drifts (MMR-264).
 */
import skillRoot from '../../../../.claude/skills/mimir/SKILL.md' with { type: 'text' };

/** Relative path inside the installed skill directory → file content. */
export const SKILL_FILES: readonly { path: string; content: string }[] = [
  { content: skillRoot, path: 'SKILL.md' },
  { content: refSetup, path: 'references/setup.md' },
  { content: refAuthoring, path: 'references/authoring.md' },
  { content: refQuerying, path: 'references/querying.md' },
  { content: refStatusModel, path: 'references/status-model.md' },
  { content: refTags, path: 'references/tags.md' },
  { content: refSeeds, path: 'references/seeds.md' },
];

export const SKILL_AGENTS = ['claude', 'codex'] as const;
export type SkillAgent = (typeof SKILL_AGENTS)[number];

/**
 * Host layout: the skill directory under a base (home for --global, the
 * working copy for --local). claude → .claude/skills; codex follows the
 * cross-host agent-skills convention → .agents/skills.
 */
export function skillDirFor(agent: SkillAgent, base: string): string {
  const root = agent === 'claude' ? '.claude' : '.agents';
  return `${base}/${root}/skills/mimir`;
}

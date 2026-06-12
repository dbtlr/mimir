/**
 * The agent skill, embedded in the binary at compile time (text imports) so
 * `mimir skill install` works anywhere the binary is and the installed skill
 * can never skew from the surface this binary actually speaks (MMR-24).
 */
import skillRoot from "../../skills/mimir/SKILL.md" with { type: "text" };
import refAuthoring from "../../skills/mimir/references/authoring.md" with { type: "text" };
import refQuerying from "../../skills/mimir/references/querying.md" with { type: "text" };
import refSetup from "../../skills/mimir/references/setup.md" with { type: "text" };
import refStatusModel from "../../skills/mimir/references/status-model.md" with { type: "text" };
import refTags from "../../skills/mimir/references/tags.md" with { type: "text" };

/** Relative path inside the installed skill directory → file content. */
export const SKILL_FILES: ReadonlyArray<{ path: string; content: string }> = [
  { path: "SKILL.md", content: skillRoot },
  { path: "references/setup.md", content: refSetup },
  { path: "references/authoring.md", content: refAuthoring },
  { path: "references/querying.md", content: refQuerying },
  { path: "references/status-model.md", content: refStatusModel },
  { path: "references/tags.md", content: refTags },
];

export const SKILL_AGENTS = ["claude", "codex"] as const;
export type SkillAgent = (typeof SKILL_AGENTS)[number];

/**
 * Host layout: the skill directory under a base (home for --global, the
 * working copy for --local). claude → .claude/skills; codex follows the
 * cross-host agent-skills convention → .agents/skills.
 */
export function skillDirFor(agent: SkillAgent, base: string): string {
  const root = agent === "claude" ? ".claude" : ".agents";
  return `${base}/${root}/skills/mimir`;
}

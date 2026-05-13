export {
  type InstallOptions,
  type InstallResult,
  type SkillTarget,
  findSkillsRoot,
  install,
  listSkillsBundled,
  toClaudeFormat,
  toCursorFormat,
} from "./installer.js";

export const SKILLS = [
  "sf-impact-from-diff",
  "sf-what-broke",
  "sf-cross-layer-trace",
  "sf-dead-code-audit",
  "sf-governor-risk-fix",
  "sf-flow-impact",
  "sf-security-audit",
  "sf-cross-org-diff",
  "sf-deployment-manifest",
  "sf-omnistudio-migration-audit",
] as const;

import { parserRegistry } from "../registry.js";
import { ApprovalProcessParser } from "./approval-process.js";
import { CustomLabelsParser } from "./custom-label.js";
import { CustomMetadataParser } from "./custom-metadata.js";
import { DuplicateRuleParser, MatchingRuleParser } from "./duplicate-rule.js";
import { PermissionSetGroupParser } from "./permission-set-group.js";
import { WorkflowParser } from "./workflow.js";

export const workflowParser = new WorkflowParser();
export const approvalProcessParser = new ApprovalProcessParser();
export const duplicateRuleParser = new DuplicateRuleParser();
export const matchingRuleParser = new MatchingRuleParser();
export const customMetadataParser = new CustomMetadataParser();
export const customLabelsParser = new CustomLabelsParser();
export const permissionSetGroupParser = new PermissionSetGroupParser();

parserRegistry.register(workflowParser);
parserRegistry.register(approvalProcessParser);
parserRegistry.register(duplicateRuleParser);
parserRegistry.register(matchingRuleParser);
parserRegistry.register(customMetadataParser);
parserRegistry.register(customLabelsParser);
parserRegistry.register(permissionSetGroupParser);

export {
  ApprovalProcessParser,
  CustomLabelsParser,
  CustomMetadataParser,
  DuplicateRuleParser,
  MatchingRuleParser,
  PermissionSetGroupParser,
  WorkflowParser,
};

import { parserRegistry } from "../registry.js";
import { MatchingRuleParser } from "./matching-rule.js";

export const matchingRuleParser = new MatchingRuleParser();
parserRegistry.register(matchingRuleParser);

export { MatchingRuleParser };

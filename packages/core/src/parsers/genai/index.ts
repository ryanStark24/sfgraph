import { parserRegistry } from "../registry.js";
import { GenAiPlannerParser } from "./gen-ai-planner.js";
import { GenAiPluginParser } from "./gen-ai-plugin.js";

export const genAiPlannerParser = new GenAiPlannerParser();
export const genAiPluginParser = new GenAiPluginParser();
parserRegistry.register(genAiPlannerParser);
parserRegistry.register(genAiPluginParser);
export { GenAiPlannerParser, GenAiPluginParser };

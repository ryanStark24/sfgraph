import { parserRegistry } from "../registry.js";
import { ApexClassParser } from "./class.js";
import { ApexTriggerParser } from "./trigger.js";

export const apexClassParser = new ApexClassParser();
export const apexTriggerParser = new ApexTriggerParser();

parserRegistry.register(apexClassParser);
parserRegistry.register(apexTriggerParser);

export { ApexClassParser, ApexTriggerParser };

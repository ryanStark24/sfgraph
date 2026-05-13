import { parserRegistry } from "../registry.js";
import { ApexComponentParser } from "./apex-component.js";
import { ApexPageParser } from "./apex-page.js";

export const apexPageParser = new ApexPageParser();
export const apexComponentParser = new ApexComponentParser();
parserRegistry.register(apexPageParser);
parserRegistry.register(apexComponentParser);
export { ApexComponentParser, ApexPageParser };

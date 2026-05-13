import { parserRegistry } from "../registry.js";
import { vlocityParsers } from "./registry.js";

for (const p of vlocityParsers) parserRegistry.register(p);

export { DataRaptorParser } from "./data-raptor.js";
export { IntegrationProcedureParser } from "./integration-procedure.js";
export { OmniScriptParser } from "./omni-script.js";
export { VlocityCardParser } from "./vlocity-card.js";
export { vlocityParsers };

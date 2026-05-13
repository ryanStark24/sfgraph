// Side-effect imports register each parser with the singleton registry.
import "./apex/index.js";
import "./lwc/index.js";
import "./flow/index.js";
import "./object/index.js";
import "./security/index.js";
import "./integration/index.js";
import "./vlocity/index.js";
import "./omnistudio/index.js";
import "./vf/index.js";
import "./presentation/index.js";
import "./reporting/index.js";
import "./genai/index.js";
import "./experience/index.js";
import "./sf-misc/index.js";
import "./generic/index.js";

export * from "./contract.js";
export { parserRegistry, resetRegistryForTests } from "./registry.js";
export { resolveCrossFlavor, normalizeKey } from "./cross-flavor-resolver.js";
export { ParserWorkerPool } from "./worker-pool.js";

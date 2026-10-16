import { parserRegistry } from "../registry.js";
import { AuraBundleParser } from "./bundle.js";

export const auraBundleParser = new AuraBundleParser();
parserRegistry.register(auraBundleParser);

export { AuraBundleParser };

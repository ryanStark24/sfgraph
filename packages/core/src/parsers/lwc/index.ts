import { parserRegistry } from "../registry.js";
import { LwcBundleParser } from "./bundle.js";

export const lwcBundleParser = new LwcBundleParser();
parserRegistry.register(lwcBundleParser);

export { LwcBundleParser };

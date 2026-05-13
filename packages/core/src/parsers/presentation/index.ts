import { parserRegistry } from "../registry.js";
import { LayoutParser } from "./layout.js";
import { LightningPageParser } from "./lightning-page.js";

export const lightningPageParser = new LightningPageParser();
export const layoutParser = new LayoutParser();
parserRegistry.register(lightningPageParser);
parserRegistry.register(layoutParser);
export { LayoutParser, LightningPageParser };

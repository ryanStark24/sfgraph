import { parserRegistry } from "../registry.js";
import { OpaqueNodeParser } from "./opaque-node-parser.js";

export const opaqueNodeParser = new OpaqueNodeParser();
parserRegistry.register(opaqueNodeParser);
export { OpaqueNodeParser };

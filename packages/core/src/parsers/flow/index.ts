import { parserRegistry } from "../registry.js";
import { FlowParser } from "./parser.js";

export const flowParser = new FlowParser();
parserRegistry.register(flowParser);

export { FlowParser };

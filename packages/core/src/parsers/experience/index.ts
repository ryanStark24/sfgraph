import { parserRegistry } from "../registry.js";
import { NetworkParser } from "./network.js";

export const networkParser = new NetworkParser();
parserRegistry.register(networkParser);
export { NetworkParser };

import { parserRegistry } from "../registry.js";
import { CustomObjectParser } from "./object.js";

export const customObjectParser = new CustomObjectParser();
parserRegistry.register(customObjectParser);

export { CustomObjectParser };
export { parseField } from "./field.js";
export { parseRecordType } from "./record-type.js";
export { parseValidationRule } from "./validation-rule.js";

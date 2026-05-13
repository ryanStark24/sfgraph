import { parserRegistry } from "../registry.js";
import { OmniDataTransformParser } from "./data-transform.js";
import { OmniIntegrationProcedureParser } from "./integration-procedure.js";
import { OmniProcessParser } from "./process.js";
import { OmniUiCardParser } from "./ui-card.js";

export const omniProcessParser = new OmniProcessParser();
export const omniDataTransformParser = new OmniDataTransformParser();
export const omniIntegrationProcedureParser = new OmniIntegrationProcedureParser();
export const omniUiCardParser = new OmniUiCardParser();

parserRegistry.register(omniProcessParser);
parserRegistry.register(omniDataTransformParser);
parserRegistry.register(omniIntegrationProcedureParser);
parserRegistry.register(omniUiCardParser);

export {
  OmniDataTransformParser,
  OmniIntegrationProcedureParser,
  OmniProcessParser,
  OmniUiCardParser,
};

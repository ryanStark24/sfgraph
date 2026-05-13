import type { Parser } from "../contract.js";
import { DataRaptorParser } from "./data-raptor.js";
import { IntegrationProcedureParser } from "./integration-procedure.js";
import { OmniScriptParser } from "./omni-script.js";
import { VlocityCardParser } from "./vlocity-card.js";

export const vlocityParsers: Parser<any>[] = [
  new DataRaptorParser(),
  new IntegrationProcedureParser(),
  new OmniScriptParser(),
  new VlocityCardParser(),
];

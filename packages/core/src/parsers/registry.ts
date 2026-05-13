import { StorageError } from "@ryanstark24/sfgraph-shared";
import type { Parser, ParserRegistry } from "./contract.js";

class DefaultParserRegistry implements ParserRegistry {
  private readonly map = new Map<string, Parser<unknown>>();

  register(parser: Parser<unknown>): void {
    if (this.map.has(parser.type)) {
      throw new StorageError(
        `SF_DUPLICATE_PARSER: parser already registered for type ${parser.type}`,
      );
    }
    this.map.set(parser.type, parser);
  }

  for(type: string): Parser<unknown> | undefined {
    return this.map.get(type);
  }

  all(): Parser<unknown>[] {
    return Array.from(this.map.values());
  }

  /** Test-only escape hatch. */
  clear(): void {
    this.map.clear();
  }
}

export const parserRegistry: DefaultParserRegistry = new DefaultParserRegistry();

export function resetRegistryForTests(): void {
  parserRegistry.clear();
}

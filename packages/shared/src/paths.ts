import envPaths from "env-paths";

export interface SfgraphPaths {
  data: string;
  cache: string;
  log: string;
  config: string;
  temp: string;
}

export function getSfgraphPaths(): SfgraphPaths {
  const p = envPaths("sfgraph", { suffix: "" });
  return {
    data: p.data,
    cache: p.cache,
    log: p.log,
    config: p.config,
    temp: p.temp,
  };
}

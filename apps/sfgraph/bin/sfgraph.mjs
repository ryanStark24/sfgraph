#!/usr/bin/env node
import { run } from "@sfgraph/cli";

run(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});

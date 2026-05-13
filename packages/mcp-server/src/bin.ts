import { SfgraphMcpServer } from "./server.js";
import { installShutdownHandlers } from "./shutdown.js";

export async function runMcpServer(): Promise<void> {
  const server = new SfgraphMcpServer();
  server.registerDefaults();
  installShutdownHandlers({
    onShutdown: async () => {
      // Future: flush telemetry, close stores. Phase 0: nothing held open.
    },
  });
  await server.startStdio();
}

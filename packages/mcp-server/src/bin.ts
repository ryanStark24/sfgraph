import { closeAllContexts } from "./context.js";
import { SfgraphMcpServer } from "./server.js";
import { installShutdownHandlers } from "./shutdown.js";

export async function runMcpServer(): Promise<void> {
  const server = new SfgraphMcpServer();
  server.registerDefaults();
  installShutdownHandlers({
    onShutdown: async () => {
      await closeAllContexts();
    },
  });
  await server.startStdio();
}

import { spawn } from "node:child_process";
import { platform } from "node:os";

export interface ServeOpts {
  port: number;
  host: string;
  open: boolean;
  iUnderstandPublicBind?: boolean;
}

/**
 * Hosts that bind only to the loopback interface. Anything else is reachable
 * from the LAN (or, for `0.0.0.0`, from anyone the machine routes to). The
 * web API has no auth — exposing it leaks the ingested org graph in full.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]);
function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/** Open `url` in the user's default browser. Best-effort; failure is silent. */
function openBrowser(url: string): void {
  const cmd =
    platform() === "darwin"
      ? ["open", [url]]
      : platform() === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd[0] as string, cmd[1] as string[], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* best effort */
  }
}

export async function serveCmd(opts: ServeOpts): Promise<void> {
  if (!isLoopback(opts.host) && !opts.iUnderstandPublicBind) {
    console.error(
      `sfgraph serve: refusing to bind to non-loopback host '${opts.host}' without --i-understand-public-bind.
  The web API has no authentication; binding publicly exposes the full ingested org graph (schema, Apex names, relationships) to the LAN.
  If this is what you want, re-run with --i-understand-public-bind.`,
    );
    process.exitCode = 1;
    return;
  }
  if (!isLoopback(opts.host)) {
    console.warn(
      `sfgraph serve: WARNING — binding to '${opts.host}'. The web API has no auth; anyone reachable on this interface can read the entire ingested org graph.`,
    );
  }
  const { startWebServer } = await import("@ryanstark24/sfgraph-web");
  const handle = await startWebServer({ port: opts.port, host: opts.host });
  console.log(`\n  open ${handle.url} to explore the ingested graph(s)\n`);
  if (opts.open) openBrowser(handle.url);

  // Block until SIGINT/SIGTERM, then shut down cleanly.
  const stop = async (sig: string) => {
    console.log(`\nsfgraph-web: received ${sig}, shutting down…`);
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  // Keep the loop alive — the http server holds it, but be explicit so a
  // future refactor that closes the listener doesn't accidentally drain
  // the loop. (Same root cause as the post-object-phase silent-exit fix.)
  await new Promise(() => {});
}

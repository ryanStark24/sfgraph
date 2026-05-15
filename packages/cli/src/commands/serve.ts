import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";

export interface ServeOpts {
  port: number;
  host: string;
  open: boolean;
  iUnderstandPublicBind?: boolean;
}

/**
 * Find PIDs holding the given TCP port on loopback. macOS / Linux only —
 * Windows uses a different toolchain (`netstat -ano` + tasklist) and we
 * skip the auto-kill there. Returns an empty list on Windows or if the
 * probe fails, which triggers the normal EADDRINUSE error path.
 */
function pidsOnPort(port: number): number[] {
  if (platform() === "win32") return [];
  try {
    const r = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    if (r.status !== 0 || !r.stdout) return [];
    return r.stdout
      .split("\n")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * Send SIGTERM to each pid, wait briefly, then SIGKILL any that survived.
 * We only do this for PIDs we identified as listening on OUR port — never a
 * blind kill. Self-PID is filtered out as a safety belt.
 */
async function killPids(pids: number[]): Promise<void> {
  const self = process.pid;
  const targets = pids.filter((p) => p !== self);
  if (targets.length === 0) return;
  for (const p of targets) {
    try {
      process.kill(p, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  // Brief grace period for clean shutdown, then escalate.
  await new Promise((r) => setTimeout(r, 400));
  for (const p of targets) {
    try {
      process.kill(p, 0); // probe — throws if gone
      process.kill(p, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  // One more tick so the kernel releases the bind.
  await new Promise((r) => setTimeout(r, 150));
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
  let handle: Awaited<ReturnType<typeof startWebServer>>;
  try {
    handle = await startWebServer({ port: opts.port, host: opts.host });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code !== "EADDRINUSE" || !isLoopback(opts.host)) throw err;
    // Auto-recover: only happens when binding to loopback (the safe default
    // path). For non-loopback binds we surface the original error — the
    // process holding the port might not belong to us.
    const pids = pidsOnPort(opts.port);
    if (pids.length === 0) {
      console.error(
        `sfgraph serve: port ${opts.port} is in use but I couldn't identify the holder. Pick another port with --port.`,
      );
      throw err;
    }
    console.log(
      `sfgraph serve: port ${opts.port} held by pid${pids.length > 1 ? "s" : ""} ${pids.join(", ")} — terminating and retrying…`,
    );
    await killPids(pids);
    handle = await startWebServer({ port: opts.port, host: opts.host });
  }
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

import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";

export interface ServeOpts {
  port: number;
  host: string;
  open: boolean;
  iUnderstandPublicBind?: boolean;
}

/**
 * Find PIDs holding the given TCP port in LISTEN state.
 *   macOS / Linux: `lsof -ti tcp:<port> -sTCP:LISTEN`
 *   Windows:      `netstat -ano` filtered to LISTENING lines on `:<port>`
 * Returns an empty list if the probe fails, which triggers the normal
 * EADDRINUSE error path (sane fallback — we never want this helper to
 * raise into the user's error stream).
 */
function pidsOnPort(port: number): number[] {
  try {
    if (platform() === "win32") {
      const r = spawnSync("netstat", ["-ano"], { encoding: "utf8" });
      if (r.status !== 0 || !r.stdout) return [];
      const pids = new Set<number>();
      // Lines look like:  TCP    127.0.0.1:7777    0.0.0.0:0    LISTENING    1234
      // Match the trailing PID column on rows whose local address ends in
      // `:<port>` and whose state is LISTENING. The `:port` suffix anchor
      // matters — without it, a remote-side port match would false-positive.
      const re = new RegExp(`\\s+TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`);
      for (const line of r.stdout.split(/\r?\n/)) {
        const m = re.exec(line);
        if (m?.[1]) {
          const pid = Number.parseInt(m[1], 10);
          if (Number.isFinite(pid) && pid > 0) pids.add(pid);
        }
      }
      return [...pids];
    }
    const lsof = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    if (lsof.status === 0 && lsof.stdout) {
      return lsof.stdout
        .split("\n")
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    }
    // Fallback for Linux distros that don't ship lsof by default (Alpine,
    // minimal Docker base images, some embedded distros). `ss` from
    // iproute2 is near-universally available on modern Linux and emits
    // pid info in the form `users:(("node",pid=1234,fd=21))`.
    const ss = spawnSync("ss", ["-tlnpH", `sport = :${port}`], { encoding: "utf8" });
    if (ss.status !== 0 || !ss.stdout) return [];
    const pids = new Set<number>();
    const re = /pid=(\d+)/g;
    let m: RegExpExecArray | null = re.exec(ss.stdout);
    while (m !== null) {
      const pid = Number.parseInt(m[1] ?? "", 10);
      if (Number.isFinite(pid) && pid > 0) pids.add(pid);
      m = re.exec(ss.stdout);
    }
    return [...pids];
  } catch {
    return [];
  }
}

/**
 * Full command line of `pid`, or null when it can't be read.
 *   Unix:    `ps -p <pid> -o command=`
 *   Windows: PowerShell `Get-CimInstance Win32_Process` (wmic is deprecated).
 */
function commandLineOf(pid: number): string | null {
  try {
    const r =
      platform() === "win32"
        ? spawnSync(
            "powershell",
            [
              "-NoProfile",
              "-Command",
              `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
            ],
            { encoding: "utf8" },
          )
        : spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    if (r.status !== 0 || typeof r.stdout !== "string") return null;
    const line = r.stdout.trim();
    return line.length > 0 ? line : null;
  } catch {
    return null;
  }
}

/** A command-line token that is the sfgraph CLI entry point: the `sfgraph`
 *  bin (any dir, optional .js/.cjs/.cmd/.exe), a script inside the published
 *  `@ryanstark24/sfgraph` package, or the built entry of this repo's CLI. */
function isSfgraphEntryToken(tok: string): boolean {
  return (
    /(^|[/\\])sfgraph(\.c?js|\.cmd|\.exe)?$/i.test(tok) ||
    /@ryanstark24[/\\]sfgraph[/\\]\S*\.c?js$/i.test(tok) ||
    /sfgraph\S*[/\\]packages[/\\]cli[/\\]dist[/\\]\S*\.c?js$/i.test(tok)
  );
}

/**
 * True when a command line is an `sfgraph serve` process: the sfgraph entry
 * point immediately followed by the `serve` subcommand (review M7: a `serve`
 * token elsewhere, e.g. `sfgraph ingest --org serve`, does not count).
 * Exported for tests.
 */
export function isSfgraphServeCommand(cmd: string): boolean {
  const toks = cmd.trim().split(/\s+/);
  for (let i = 0; i < toks.length - 1; i++) {
    if (isSfgraphEntryToken(toks[i] ?? "")) return toks[i + 1] === "serve";
  }
  return false;
}

/**
 * Terminate each pid.
 *   Unix:    SIGTERM, brief grace period, then SIGKILL any survivors.
 *   Windows: `taskkill /F /PID <pid>` — Windows has no SIGTERM/SIGKILL
 *            distinction; TerminateProcess is the only primitive. /F
 *            forces termination; without it, the call only delivers a
 *            WM_CLOSE that GUI-less processes ignore.
 * We only kill PIDs we identified as listening on OUR port — never a blind
 * kill. Self-PID is filtered out as a safety belt.
 */
async function killPids(pids: number[]): Promise<void> {
  const self = process.pid;
  const targets = pids.filter((p) => p !== self);
  if (targets.length === 0) return;
  if (platform() === "win32") {
    for (const p of targets) {
      try {
        spawnSync("taskkill", ["/F", "/PID", String(p)], { stdio: "ignore" });
      } catch {
        /* already gone or insufficient permissions */
      }
    }
    // One tick so Windows releases the TCP bind before we retry listen.
    await new Promise((r) => setTimeout(r, 250));
    return;
  }
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
    // Only ever signal a stale `sfgraph serve`. Anything else on the port
    // (another dev server, a database, ...) is left alone: report and stop.
    const foreign = pids
      .filter((p) => p !== process.pid)
      .map((p) => ({ pid: p, cmd: commandLineOf(p) }))
      .filter((h) => h.cmd === null || !isSfgraphServeCommand(h.cmd));
    if (foreign.length > 0) {
      console.error(
        `sfgraph serve: port ${opts.port} is held by ${foreign
          .map((h) => `pid ${h.pid}${h.cmd ? ` (${h.cmd.slice(0, 120)})` : " (command unknown)"}`)
          .join(
            ", ",
          )}, which is not an sfgraph server. Not stopping it; pick another port with --port or stop that process yourself.`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `sfgraph serve: port ${opts.port} held by a previous sfgraph serve (pid${pids.length > 1 ? "s" : ""} ${pids.join(", ")}) — terminating and retrying…`,
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

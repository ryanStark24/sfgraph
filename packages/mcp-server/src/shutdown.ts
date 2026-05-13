export interface ShutdownOpts {
  onShutdown: () => Promise<void> | void;
  watchdogMs?: number;
  signalEmitter?: NodeJS.EventEmitter;
  stdinEmitter?: NodeJS.EventEmitter;
  exit?: (code: number) => void;
}

export type Disposer = () => void;

export function installShutdownHandlers(opts: ShutdownOpts): Disposer {
  const {
    onShutdown,
    watchdogMs = 3000,
    signalEmitter = process,
    stdinEmitter = process.stdin,
    exit = (code) => process.exit(code),
  } = opts;
  let fired = false;
  let watchdog: NodeJS.Timeout | undefined;

  const trigger = (_reason: string): void => {
    if (fired) return;
    fired = true;
    watchdog = setTimeout(() => exit(1), watchdogMs);
    // Don't keep event loop alive solely for the watchdog
    if (typeof (watchdog as any).unref === "function") (watchdog as any).unref();
    Promise.resolve()
      .then(() => onShutdown())
      .catch(() => {})
      .finally(() => {
        if (watchdog) clearTimeout(watchdog);
      });
  };

  const onSigint = (): void => trigger("SIGINT");
  const onSigterm = (): void => trigger("SIGTERM");
  const onStdinEnd = (): void => trigger("stdin-end");
  const onStdinClose = (): void => trigger("stdin-close");

  signalEmitter.on("SIGINT", onSigint);
  signalEmitter.on("SIGTERM", onSigterm);
  stdinEmitter.on("end", onStdinEnd);
  stdinEmitter.on("close", onStdinClose);

  return () => {
    signalEmitter.off("SIGINT", onSigint);
    signalEmitter.off("SIGTERM", onSigterm);
    stdinEmitter.off("end", onStdinEnd);
    stdinEmitter.off("close", onStdinClose);
    if (watchdog) clearTimeout(watchdog);
  };
}

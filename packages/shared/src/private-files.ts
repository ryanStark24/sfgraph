import { chmodSync, existsSync, mkdirSync } from "node:fs";

/** Owner-only modes for what sfgraph stores. They apply on POSIX; Windows ignores them. */
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

const posix = (): boolean => process.platform !== "win32";

/**
 * Create `dir` (and missing parents) readable by the owner only. A folder that already exists is
 * left as it is: it may be shared on purpose, and only a folder sfgraph creates is its to lock.
 */
export function ensurePrivateDir(dir: string): void {
  const existed = existsSync(dir);
  mkdirSync(dir, { recursive: true, ...(posix() ? { mode: PRIVATE_DIR_MODE } : {}) });
  if (existed || !posix()) return;
  try {
    // mkdir's mode is cut by the umask only downwards, but be explicit for the leaf.
    chmodSync(dir, PRIVATE_DIR_MODE);
  } catch {
    // best effort
  }
}

/** Make a stored file (graph, backup, snapshot, org list) owner-only. Best effort, POSIX only. */
export function restrictFile(file: string): void {
  if (!posix()) return;
  try {
    chmodSync(file, PRIVATE_FILE_MODE);
  } catch {
    // a missing or foreign file is left alone
  }
}

/** `restrictFile` for a SQLite database and the -wal/-shm files beside it, when they exist. */
export function restrictDbFiles(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (suffix === "" || existsSync(`${dbPath}${suffix}`)) restrictFile(`${dbPath}${suffix}`);
  }
}

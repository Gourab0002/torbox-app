import { readdirSync, rmSync, statSync } from 'fs';
import path from 'path';

// Temp directories are named `test-<pid>-<label>-<suffix>` so a later run can
// tell whether the process that created them is still alive.
const PID_IN_NAME = /^test-(\d+)-/;
const LEGACY_MAX_AGE_MS = 10 * 60 * 1000;
let pruned = false;

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error?.code === 'EPERM';
  }
}

/**
 * Remove temp test directories left behind by earlier runs.
 *
 * On Windows a `bun:sqlite` database that still has prepared statements keeps
 * its file handle open until the process exits, so `removeTempDir` cannot delete
 * the directory while the suite is running. Those directories become deletable
 * once their process exits, so prune them at the start of the next run.
 *
 * Directories owned by a still-running process are skipped, so concurrently
 * running suites (e.g. this repository's isolated test runner) are never
 * affected. Directories using the old naming scheme have no recorded owner and
 * are only pruned once they are older than `legacyMaxAgeMs`.
 */
export function pruneStaleTestDirs(dataDir, { legacyMaxAgeMs = LEGACY_MAX_AGE_MS } = {}) {
  if (pruned) return;
  pruned = true;

  try {
    const now = Date.now();
    for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('test-')) continue;
      const fullPath = path.join(dataDir, entry.name);
      try {
        const match = PID_IN_NAME.exec(entry.name);
        if (match) {
          if (isProcessAlive(Number(match[1]))) continue;
        } else if (now - statSync(fullPath).mtimeMs < legacyMaxAgeMs) {
          continue;
        }
        rmSync(fullPath, { recursive: true, force: true });
      } catch {
        // Still locked or partially removed — leave it for a later run.
      }
    }
  } catch {
    // The data directory may not exist yet.
  }
}

/**
 * Best-effort removal of a temporary test directory.
 *
 * On Windows, `bun:sqlite` keeps the database file handle open until the
 * connection object is garbage collected, which makes the directory undeletable
 * (`EBUSY`/`EPERM`). Force a GC between attempts to release the handle. Bun
 * ignores Node's `maxRetries`/`retryDelay` options, so retry manually with a
 * short synchronous backoff and then hand the directory to `pruneStaleTestDirs`
 * on the next run.
 */
export function removeTempDir(dir, { attempts = 3, delayMs = 20 } = {}) {
  if (!dir) return;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const retryable =
        error?.code === 'EBUSY' || error?.code === 'EPERM' || error?.code === 'ENOTEMPTY';
      if (!retryable || attempt === attempts) {
        if (retryable) {
          console.warn(`[test] could not remove temp dir ${dir}: ${error.code}`);
          return;
        }
        throw error;
      }

      // Release sqlite handles held by unreferenced Database objects, then retry.
      globalThis.Bun?.gc?.(true);
      // Test cleanup only — a synchronous sleep keeps this simple and portable.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
}

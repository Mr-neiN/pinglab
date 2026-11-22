/**
 * An exclusive lock for a data file, so two PingLab processes cannot read the same version of
 * a file and have the second write wipe out the first one's change.
 *
 * The lock is a file created with O_EXCL, which local filesystems and network shares implement
 * atomically: the create either wins or it does not. The wait is bounded, because a write takes
 * milliseconds and a user should never sit behind a stuck one; when it runs out the caller
 * reports that another action is writing instead of overwriting it. A lock left behind by a
 * killed process is broken after STALE_MS, or as soon as its recorded owner is provably gone,
 * so a crash cannot lock PingLab out of its own restore points.
 */
import { closeSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(sleepCell, 0, 0, ms);

/** True when a pid exists. EPERM means it exists and belongs to someone else. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * Remove a lock whose owner is gone, or one that has outlived any plausible write. The rename
 * comes first so two waiters cannot both delete the same stale lock and then both "win" the
 * create: only one rename can succeed, and the winner deletes what it claimed.
 */
function breakStale(file, staleMs) {
  let owner = null;
  let age = 0;
  try {
    age = Date.now() - statSync(file).mtimeMs;
    owner = Number(String(readFileSync(file, "utf8")).trim().split(/\s+/)[0]) || null;
  } catch {
    return; // gone, or still being written: the next create attempt settles it
  }
  const gone = owner !== null && !alive(owner);
  if (!gone && age < staleMs) return;
  // A lock that has only just appeared may not have its pid in it yet.
  if (gone && age < 500) return;
  const claimed = `${file}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(file, claimed);
  } catch {
    return; // somebody else broke it and holds the new lock
  }
  try {
    rmSync(claimed, { force: true });
  } catch {
    /* a leftover .stale- file is harmless and never read again */
  }
}

/**
 * Take the lock, waiting up to `waitMs`. Returns a release function, or null when the wait ran
 * out - the caller turns that into a sentence rather than writing anyway.
 */
export function acquireLock(file, { waitMs = 5000, staleMs = 30000, pollMs = 20 } = {}) {
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    try {
      const fd = openSync(file, "wx");
      try {
        writeSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          rmSync(file, { force: true });
        } catch {
          /* already gone */
        }
      };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }
    breakStale(file, staleMs);
    if (Date.now() >= deadline) return null;
    sleep(pollMs);
  }
}

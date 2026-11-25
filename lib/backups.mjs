import { readFileSync, mkdirSync, statSync, openSync, closeSync, writeSync, fsyncSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, dataPath } from "./paths.mjs";
import { keepUnreadableAside } from "./keep-unreadable.mjs";
import { acquireLock } from "./backup-lock.mjs";
import { looksDenied } from "./tweak-shared.mjs";
const BACKUP_FILE = dataPath("backups.json");
/** How the file is named in messages: the folder the app runs from, not an absolute path. */
/** Named in messages by its real path: a user told to repair it has to be able to find it. */
export const BACKUP_NAME = BACKUP_FILE;
// Windows "Wireless Adapter Settings -> Power Saving Mode" under the active power scheme.
export const WIRELESS_SUBGROUP = "19cbb8fa-5279-450e-9fac-8a3d5fedd0c1";
export const WIRELESS_SETTING = "12bbebe6-58d6-4636-95bb-3217ef867c1a";
export const EMPTY = { dns: {}, planPower: {}, nicPower: {}, nagle: {}, adapterTuning: {}, wifiOrder: {}, history: [] };

const isPlainObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Sections a build may carry; each has to be a plain object when it is there at all. */
const BACKUP_SECTIONS = ["dns", "planPower", "nicPower", "nagle", "adapterTuning", "wifiOrder", "powerSave"];

function normalizeBackups(raw) {
  const merged = { ...structuredClone(EMPTY), ...raw };
  // Earlier builds kept the power-plan values under "powerSave". Fold them into
  // "planPower" so a revert written by an older build still works.
  merged.planPower = { ...(raw.powerSave || {}), ...(raw.planPower || {}) };
  merged.nicPower = merged.nicPower || {};
  merged.adapterTuning = merged.adapterTuning || {};
  merged.wifiOrder = merged.wifiOrder || {};
  merged.history = Array.isArray(merged.history) ? merged.history : [];
  delete merged.powerSave;
  return merged;
}

/** Size and mtime, so a repaired file is read again without restarting the app. */
function stampOfBackupFile() {
  try {
    const s = statSync(BACKUP_FILE);
    return `${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  } catch {
    return "missing";
  }
}

let backupCache = null;

/**
 * Read and validate backups.json. A missing file is a first run and is empty. A file that
 * exists but cannot be read, parsed or has the wrong shape is a different thing: it may be
 * the only record of what this machine looked like before PingLab changed it, so it is
 * reported as unreadable (never as empty), a copy of it is kept beside it, and every write
 * refuses to touch it.
 */
function inspectBackups({ fresh = false } = {}) {
  const stamp = stampOfBackupFile();
  if (!fresh && backupCache && backupCache.stamp === stamp) return backupCache.result;

  let result;
  if (stamp === "missing") {
    result = { data: structuredClone(EMPTY), problem: null };
  } else {
    let text;
    let flaw = null;
    try {
      text = readFileSync(BACKUP_FILE, "utf8");
    } catch (err) {
      flaw = `could not be read (${err?.code || err?.message || err})`;
    }
    let raw = null;
    if (!flaw) {
      try {
        raw = JSON.parse(text);
      } catch (err) {
        flaw = `is not valid JSON (${err.message})`;
      }
    }
    if (!flaw && !isPlainObject(raw)) {
      flaw = `does not hold a JSON object (it holds ${Array.isArray(raw) ? "a list" : raw === null ? "null" : typeof raw})`;
    }
    if (!flaw) {
      const broken = BACKUP_SECTIONS.find((k) => k in raw && !isPlainObject(raw[k]));
      if (broken) flaw = `has an unexpected value for "${broken}"`;
      else if ("history" in raw && !Array.isArray(raw.history)) flaw = `has an unexpected value for "history"`;
    }

    if (!flaw) {
      result = { data: normalizeBackups(raw), problem: null };
    } else {
      const kept = keepUnreadableAside(BACKUP_FILE, { suffix: ".json" });
      const where = kept.ok
        ? `A copy was kept as ${kept.path}, so its restore points are not lost.`
        : `A copy could not be made either (${kept.error}), so this file is the only copy - do not delete it.`;
      result = {
        data: structuredClone(EMPTY),
        problem: {
          file: BACKUP_NAME,
          detail: flaw,
          copy: kept.path,
          message: `${BACKUP_NAME} ${flaw}, so its restore points are unknown, not empty. ${where}`,
          refusal: `Refusing to change anything: ${BACKUP_NAME} ${flaw}, and overwriting it would destroy the only record of what this machine looked like before PingLab changed it. ${where} Repair the file, or move the copy back over ${BACKUP_NAME}, then try again.`,
        },
      };
    }
  }
  backupCache = { stamp, result };
  return result;
}

/** Restore points. Always a fresh copy, so a caller may edit what it gets back. */
export function readBackups() {
  return structuredClone(inspectBackups().data);
}

/**
 * The same read, never from the cache. Every write path uses it: a cached copy taken before
 * another process wrote would be written back over that process's change.
 */
function readBackupsFresh() {
  return structuredClone(inspectBackups({ fresh: true }).data);
}

/** Whether the restore points can be trusted, for every surface that reports a count. */
export function backupStatus() {
  const { problem } = inspectBackups();
  return problem ? { ok: false, problem } : { ok: true, problem: null };
}

/**
 * Windows refuses to replace a file another process has open, even briefly for a read: the
 * rename then fails with EPERM/EBUSY/EACCES. Readers here are short-lived - the GUI polling
 * state, the page refreshing, another PingLab instance reading its restore points - so retry
 * the rename for about a second instead of dropping the write. If the file stays locked the
 * error still surfaces, and the previous file is untouched.
 */
function replaceFile(from, to) {
  const transient = new Set(["EPERM", "EBUSY", "EACCES"]);
  const sleepCell = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if (!transient.has(err?.code) || attempt >= 40) throw err;
      Atomics.wait(sleepCell, 0, 0, 25);
    }
  }
}

/**
 * Replace backups.json atomically: the new content is written and flushed to a temporary
 * file in the same folder, then renamed over the original. A crash, a full disk or a locked
 * file therefore leaves the previous restore points intact instead of a truncated file.
 *
 * It refuses to write at all when the existing file cannot be read, because overwriting it
 * would destroy the only record of the machine's original values. That refusal is why each
 * action records its restore point before Windows is touched: if the record cannot be
 * written, the setting is left alone too.
 */
function writeBackupsUnlocked(b) {
  const { problem } = inspectBackups({ fresh: true });
  if (problem) throw new Error(problem.refusal);
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = join(DATA_DIR, `.backups-${process.pid}-${Math.random().toString(36).slice(2, 10)}.tmp`);
  let fd;
  try {
    fd = openSync(tmp, "w");
    writeSync(fd, `${JSON.stringify(b, null, 2)}\n`, null, "utf8");
    fsyncSync(fd); // the bytes are on disk before the name points at them
    closeSync(fd);
    fd = undefined;
    replaceFile(tmp, BACKUP_FILE); // atomic replace, retried through a transient reader
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    throw new Error(`Could not save the restore points to ${BACKUP_NAME} (${err?.code || err?.message || err}).`);
  }
  // What is on disk just changed, so the next read must not come from the cached copy.
  backupCache = null;
  // The rename is atomic; flushing the folder entry makes it survive a power cut where the
  // platform allows it. Windows has no folder handle to flush, and NTFS has already
  // committed the rename by the time it returns.
  if (process.platform !== "win32") {
    try {
      const dir = openSync(DATA_DIR, "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } catch {
      /* the file itself is durable already */
    }
  }
}

const BACKUP_LOCK = dataPath(".backups.lock");
/** What a second instance is told instead of silently overwriting the first one's record. */
export const BACKUP_BUSY = "Another PingLab action is writing restore points. Try again in a moment.";

/** How long to wait for another instance's write. A write takes milliseconds. */
const lockWaitMs = () => Number(process.env.PINGLAB_BACKUP_LOCK_WAIT_MS) || 5000;

/** Take the restore-point lock, or throw the sentence the user can act on. */
function lockBackups() {
  const release = acquireLock(BACKUP_LOCK, { waitMs: lockWaitMs() });
  if (!release) throw new Error(BACKUP_BUSY);
  return release;
}

/**
 * Read the file, let `mutate` change it, write it back - all under one exclusive lock, so a
 * second process cannot read the same version and have its write undo the first one's change.
 * The read is fresh, never cached: that is what stops a stale copy from resurrecting a
 * restore point another instance has already cleared. `mutate` returning false leaves the
 * file untouched, for the cases where there is nothing to write.
 */
export function updateBackups(mutate) {
  const release = lockBackups();
  try {
    const b = readBackupsFresh();
    const outcome = mutate(b);
    if (outcome !== false) writeBackupsUnlocked(b);
    return outcome;
  } finally {
    release();
  }
}

/** Seed or replace the whole file from outside this module (tests, repair tools). */
export function writeBackups(b) {
  const release = lockBackups();
  try {
    writeBackupsUnlocked(structuredClone(b));
  } finally {
    release();
  }
}

/**
 * History is bookkeeping, so failing to record it never turns a real change into a reported
 * failure: the caller appends the returned sentence to the result instead.
 */
export function logChange(action, detail) {
  try {
    updateBackups((b) => {
      b.history.unshift({ action, detail, at: new Date().toISOString() });
      b.history = b.history.slice(0, 50);
    });
    return null;
  } catch (err) {
    return `The setting changed, but the history entry could not be saved (${err?.message || err}).`;
  }
}

/**
 * Record the values in effect right now, before Windows is asked to change anything. The
 * first record wins: a second apply must not replace the original with the tuned value.
 * A record that cannot be written stops the action with the setting untouched.
 */
export function recordRestorePoint(area, alias, value) {
  try {
    const out = updateBackups((b) => {
      // The read above happened under the lock, so "already recorded" is the file's answer,
      // not a cached one: a point another process wrote meanwhile is respected.
      if (b[area]?.[alias]) return { fresh: false, token: null };
      b[area] = { ...(b[area] || {}), [alias]: { ...value, at: new Date().toISOString() } };
      pauseForRaceTest();
      return { fresh: true, token: { area, alias } };
    });
    return { ok: true, fresh: out.fresh, token: out.token };
  } catch (err) {
    return { ok: false, error: `${err?.message || err} Nothing was changed, because the restore point could not be recorded.` };
  }
}

/**
 * Test hook: widens the critical section so two processes can be made to collide on purpose
 * (lib/concurrency.test.mjs). It only waits - there is no retry - so what makes the two writes
 * serialise has to be the lock, not luck.
 */
function pauseForRaceTest() {
  const ms = Number(process.env.PINGLAB_BACKUP_DELAY_MS) || 0;
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Drop a restore point written for an attempt Windows never carried out. */
function discardRestorePoint(token) {
  if (!token) return;
  try {
    updateBackups((b) => {
      if (!b[token.area]?.[token.alias]) return false;
      delete b[token.area][token.alias];
      return true;
    });
  } catch {
    // Keeping a point for a change that did not happen is the safe failure: it holds the
    // values that are still live, so restoring it writes them back and changes nothing.
  }
}

/**
 * Close out one action. Its restore point was written before elevation, so an attempt that
 * provably never ran (a closed prompt, a policy refusal) has to remove it again; anything
 * else, including a script that failed halfway, keeps it - a partial change still needs the
 * values it recorded. A bookkeeping problem is appended to the result rather than turning a
 * real change into a reported failure.
 */
export function finishChange(res, { token, after, action, detail }) {
  if (!res?.ok) {
    if (res?.cancelled || looksDenied(res?.error || res?.data?.message)) discardRestorePoint(token);
    return res;
  }
  const notes = [];
  if (after) {
    try {
      updateBackups(after);
    } catch (err) {
      notes.push(`The setting changed, but ${BACKUP_NAME} could not be updated (${err?.message || err}).`);
    }
  }
  const warning = logChange(action, detail);
  if (warning) notes.push(warning);
  if (notes.length) {
    res.data = { ...(res.data || {}), message: `${res.data?.message ? `${res.data.message} ` : ""}${notes.join(" ")}` };
  }
  return res;
}


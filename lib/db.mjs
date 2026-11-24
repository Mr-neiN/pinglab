import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { keepUnreadableAside } from "./keep-unreadable.mjs";
import { DATA_DIR, dataPath } from "./paths.mjs";

mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = dataPath("pinglab.sqlite");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    summary TEXT,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tweaks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    detail TEXT,
    applied_at TEXT NOT NULL,
    undone_at TEXT
  );
  CREATE INDEX IF NOT EXISTS runs_kind ON runs(kind, id DESC);
`;

const SOAK_SCHEMA = `
  CREATE TABLE IF NOT EXISTS soak_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    seconds INTEGER NOT NULL,
    interval_ms INTEGER NOT NULL,
    config TEXT,
    summary TEXT
  );
  CREATE TABLE IF NOT EXISTS soak_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    target TEXT NOT NULL,
    ms REAL,
    ok INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS soak_samples_run ON soak_samples(run_id, target, ts);
`;

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/** How long one connection waits for another writer before SQLite answers "busy". */
const BUSY_TIMEOUT_MS = 5000;
/** How many times a write that still met a busy database is retried before it is thrown. */
const WRITE_RETRIES = 6;

/**
 * Two PingLab processes share one history database: the GUI's bridge, the web server and a
 * terminal soak can all be running at once. WAL lets a reader work while a writer commits,
 * and busy_timeout makes a second writer wait its turn instead of failing immediately with
 * "database is locked", which used to drop the sample. Both are per-connection settings, so
 * they are applied on every open.
 */
function tuneForConcurrentWriters(db) {
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } catch {
    // An in-memory database, or a folder without the shared-memory file WAL needs: the
    // default journal keeps working, just with less concurrency.
  }
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  } catch {
    /* older SQLite: the retry below is the fallback */
  }
}

const isBusy = (err) =>
  /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(String(err?.message || err));

/**
 * Run one write, waiting out a database another process is writing. A write that still meets a
 * busy database after the busy_timeout is retried with a growing pause; if it fails again the
 * error is thrown, so a sample that did not land is never reported as if it had.
 */
function writeWithRetry(run) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return run();
    } catch (err) {
      if (!isBusy(err) || attempt >= WRITE_RETRIES) throw err;
      Atomics.wait(sleepCell, 0, 0, 25 * (attempt + 1));
    }
  }
}

function openAt(file) {
  const opened = new DatabaseSync(file);
  // The constructor alone does not read the file: a file that is not a database only
  // fails here, on the first statement. The handle still counts as open after a failed
  // statement and Windows then refuses to move the file (EBUSY), so it is closed on the
  // way out: that is what lets the caller put the damaged file aside.
  try {
    // Before the first statement: two processes opening a new database at the same instant
    // both create the schema, and without a timeout the loser's very first statement fails
    // with "database is locked" - which must not be mistaken for a damaged file.
    opened.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    opened.exec(SCHEMA);
    opened.exec(SOAK_SCHEMA);
    tuneForConcurrentWriters(opened);
  } catch (err) {
    try {
      opened.close();
    } catch {
      /* already closed */
    }
    throw err;
  }
  return opened;
}

/**
 * Open the history database, and never let a damaged one stop the app from starting. Every
 * surface imports this module, so anything thrown here would take the terminal UI, the GUI
 * and the web UI down together before they could say a word.
 *
 * A file that is not a database is moved aside (the history in it is kept, not deleted) and
 * an empty one takes its place; the problem is then reported through dbStatus(). If even that
 * fails - the file is locked, or the folder is not writable - history for this run lives in
 * memory only, which is a working app with an honest warning rather than a crash.
 */
function openDatabase() {
  try {
    return { db: openAt(DB_FILE), problem: null };
  } catch (err) {
    // A database another process is writing at start-up is not a damaged one. Wait for it, and
    // if it is still busy leave the file exactly where it is: moving a healthy database aside
    // because a second instance was mid-write would lose the history instead of sharing it.
    if (isBusy(err)) {
      for (let attempt = 0; attempt < WRITE_RETRIES; attempt += 1) {
        Atomics.wait(sleepCell, 0, 0, 100 * (attempt + 1));
        try {
          return { db: openAt(DB_FILE), problem: null };
        } catch (retryErr) {
          err = retryErr;
          if (!isBusy(err)) break;
        }
      }
      if (isBusy(err)) {
        const memory = new DatabaseSync(":memory:");
        memory.exec(SCHEMA);
        memory.exec(SOAK_SCHEMA);
        tuneForConcurrentWriters(memory);
        return {
          db: memory,
          problem: {
            file: DB_FILE,
            detail: "is being written by another PingLab process",
            copy: null,
            message: `${DB_FILE} is locked by another PingLab process, so its history could not be opened. This run keeps history in memory only; the file was not moved or changed.`,
          },
        };
      }
    }
    const detail = String(err?.message || err).split("\n")[0].trim() || "could not be read";
    const kept = keepUnreadableAside(DB_FILE, { suffix: ".sqlite", mode: "move" });
    const where = kept.ok
      ? `A copy was kept as ${kept.path}, so its history is not lost.`
      : `A copy could not be made either (${kept.error}), so the file was left in place.`;
    let db;
    let note;
    try {
      db = openAt(DB_FILE);
      note = "A new, empty database was started.";
    } catch {
      db = new DatabaseSync(":memory:");
      db.exec(SCHEMA);
      db.exec(SOAK_SCHEMA);
      tuneForConcurrentWriters(db);
      note = "A new database could not be started here, so this run keeps history in memory only.";
    }
    return {
      db,
      problem: {
        file: DB_FILE,
        detail,
        copy: kept.path,
        message: `${DB_FILE} ${detail}, so its history could not be read. ${where} ${note}`,
      },
    };
  }
}

const opened = openDatabase();
const db = opened.db;

/** Whether the history database is usable, for every surface that reports it. */
export function dbStatus() {
  return opened.problem ? { ok: false, problem: opened.problem } : { ok: true, problem: null };
}

const now = () => new Date().toISOString();

export function saveRun(kind, summary, data) {
  const info = writeWithRetry(() =>
    db.prepare("INSERT INTO runs (kind, created_at, summary, data) VALUES (?, ?, ?, ?)").run(kind, now(), summary ?? null, JSON.stringify(data)),
  );
  return Number(info.lastInsertRowid);
}

export function listRuns(kind = null, limit = 30) {
  const rows = kind
    ? db.prepare("SELECT id, kind, created_at, summary, data FROM runs WHERE kind = ? ORDER BY id DESC LIMIT ?").all(kind, limit)
    : db.prepare("SELECT id, kind, created_at, summary, data FROM runs ORDER BY id DESC LIMIT ?").all(limit);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    createdAt: r.created_at,
    summary: r.summary,
    data: safeParse(r.data),
  }));
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** One stored run by id, for a later action that refers back to it (a rollback, a review). */
export function getRun(id) {
  const row = db.prepare("SELECT id, kind, created_at, summary, data FROM runs WHERE id = ?").get(Number(id));
  return row
    ? { id: row.id, kind: row.kind, createdAt: row.created_at, summary: row.summary, data: safeParse(row.data) }
    : null;
}

export function saveTweak(action, detail) {
  const info = writeWithRetry(() =>
    db
      .prepare("INSERT INTO tweaks (action, detail, applied_at) VALUES (?, ?, ?)")
      .run(action, detail ? JSON.stringify(detail) : null, now()),
  );
  return Number(info.lastInsertRowid);
}

export function listTweaks(limit = 30) {
  return db
    .prepare("SELECT id, action, detail, applied_at, undone_at FROM tweaks ORDER BY id DESC LIMIT ?")
    .all(limit)
    .map((r) => ({
      id: r.id,
      action: r.action,
      detail: safeParse(r.detail),
      appliedAt: r.applied_at,
      undoneAt: r.undone_at,
    }));
}

/** Previous run of a kind, useful for before/after comparisons. */
export function previousRun(kind) {
  const rows = db.prepare("SELECT id, created_at, summary, data FROM runs WHERE kind = ? ORDER BY id DESC LIMIT 2").all(kind);
  if (rows.length < 2) return null;
  return { id: rows[1].id, createdAt: rows[1].created_at, summary: rows[1].summary, data: safeParse(rows[1].data) };
}

/* ---------------------------------------------------------------- soak tests */

let insertSampleStmt = null;

export function createSoakRun({ seconds, intervalMs, targets, label }) {
  const info = writeWithRetry(() =>
    db
      .prepare("INSERT INTO soak_runs (started_at, seconds, interval_ms, config) VALUES (?, ?, ?, ?)")
      .run(now(), seconds, intervalMs, JSON.stringify({ targets, label: label ?? null })),
  );
  return Number(info.lastInsertRowid);
}

export function insertSoakSample(runId, ts, target, ms, ok) {
  if (!insertSampleStmt) {
    insertSampleStmt = db.prepare("INSERT INTO soak_samples (run_id, ts, target, ms, ok) VALUES (?, ?, ?, ?, ?)");
  }
  writeWithRetry(() => insertSampleStmt.run(runId, ts, target, ms === null || ms === undefined ? null : ms, ok ? 1 : 0));
}

export function finishSoakRun(runId, summary) {
  writeWithRetry(() => db.prepare("UPDATE soak_runs SET ended_at = ?, summary = ? WHERE id = ?").run(now(), JSON.stringify(summary ?? null), runId));
}

export function getSoakSamples(runId) {
  return db
    .prepare("SELECT ts, target, ms, ok FROM soak_samples WHERE run_id = ? ORDER BY ts ASC")
    .all(runId)
    .map((r) => ({ ts: r.ts, target: r.target, ms: r.ms, ok: r.ok === 1 }));
}

export function getSoakRun(runId) {
  const row = db
    .prepare("SELECT id, started_at, ended_at, seconds, interval_ms, config, summary FROM soak_runs WHERE id = ?")
    .get(runId);
  if (!row) return null;
  return {
    id: row.id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    seconds: row.seconds,
    intervalMs: row.interval_ms,
    config: safeParse(row.config),
    summary: safeParse(row.summary),
  };
}

export function listSoakRuns(limit = 10) {
  return db
    .prepare("SELECT id, started_at, ended_at, seconds, interval_ms, config, summary FROM soak_runs ORDER BY id DESC LIMIT ?")
    .all(limit)
    .map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      seconds: r.seconds,
      intervalMs: r.interval_ms,
      config: safeParse(r.config),
      summary: safeParse(r.summary),
    }));
}
